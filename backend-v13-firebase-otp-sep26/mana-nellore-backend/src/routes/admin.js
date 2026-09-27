// Admin / operations portal. Full platform visibility; every mutating
// action writes an audit log entry.
const express = require('express');
const db = require('../db');
const { authenticate, requireRole, ah } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

// Per-session staff name: multiple staff may share one admin login, so every
// mutating action records WHO did it. The admin app sends x-staff-name.
async function audit(req, action, entity, entityId, meta) {
  const staffName = req.headers['x-staff-name'] || req.body._staff_name || null;
  await db.query(
    'INSERT INTO audit_logs (admin_id, staff_name, action, entity, entity_id, meta) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
    [req.user.id, staffName, action, entity || null, entityId || null, JSON.stringify(meta || {})]
  );
}

async function notify(userId, title, body) {
  await db.query('INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)', [
    userId, title, body
  ]);
}

async function transition(orderId, status, by) {
  const { rows } = await db.query('SELECT timeline FROM orders WHERE id = $1', [orderId]);
  const timeline = rows[0].timeline || [];
  timeline.push({ status, at: new Date().toISOString(), by });
  await db.query('UPDATE orders SET status = $1, timeline = $2::jsonb WHERE id = $3', [
    status, JSON.stringify(timeline), orderId
  ]);
}

const ACTIVE_STATUSES = ['placed', 'accepted', 'preparing', 'ready', 'picked_up', 'on_way'];

// GET /api/admin/dashboard
router.get(
  '/dashboard',
  ah(async (req, res) => {
    // "Today" in IST (Asia/Kolkata), since the business operates in India
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    istNow.setUTCHours(0, 0, 0, 0);
    const iso = new Date(istNow.getTime() - istOffsetMs).toISOString();

    const q = async (text, params = []) => (await db.query(text, params)).rows[0];

    const ordersToday = await q(
      "SELECT COUNT(*) AS c FROM orders WHERE placed_at >= $1", [iso]);
    const salesToday = await q(
      "SELECT COALESCE(SUM(total_paise),0) AS s FROM orders WHERE placed_at >= $1 AND status != 'cancelled'", [iso]);
    const activeOrders = await q(
      `SELECT COUNT(*) AS c FROM orders WHERE status = ANY($1)`, [ACTIVE_STATUSES]);
    const onlineRiders = await q(
      "SELECT COUNT(*) AS c FROM riders WHERE online = true AND status = 'approved'");
    const cancellationsToday = await q(
      "SELECT COUNT(*) AS c FROM orders WHERE placed_at >= $1 AND status = 'cancelled'", [iso]);
    const refundsToday = await q(
      "SELECT COUNT(*) AS c, COALESCE(SUM(total_paise),0) AS s FROM orders WHERE placed_at >= $1 AND payment_status = 'refunded'", [iso]);
    const openTickets = await q(
      "SELECT COUNT(*) AS c FROM support_tickets WHERE status IN ('open','in_progress')");
    const contribution = await q(
      `SELECT COALESCE(SUM(o.platform_fee_paise + o.commission_paise - COALESCE(rp.amount_paise, 0)), 0) AS s
       FROM orders o LEFT JOIN rider_payouts rp ON rp.order_id = o.id
       WHERE o.status = 'delivered' AND o.placed_at >= $1`, [iso]);
    const counts = await q(
      `SELECT
         (SELECT COUNT(*) FROM restaurants WHERE status = 'approved') AS restaurants,
         (SELECT COUNT(*) FROM riders WHERE status = 'approved') AS riders,
         (SELECT COUNT(DISTINCT customer_id) FROM orders) AS customers`);

    res.json({
      orders_today: Number(ordersToday.c),
      sales_today_paise: Number(salesToday.s),
      active_orders: Number(activeOrders.c),
      online_riders: Number(onlineRiders.c),
      cancellations_today: Number(cancellationsToday.c),
      refunds_today: { count: Number(refundsToday.c), total_paise: Number(refundsToday.s) },
      open_tickets: Number(openTickets.c),
      contribution_today_paise: Number(contribution.s),
      ...Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, Number(v)]))
    });
  })
);

// ---- Restaurants ----
router.get(
  '/alerts',
  ah(async (req, res) => {
    const q = async (text, params = []) => Number((await db.query(text, params)).rows[0].c);
    // IST start of today for "today" counts
    const now = new Date();
    const istOffsetMs = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffsetMs);
    istNow.setUTCHours(0, 0, 0, 0);
    const todayIso = new Date(istNow.getTime() - istOffsetMs).toISOString();
    const [newOrders, pendingRestaurants, pendingRiders, openTickets, pendingRefunds] = await Promise.all([
      q("SELECT COUNT(*) AS c FROM orders WHERE status IN ('placed','accepted')"),
      q("SELECT COUNT(*) AS c FROM restaurants WHERE status = 'pending'"),
      q("SELECT COUNT(*) AS c FROM riders WHERE status = 'pending'"),
      q("SELECT COUNT(*) AS c FROM support_tickets WHERE status IN ('open','in_progress')"),
      q("SELECT COUNT(*) AS c FROM orders WHERE payment_status = 'refunded' AND placed_at >= $1", [todayIso])
    ]);
    const openSos = await q("SELECT COUNT(*) AS c FROM sos_alerts WHERE status = 'open'");
    res.json({ newOrders, pendingRestaurants, pendingRiders, openTickets, pendingRefunds, openSos });
  })
);

router.get(
  '/restaurants',
  ah(async (req, res) => {
    const params = [];
    let where = '';
    if (req.query.status) {
      params.push(req.query.status);
      where = `WHERE r.status = $${params.length}`;
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where += `${where ? ' AND' : 'WHERE'} r.name ILIKE $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT r.*, u.name AS owner_name, u.phone AS owner_phone,
              (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id) AS total_orders
       FROM restaurants r LEFT JOIN users u ON u.id = r.owner_id
       ${where} ORDER BY r.created_at DESC`,
      params
    );
    res.json({ restaurants: rows });
  })
);

router.get(
  '/restaurants/:id',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT r.*, u.name AS owner_name, u.phone AS owner_phone,
              (SELECT COUNT(*) FROM orders o WHERE o.restaurant_id = r.id) AS total_orders,
              (SELECT COUNT(*) FROM categories c WHERE c.restaurant_id = r.id) AS category_count,
              (SELECT COUNT(*) FROM menu_items m WHERE m.restaurant_id = r.id) AS item_count
       FROM restaurants r
       LEFT JOIN users u ON u.id = r.owner_id WHERE r.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Restaurant not found' });
    res.json({ restaurant: { ...rows[0], rating_avg: Number(rows[0].rating_avg) } });
  })
);

// PUT /api/admin/restaurants/:id/status { status: approved|suspended|rejected|pending }
router.put(
  '/restaurants/:id/status',
  ah(async (req, res) => {
    const { status } = req.body;
    if (!['approved', 'suspended', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const { rows } = await db.query(
      'UPDATE restaurants SET status = $1 WHERE id = $2 RETURNING *', [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Restaurant not found' });
    await audit(req, `restaurant_${status}`, 'restaurant', req.params.id, {});
    if (rows[0].owner_id) {
      await notify(rows[0].owner_id, 'Restaurant status update',
        `Your restaurant "${rows[0].name}" is now ${status}.`);
    }
    res.json({ restaurant: rows[0] });
  })
);

// ---- Riders ----
router.get(
  '/riders',
  ah(async (req, res) => {
    const params = [];
    let where = '';
    if (req.query.status) {
      params.push(req.query.status);
      where = `WHERE rd.status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT rd.*, u.name, u.phone,
              (SELECT COUNT(*) FROM orders o WHERE o.rider_id = rd.id) AS total_deliveries
       FROM riders rd JOIN users u ON u.id = rd.user_id
       ${where} ORDER BY rd.created_at DESC`,
      params
    );
    res.json({ riders: rows.map((r) => ({ ...r, rating_avg: Number(r.rating_avg) })) });
  })
);

router.put(
  '/riders/:id/status',
  ah(async (req, res) => {
    const { status } = req.body;
    if (!['approved', 'suspended', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const { rows } = await db.query(
      'UPDATE riders SET status = $1 WHERE id = $2 RETURNING *', [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Rider not found' });
    await audit(req, `rider_${status}`, 'rider', req.params.id, {});
    await notify(rows[0].user_id, 'Rider account update', `Your rider account is now ${status}.`);
    res.json({ rider: rows[0] });
  })
);

// ---- Orders ----
router.get(
  '/orders',
  ah(async (req, res) => {
    const params = [];
    const conds = [];
    if (req.query.status) {
      params.push(req.query.status);
      conds.push(`o.status = $${params.length}`);
    }
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      conds.push(`r.name ILIKE $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT o.id, o.status, o.total_paise, o.payment_method, o.payment_status, o.placed_at,
              o.order_type, r.name AS restaurant_name
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       ${where} ORDER BY o.placed_at DESC LIMIT 100`,
      params
    );
    res.json({ orders: rows });
  })
);

router.get(
  '/orders/:id',
  ah(async (req, res) => {
    const { rows } = await db.query(
      // No customer address: admin sees order + restaurant + rider context only.
      `SELECT o.id, o.status, o.subtotal_paise, o.discount_paise, o.delivery_fee_paise,
              o.platform_fee_paise, o.tax_paise, o.total_paise, o.payment_method,
              o.payment_status, o.order_type, o.tip_paise, o.no_cutlery, o.delivery_note,
              o.packed_at, o.placed_at, o.delivered_at, o.eta_at, o.timeline,
              r.name AS restaurant_name,
              ru.name AS rider_name, ru.phone AS rider_phone
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN riders rd ON rd.id = o.rider_id
       LEFT JOIN users ru ON ru.id = rd.user_id
       WHERE o.id = $1`,
      [req.params.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    delete order.delivery_otp_hash;
    const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    res.json({ order: { ...order, items: items.rows } });
  })
);

// POST /api/admin/orders/:id/assign-rider { rider_id } — live ops intervention
router.post(
  '/orders/:id/assign-rider',
  ah(async (req, res) => {
    const { rider_id } = req.body;
    const oRes = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    const order = oRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const rRes = await db.query("SELECT * FROM riders WHERE id = $1 AND status = 'approved'", [rider_id]);
    if (!rRes.rows[0]) return res.status(400).json({ error: 'Rider not available' });
    await db.query('UPDATE orders SET rider_id = $1 WHERE id = $2', [rider_id, order.id]);
    const timeline = order.timeline || [];
    timeline.push({ status: 'rider_assigned', at: new Date().toISOString(), by: 'admin' });
    await db.query('UPDATE orders SET timeline = $1::jsonb WHERE id = $2', [
      JSON.stringify(timeline), order.id
    ]);
    await audit(req, 'assign_rider', 'order', order.id, { rider_id });
    await notify(rRes.rows[0].user_id, 'Delivery assigned',
      `Order from ${order.id.slice(0, 8)} was assigned to you by operations.`);
    res.json({ ok: true });
  })
);

// POST /api/admin/orders/:id/cancel { reason } — live ops intervention
router.post(
  '/orders/:id/cancel',
  ah(async (req, res) => {
    const oRes = await db.query('SELECT * FROM orders WHERE id = $1', [req.params.id]);
    const order = oRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (['delivered', 'cancelled'].includes(order.status)) {
      return res.status(409).json({ error: `Order already ${order.status}` });
    }
    await transition(order.id, 'cancelled', 'admin');
    const refunded = order.payment_status === 'paid';
    await db.query(
      'UPDATE orders SET cancel_reason = $1, payment_status = $2 WHERE id = $3',
      [req.body.reason || 'Cancelled by operations', refunded ? 'refunded' : order.payment_status, order.id]
    );
    await audit(req, 'cancel_order', 'order', order.id, { reason: req.body.reason });
    await notify(order.customer_id, 'Order cancelled',
      `Your order was cancelled by operations.${refunded ? ' Your payment will be refunded.' : ''}`);
    res.json({ ok: true, refunded });
  })
);

// ---- Pricing ----
router.get(
  '/pricing',
  ah(async (req, res) => {
    const { rows } = await db.query('SELECT key, value FROM pricing_config ORDER BY key');
    res.json({ pricing: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
  })
);

// PUT /api/admin/pricing { key, value } — changes apply to new orders instantly
router.put(
  '/pricing',
  ah(async (req, res) => {
    const { key, value } = req.body;
    const allowed = ['delivery_tiers', 'rider_payout_tiers', 'platform_fee_paise', 'default_commission_pct', 'free_delivery_rules', 'eta_minutes', 'call_to_order_phone'];
    if (!allowed.includes(key)) return res.status(400).json({ error: 'Unknown pricing key' });
    const { rows } = await db.query(
      'UPDATE pricing_config SET value = $1::jsonb WHERE key = $2 RETURNING *',
      [JSON.stringify(value), key]
    );
    await audit(req, 'pricing_update', 'pricing_config', key, { value });
    res.json({ pricing: rows[0] });
  })
);

// ---- Coupons ----
router.get(
  '/coupons',
  ah(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM coupons ORDER BY created_at DESC');
    res.json({ coupons: rows });
  })
);

router.post(
  '/coupons',
  ah(async (req, res) => {
    const { code, discount_type, value, min_order_paise, max_discount_paise, valid_from, valid_to, active, requires_student } = req.body;
    if (!code || !discount_type || value == null) {
      return res.status(400).json({ error: 'code, discount_type and value are required' });
    }
    if (!['flat', 'percent'].includes(discount_type)) {
      return res.status(400).json({ error: 'discount_type must be flat or percent' });
    }
    const { rows } = await db.query(
      `INSERT INTO coupons (code, discount_type, value, min_order_paise, max_discount_paise, valid_from, valid_to, active, requires_student)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [String(code).toUpperCase(), discount_type, Math.round(Number(value)),
       min_order_paise || 0, max_discount_paise != null ? Math.round(Number(max_discount_paise)) : null,
       valid_from || null, valid_to || null, active !== false, !!requires_student]
    );
    await audit(req, 'coupon_create', 'coupon', rows[0].id, { code });
    res.status(201).json({ coupon: rows[0] });
  })
);

router.put(
  '/coupons/:id',
  ah(async (req, res) => {
    const fields = ['discount_type', 'value', 'min_order_paise', 'max_discount_paise', 'valid_from', 'valid_to', 'active', 'requires_student'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(req.body[f]);
        sets.push(`${f} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE coupons SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!rows[0]) return res.status(404).json({ error: 'Coupon not found' });
    await audit(req, 'coupon_update', 'coupon', req.params.id, req.body);
    res.json({ coupon: rows[0] });
  })
);

router.delete(
  '/coupons/:id',
  ah(async (req, res) => {
    await db.query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
    await audit(req, 'coupon_delete', 'coupon', req.params.id, {});
    res.json({ ok: true });
  })
);

// ---- Settlements ----
router.get(
  '/settlements',
  ah(async (req, res) => {
    const params = [];
    let where = '';
    if (req.query.restaurant_id) {
      params.push(req.query.restaurant_id);
      where = `WHERE s.restaurant_id = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT s.*, r.name AS restaurant_name FROM settlements s
       JOIN restaurants r ON r.id = s.restaurant_id
       ${where} ORDER BY s.period_start DESC`,
      params
    );
    res.json({ settlements: rows });
  })
);

// POST /api/admin/settlements { restaurant_id, period_start, period_end }
router.post(
  '/settlements',
  ah(async (req, res) => {
    const { restaurant_id, period_start, period_end } = req.body;
    if (!restaurant_id || !period_start || !period_end) {
      return res.status(400).json({ error: 'restaurant_id, period_start and period_end are required' });
    }
    const agg = await db.query(
      `SELECT COALESCE(SUM(total_paise),0) AS gross,
              COALESCE(SUM(commission_paise),0) AS commission,
              COALESCE(SUM(CASE WHEN payment_status='refunded' THEN total_paise ELSE 0 END),0) AS refunds
       FROM orders
       WHERE restaurant_id = $1 AND status = 'delivered'
         AND placed_at::date BETWEEN $2 AND $3`,
      [restaurant_id, period_start, period_end]
    );
    const gross = Number(agg.rows[0].gross);
    const commission = Number(agg.rows[0].commission);
    const refunds = Number(agg.rows[0].refunds);
    const net = gross - commission - refunds;
    const { rows } = await db.query(
      `INSERT INTO settlements (restaurant_id, period_start, period_end, gross_paise, commission_paise, refunds_paise, net_paise)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [restaurant_id, period_start, period_end, gross, commission, refunds, net]
    );
    await audit(req, 'settlement_create', 'settlement', rows[0].id, { restaurant_id, period_start, period_end });
    res.status(201).json({ settlement: rows[0] });
  })
);

router.post(
  '/settlements/:id/pay',
  ah(async (req, res) => {
    const { rows } = await db.query(
      "UPDATE settlements SET status = 'paid', paid_at = now() WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Settlement not found' });
    await audit(req, 'settlement_paid', 'settlement', req.params.id, {});
    res.json({ settlement: rows[0] });
  })
);

// ---- Refunds ----
router.get(
  '/refunds/history',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT o.id, o.total_paise, o.payment_status, o.placed_at, o.customer_id,
              u.phone AS customer_phone, u.name AS customer_name,
              r.name AS restaurant_name
       FROM orders o
       LEFT JOIN users u ON u.id = o.customer_id
       LEFT JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.payment_status = 'refunded'
       ORDER BY o.placed_at DESC LIMIT 100`
    );
    res.json({ refunds: rows });
  })
);

router.post(
  '/refunds',
  ah(async (req, res) => {
    const { order_id, reason } = req.body;
    const oRes = await db.query('SELECT * FROM orders WHERE id = $1', [order_id]);
    const order = oRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status !== 'paid') {
      return res.status(409).json({ error: `Cannot refund an order with payment status ${order.payment_status}` });
    }
    await db.query("UPDATE orders SET payment_status = 'refunded' WHERE id = $1", [order.id]);
    const tl = (await db.query('SELECT timeline FROM orders WHERE id = $1', [order.id])).rows[0].timeline || [];
    tl.push({ status: 'refunded', at: new Date().toISOString(), by: 'admin' });
    await db.query('UPDATE orders SET timeline = $1::jsonb WHERE id = $2', [JSON.stringify(tl), order.id]);
    await audit(req, 'refund', 'order', order.id, { reason, amount_paise: order.total_paise });
    await notify(order.customer_id, 'Refund issued',
      `Rs ${(order.total_paise / 100).toFixed(2)} has been refunded for your order.`);
    res.json({ ok: true, refunded_paise: order.total_paise });
  })
);

// ---- Support tickets ----
router.get(
  '/tickets',
  ah(async (req, res) => {
    const params = [];
    const conds = [];
    if (req.query.status) {
      params.push(req.query.status);
      conds.push(`t.status = $${params.length}`);
    }
    if (req.query.category) {
      params.push(req.query.category);
      conds.push(`t.category = $${params.length}`);
    }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await db.query(
      // No customer PII in admin: ticket list shows no names or phone numbers.
      // (Ticket detail shows the customer's orders as transaction context.)
      `SELECT t.* FROM support_tickets t
       ${where} ORDER BY t.created_at DESC LIMIT 100`,
      params
    );
    res.json({ tickets: rows });
  })
);

router.put(
  '/tickets/:id',
  ah(async (req, res) => {
    const { status, resolution_note } = req.body;
    if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    // Closing a ticket REQUIRES a resolution note explaining refunded / not refunded.
    if ((status === 'resolved' || status === 'closed') && !(resolution_note || '').trim()) {
      return res.status(400).json({ error: 'A resolution note is required to close a ticket (refunded or not, and why)' });
    }
    const { rows } = await db.query(
      `UPDATE support_tickets SET status = $1,
         resolution_note = COALESCE($2, resolution_note)
       WHERE id = $3 RETURNING *`,
      [status, (resolution_note || '').trim() || null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    await audit(req, 'ticket_update', 'support_ticket', req.params.id, { status });
    if (status === 'resolved' || status === 'closed') {
      await notify(rows[0].user_id, 'Support ticket resolved ✅',
        `Resolution: ${rows[0].resolution_note}`);
    }
    res.json({ ticket: rows[0] });
  })
);

// POST /api/admin/tickets/:id/resolve-action { action: 'refund'|'reorder', resolution_note }
// "Food never arrived" unhappy path: admin picks refund or fresh reorder.
// Resolution note is required (same rule as closing a ticket).
router.post(
  '/tickets/:id/resolve-action',
  ah(async (req, res) => {
    const { action, resolution_note } = req.body;
    if (!['refund', 'reorder'].includes(action)) {
      return res.status(400).json({ error: 'Action must be refund or reorder' });
    }
    if (!(resolution_note || '').trim()) {
      return res.status(400).json({ error: 'A resolution note is required' });
    }
    const t = await db.query('SELECT * FROM support_tickets WHERE id = $1', [req.params.id]);
    const ticket = t.rows[0];
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    if (!ticket.order_id) return res.status(400).json({ error: 'Ticket has no order attached' });
    const o = await db.query('SELECT * FROM orders WHERE id = $1', [ticket.order_id]);
    const order = o.rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    let note = (resolution_note || '').trim();
    if (action === 'refund') {
      if (!['paid', 'collected'].includes(order.payment_status)) {
        return res.status(409).json({ error: `Order payment is '${order.payment_status}' — nothing to refund` });
      }
      await db.query("UPDATE orders SET payment_status = 'refunded' WHERE id = $1", [order.id]);
      note = `Refunded Rs ${(order.total_paise / 100).toFixed(2)}. ${note}`;
      await notify(order.customer_id, 'Refund issued 💸',
        `Rs ${(order.total_paise / 100).toFixed(2)} has been refunded for your order. ${note}`);
    } else {
      // Reorder: clone the order fresh (no discount carried over) and let the
      // restaurant + rider flow pick it up as a new 'placed' order.
      const { rows } = await db.query(
        `INSERT INTO orders (customer_id, restaurant_id, address_id, order_type, table_id,
            subtotal_paise, delivery_fee_paise, platform_fee_paise, tax_paise, tip_paise,
            total_paise, payment_method, delivery_note, no_cutlery,
            recipient_name, recipient_phone)
         SELECT customer_id, restaurant_id, address_id, order_type, table_id,
            subtotal_paise, delivery_fee_paise, platform_fee_paise, tax_paise, tip_paise,
            (subtotal_paise + delivery_fee_paise + platform_fee_paise + tax_paise + tip_paise),
            payment_method, delivery_note, no_cutlery,
            recipient_name, recipient_phone
         FROM orders WHERE id = $1 RETURNING id`,
        [order.id]
      );
      const newId = rows[0].id;
      await db.query(
        `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, unit_price_paise, qty, instructions)
         SELECT $1, menu_item_id, name_snapshot, unit_price_paise, qty, instructions
         FROM order_items WHERE order_id = $2`,
        [newId, order.id]
      );
      note = `Fresh reorder placed for you. ${note}`;
      await notify(order.customer_id, 'Your reorder is on its way 🍱',
        `We've placed a fresh order for you at no extra charge. ${note}`);
    }
    await db.query(
      `UPDATE support_tickets SET status = 'resolved', resolution_note = $1 WHERE id = $2`,
      [note, ticket.id]
    );
    await audit(req, 'ticket_resolve_action', 'support_ticket', ticket.id, { action });
    res.json({ ok: true, action });
  })
);

// GET /api/admin/tickets/:id — ticket + the customer's orders as transaction context (no customer PII)
router.get(
  '/tickets/:id',
  ah(async (req, res) => {
    const t = await db.query('SELECT * FROM support_tickets WHERE id = $1', [req.params.id]);
    if (!t.rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    const ticket = t.rows[0];
    const orders = await db.query(
      `SELECT o.id, o.status, o.total_paise, o.payment_status, o.placed_at,
              r.name AS restaurant_name
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.customer_id = $1 ORDER BY o.placed_at DESC LIMIT 20`,
      [ticket.user_id]
    );
    res.json({ ticket, customer_orders: orders.rows });
  })
);

// ---- Reports ----
router.get(
  '/reports/summary',
  ah(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 864e5);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    // A date-only "to" parses as midnight; extend to end of day so the whole day is included
    to.setHours(23, 59, 59, 999);
    const f = from.toISOString();
    const t = to.toISOString();

    const totals = await db.query(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total_paise),0) AS sales,
              COALESCE(AVG(total_paise),0) AS avg_order
       FROM orders WHERE placed_at BETWEEN $1 AND $2 AND status != 'cancelled'`,
      [f, t]
    );
    const byDay = await db.query(
      `SELECT placed_at::date AS day, COUNT(*) AS orders, COALESCE(SUM(total_paise),0) AS sales
       FROM orders WHERE placed_at BETWEEN $1 AND $2 AND status != 'cancelled'
       GROUP BY day ORDER BY day`,
      [f, t]
    );
    const topRestaurants = await db.query(
      `SELECT r.name, COUNT(o.id) AS orders, COALESCE(SUM(o.total_paise),0) AS sales
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.placed_at BETWEEN $1 AND $2 AND o.status != 'cancelled'
       GROUP BY r.name ORDER BY sales DESC LIMIT 10`,
      [f, t]
    );
    const byStatus = await db.query(
      `SELECT status, COUNT(*) AS orders FROM orders
       WHERE placed_at BETWEEN $1 AND $2 GROUP BY status`,
      [f, t]
    );
    res.json({
      totals: {
        orders: Number(totals.rows[0].orders),
        sales_paise: Number(totals.rows[0].sales),
        avg_order_paise: Math.round(Number(totals.rows[0].avg_order))
      },
      by_day: byDay.rows,
      top_restaurants: topRestaurants.rows,
      by_status: byStatus.rows
    });
  })
);

// ---- Restaurant sales report ----
router.get(
  '/reports/restaurant-sales',
  ah(async (req, res) => {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 864e5);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    to.setHours(23, 59, 59, 999);
    const f = from.toISOString();
    const t = to.toISOString();
    const { rows } = await db.query(
      `SELECT r.id, r.name, r.status,
              COUNT(o.id) AS orders,
              COALESCE(SUM(o.total_paise), 0) AS sales_paise,
              COALESCE(AVG(o.total_paise), 0) AS avg_order_paise
       FROM restaurants r
       LEFT JOIN orders o ON o.restaurant_id = r.id
         AND o.placed_at BETWEEN $1 AND $2
         AND o.status != 'cancelled'
       GROUP BY r.id, r.name, r.status
       ORDER BY sales_paise DESC, r.name ASC`,
      [f, t]
    );
    const list = rows.map(x => ({
      id: x.id,
      name: x.name,
      status: x.status,
      orders: Number(x.orders),
      sales_paise: Number(x.sales_paise),
      avg_order_paise: Math.round(Number(x.avg_order_paise))
    }));
    res.json({ restaurants: list });
  })
);

// ---- SOS alerts ----
// GET /api/admin/sos-alerts — open/acknowledged rider SOS alerts, newest first
router.get(
  '/sos-alerts',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT s.*, u.name AS rider_name, u.phone AS rider_phone
       FROM sos_alerts s
       JOIN riders r ON r.id = s.rider_id
       JOIN users u ON u.id = r.user_id
       WHERE s.status IN ('open','acknowledged')
       ORDER BY s.created_at DESC LIMIT 50`
    );
    res.json({ alerts: rows });
  })
);

// PUT /api/admin/sos-alerts/:id { status: 'acknowledged' | 'resolved' }
router.put(
  '/sos-alerts/:id',
  ah(async (req, res) => {
    const status = req.body.status;
    if (!['acknowledged', 'resolved'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const { rows } = await db.query(
      'UPDATE sos_alerts SET status = $1 WHERE id = $2 RETURNING id',
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'SOS alert not found' });
    await audit(req, 'sos_' + status, 'sos_alert', req.params.id, {});
    res.json({ ok: true });
  })
);

// ---- Quests ----
// GET /api/admin/quests — all quests, newest first
router.get(
  '/quests',
  ah(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM quests ORDER BY created_at DESC');
    res.json({ quests: rows });
  })
);

// POST /api/admin/quests { name, target_deliveries, bonus_paise, starts_at, ends_at, active? }
router.post(
  '/quests',
  ah(async (req, res) => {
    const b = req.body || {};
    if (!b.name || !b.target_deliveries || b.bonus_paise == null || !b.starts_at || !b.ends_at) {
      return res.status(400).json({ error: 'name, target_deliveries, bonus_paise, starts_at and ends_at are required' });
    }
    const { rows } = await db.query(
      `INSERT INTO quests (name, target_deliveries, bonus_paise, starts_at, ends_at, active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [b.name, b.target_deliveries, b.bonus_paise, b.starts_at, b.ends_at, b.active !== false]
    );
    await audit(req, 'quest_create', 'quest', rows[0].id, { name: b.name });
    res.json({ quest: rows[0] });
  })
);

// PUT /api/admin/quests/:id { name?, target_deliveries?, bonus_paise?, starts_at?, ends_at?, active? }
router.put(
  '/quests/:id',
  ah(async (req, res) => {
    const b = req.body || {};
    const fields = [];
    const vals = [];
    const allowed = ['name', 'target_deliveries', 'bonus_paise', 'starts_at', 'ends_at', 'active'];
    for (const k of allowed) {
      if (b[k] !== undefined) { fields.push(k + ' = $' + (vals.length + 1)); vals.push(b[k]); }
    }
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE quests SET ${fields.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Quest not found' });
    await audit(req, 'quest_update', 'quest', req.params.id, b);
    res.json({ quest: rows[0] });
  })
);

// DELETE /api/admin/quests/:id
router.delete(
  '/quests/:id',
  ah(async (req, res) => {
    const { rows } = await db.query('DELETE FROM quests WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Quest not found' });
    await audit(req, 'quest_delete', 'quest', req.params.id, {});
    res.json({ ok: true });
  })
);

router.get(
  '/audit-logs',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT al.*, u.name AS admin_name FROM audit_logs al
       LEFT JOIN users u ON u.id = al.admin_id
       ORDER BY al.created_at DESC LIMIT 100`
    );
    res.json({ logs: rows });
  })
);

// ---- Restaurant onboarding applications ----
router.get(
  '/applications',
  ah(async (req, res) => {
    const { rows } = await db.query(
      "SELECT * FROM restaurant_applications ORDER BY created_at DESC"
    );
    res.json({ applications: rows });
  })
);

// PUT /api/admin/applications/:id { status: approved|rejected, admin_note? }
// Approving creates the owner profile (separate role profile), the restaurant
// (verified=true), and notifies the applicant.
router.put(
  '/applications/:id',
  ah(async (req, res) => {
    const { status, admin_note } = req.body;
    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const aRes = await db.query('SELECT * FROM restaurant_applications WHERE id = $1', [req.params.id]);
    const app = aRes.rows[0];
    if (!app) return res.status(404).json({ error: 'Application not found' });
    if (app.status !== 'pending') return res.status(409).json({ error: `Application already ${app.status}` });

    await db.query('UPDATE restaurant_applications SET status = $1, admin_note = $2 WHERE id = $3',
      [status, admin_note || null, app.id]);

    if (status === 'approved') {
      // Find or create the owner's restaurant_owner profile (same phone, own profile)
      let uRes = await db.query(
        "SELECT * FROM users WHERE phone = $1 AND role = 'restaurant_owner'", [app.phone]
      );
      let owner = uRes.rows[0];
      if (!owner) {
        const c = await db.query(
          "INSERT INTO users (phone, name, role) VALUES ($1, $2, 'restaurant_owner') RETURNING *",
          [app.phone, app.owner_name]
        );
        owner = c.rows[0];
      }
      const rRes = await db.query(
        `INSERT INTO restaurants (owner_id, name, address, lat, lng, image_url, fssai, verified, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true,'approved') RETURNING *`,
        [owner.id, app.restaurant_name, app.address, app.lat, app.lng, app.photo_url, app.fssai]
      );
      await notify(owner.id, '🎉 Your restaurant is live!',
        `"${app.restaurant_name}" is verified and open for business on Mana Nellore!`);
      await audit(req, 'application_approved', 'restaurant', rRes.rows[0].id, { application_id: app.id });
    } else {
      await audit(req, 'application_rejected', 'restaurant_application', app.id, { admin_note });
    }
    res.json({ ok: true, status });
  })
);

// Restaurants missing a photo — chase list
router.get(
  '/restaurants-missing-photo',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT id, name, status FROM restaurants
       WHERE image_url IS NULL OR image_url = ''
       ORDER BY created_at DESC`
    );
    res.json({ restaurants: rows });
  })
);

// ---- Call-me-back requests ----
router.get(
  '/callbacks',
  ah(async (req, res) => {
    const { rows } = await db.query(
      // Phone only: the customer explicitly asked for a call back.
      // No name join — admin does not need customer identities here.
      `SELECT c.id, c.phone, c.order_id, c.reason, c.status, c.created_at
       FROM callback_requests c
       WHERE c.status = 'open' ORDER BY c.created_at ASC`
    );
    res.json({ callbacks: rows });
  })
);

router.put(
  '/callbacks/:id',
  ah(async (req, res) => {
    const { rows } = await db.query(
      "UPDATE callback_requests SET status = 'done' WHERE id = $1 RETURNING *", [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Callback not found' });
    await audit(req, 'callback_done', 'callback_request', req.params.id, {});
    await notify(rows[0].user_id, 'We called you back 📞',
      'Thanks for your patience — our team has closed your callback request.');
    res.json({ ok: true });
  })
);

// ---- Rider COD cash settlement ----
router.get(
  '/rider-cod',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT rd.id AS rider_id, u.name AS rider_name, u.phone AS rider_phone,
              COALESCE(SUM(l.amount_paise) FILTER (WHERE l.settled = false), 0) AS cash_in_hand_paise,
              COALESCE(SUM(p.amount_paise) FILTER (WHERE p.status = 'pending'), 0) AS pending_earnings_paise
       FROM riders rd
       JOIN users u ON u.id = rd.user_id
       LEFT JOIN rider_cod_ledger l ON l.rider_id = rd.id
       LEFT JOIN rider_payouts p ON p.rider_id = rd.id
       GROUP BY rd.id, u.name, u.phone
       HAVING COALESCE(SUM(l.amount_paise) FILTER (WHERE l.settled = false), 0) > 0
       ORDER BY cash_in_hand_paise DESC`
    );
    res.json({
      riders: rows.map((r) => ({
        rider_id: r.rider_id,
        rider_name: r.rider_name,
        rider_phone: r.rider_phone,
        cash_in_hand_paise: Number(r.cash_in_hand_paise),
        pending_earnings_paise: Number(r.pending_earnings_paise),
        owes_paise: Number(r.cash_in_hand_paise) - Number(r.pending_earnings_paise)
      }))
    });
  })
);

// POST /api/admin/rider-cod/:riderId/settle — mark all unsettled COD as settled (cash received)
router.post(
  '/rider-cod/:riderId/settle',
  ah(async (req, res) => {
    const r = await db.query(
      `UPDATE rider_cod_ledger SET settled = true, settled_at = now()
       WHERE rider_id = $1 AND settled = false RETURNING amount_paise`,
      [req.params.riderId]
    );
    const total = r.rows.reduce((a, x) => a + Number(x.amount_paise), 0);
    await audit(req, 'cod_settled', 'rider', req.params.riderId, { amount_paise: total });
    res.json({ ok: true, settled_paise: total, entries: r.rows.length });
  })
);

// ---- Student applications ----
router.get(
  '/student-applications',
  ah(async (req, res) => {
    const { rows } = await db.query(
      // No name/phone join: admin verifies the college ID photo only.
      `SELECT s.id, s.id_photo, s.college, s.status, s.created_at
       FROM student_applications s
       WHERE s.status = 'pending' ORDER BY s.created_at ASC`
    );
    res.json({ applications: rows });
  })
);

router.put(
  '/student-applications/:id',
  ah(async (req, res) => {
    const { status } = req.body;
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const { rows } = await db.query(
      'UPDATE student_applications SET status = $1 WHERE id = $2 RETURNING *', [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Application not found' });
    if (status === 'approved') {
      await db.query('UPDATE users SET is_student = true WHERE id = $1', [rows[0].user_id]);
      await notify(rows[0].user_id, '🎓 Student discount unlocked!',
        'Your student status is verified — look for the STUDENT10 coupon at checkout!');
    }
    await audit(req, 'student_' + status, 'student_application', req.params.id, {});
    res.json({ ok: true });
  })
);

// ---- Collections (Taste of Nellore, festival specials) ----
router.get(
  '/collections',
  ah(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM collections ORDER BY sort_order, name');
    for (const c of rows) {
      const rs = await db.query(
        `SELECT r.id, r.name FROM collection_restaurants cr
         JOIN restaurants r ON r.id = cr.restaurant_id WHERE cr.collection_id = $1`,
        [c.id]
      );
      c.restaurants = rs.rows;
    }
    res.json({ collections: rows });
  })
);

router.post(
  '/collections',
  ah(async (req, res) => {
    const { name, description, image_url, restaurant_ids, sort_order } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const { rows } = await db.query(
      `INSERT INTO collections (name, description, image_url, sort_order)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, description || null, image_url || null, sort_order || 0]
    );
    if (Array.isArray(restaurant_ids)) {
      for (const rid of restaurant_ids) {
        await db.query(
          'INSERT INTO collection_restaurants (collection_id, restaurant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [rows[0].id, rid]
        );
      }
    }
    await audit(req, 'collection_create', 'collection', rows[0].id, { name });
    res.status(201).json({ collection: rows[0] });
  })
);

router.put(
  '/collections/:id',
  ah(async (req, res) => {
    const { name, description, image_url, active, sort_order, restaurant_ids } = req.body;
    const { rows } = await db.query(
      `UPDATE collections SET name = COALESCE($1, name), description = COALESCE($2, description),
         image_url = COALESCE($3, image_url), active = COALESCE($4, active),
         sort_order = COALESCE($5, sort_order)
       WHERE id = $6 RETURNING *`,
      [name || null, description || null, image_url || null,
       active != null ? !!active : null, sort_order != null ? sort_order : null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Collection not found' });
    if (Array.isArray(restaurant_ids)) {
      await db.query('DELETE FROM collection_restaurants WHERE collection_id = $1', [req.params.id]);
      for (const rid of restaurant_ids) {
        await db.query(
          'INSERT INTO collection_restaurants (collection_id, restaurant_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
          [req.params.id, rid]
        );
      }
    }
    await audit(req, 'collection_update', 'collection', req.params.id, {});
    res.json({ collection: rows[0] });
  })
);

router.delete(
  '/collections/:id',
  ah(async (req, res) => {
    await db.query('DELETE FROM collections WHERE id = $1', [req.params.id]);
    await audit(req, 'collection_delete', 'collection', req.params.id, {});
    res.json({ ok: true });
  })
);

// ---- Verify a restaurant (✓ badge) ----
router.put(
  '/restaurants/:id/verify',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'UPDATE restaurants SET verified = $1 WHERE id = $2 RETURNING id, verified',
      [req.body.verified !== false, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Restaurant not found' });
    await audit(req, 'restaurant_verify', 'restaurant', req.params.id, { verified: rows[0].verified });
    res.json({ ok: true, verified: rows[0].verified });
  })
);

module.exports = router;module.exports = router;
