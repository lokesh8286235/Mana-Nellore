// Admin / operations portal. Full platform visibility; every mutating
// action writes an audit log entry.
const express = require('express');
const db = require('../db');
const { authenticate, requireRole, ah } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireRole('admin'));

async function audit(adminId, action, entity, entityId, meta) {
  await db.query(
    'INSERT INTO audit_logs (admin_id, action, entity, entity_id, meta) VALUES ($1,$2,$3,$4,$5::jsonb)',
    [adminId, action, entity || null, entityId || null, JSON.stringify(meta || {})]
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
    await audit(req.user.id, `restaurant_${status}`, 'restaurant', req.params.id, {});
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
    await audit(req.user.id, `rider_${status}`, 'rider', req.params.id, {});
    await notify(rows[0].user_id, 'Rider account update', `Your rider account is now ${status}.`);
    res.json({ rider: rows[0] });
  })
);

// ---- Customers ----
router.get(
  '/customers',
  ah(async (req, res) => {
    const params = [];
    let where = '';
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where = `WHERE (u.name ILIKE $${params.length} OR u.phone ILIKE $${params.length} OR o.customer_id::text ILIKE $${params.length})`;
    }
    // Customers are defined as distinct customer_ids with orders (matches dashboard count);
    // user profile data is joined when a matching users row exists.
    const { rows } = await db.query(
      `SELECT o.customer_id AS id, u.phone, u.name, MIN(o.placed_at) AS created_at,
              COUNT(*) AS total_orders,
              COALESCE(SUM(o.total_paise) FILTER (WHERE o.status != 'cancelled'), 0) AS lifetime_paise
       FROM orders o LEFT JOIN users u ON u.id = o.customer_id
       ${where}
       GROUP BY o.customer_id, u.phone, u.name
       ORDER BY created_at DESC LIMIT 100`,
      params
    );
    res.json({ customers: rows });
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
      conds.push(`(r.name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT o.id, o.status, o.total_paise, o.payment_status, o.placed_at,
              r.name AS restaurant_name, u.name AS customer_name, u.phone AS customer_phone
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       JOIN users u ON u.id = o.customer_id
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
      `SELECT o.*, r.name AS restaurant_name, u.name AS customer_name, u.phone AS customer_phone,
              a.line1, a.line2, a.city, ru.name AS rider_name, ru.phone AS rider_phone
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       JOIN users u ON u.id = o.customer_id
       LEFT JOIN addresses a ON a.id = o.address_id
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
    await audit(req.user.id, 'assign_rider', 'order', order.id, { rider_id });
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
    await audit(req.user.id, 'cancel_order', 'order', order.id, { reason: req.body.reason });
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
    const allowed = ['delivery_tiers', 'rider_payout_tiers', 'platform_fee_paise', 'default_commission_pct', 'free_delivery_rules', 'promise_minutes', 'apology_credit_paise'];
    if (!allowed.includes(key)) return res.status(400).json({ error: 'Unknown pricing key' });
    const { rows } = await db.query(
      'UPDATE pricing_config SET value = $1::jsonb WHERE key = $2 RETURNING *',
      [JSON.stringify(value), key]
    );
    await audit(req.user.id, 'pricing_update', 'pricing_config', key, { value });
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
    const { code, discount_type, value, min_order_paise, max_discount_paise, valid_from, valid_to, active } = req.body;
    if (!code || !discount_type || value == null) {
      return res.status(400).json({ error: 'code, discount_type and value are required' });
    }
    if (!['flat', 'percent'].includes(discount_type)) {
      return res.status(400).json({ error: 'discount_type must be flat or percent' });
    }
    const { rows } = await db.query(
      `INSERT INTO coupons (code, discount_type, value, min_order_paise, max_discount_paise, valid_from, valid_to, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [String(code).toUpperCase(), discount_type, Math.round(Number(value)),
       min_order_paise || 0, max_discount_paise != null ? Math.round(Number(max_discount_paise)) : null,
       valid_from || null, valid_to || null, active !== false]
    );
    await audit(req.user.id, 'coupon_create', 'coupon', rows[0].id, { code });
    res.status(201).json({ coupon: rows[0] });
  })
);

router.put(
  '/coupons/:id',
  ah(async (req, res) => {
    const fields = ['discount_type', 'value', 'min_order_paise', 'max_discount_paise', 'valid_from', 'valid_to', 'active'];
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
    await audit(req.user.id, 'coupon_update', 'coupon', req.params.id, req.body);
    res.json({ coupon: rows[0] });
  })
);

router.delete(
  '/coupons/:id',
  ah(async (req, res) => {
    await db.query('DELETE FROM coupons WHERE id = $1', [req.params.id]);
    await audit(req.user.id, 'coupon_delete', 'coupon', req.params.id, {});
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
    await audit(req.user.id, 'settlement_create', 'settlement', rows[0].id, { restaurant_id, period_start, period_end });
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
    await audit(req.user.id, 'settlement_paid', 'settlement', req.params.id, {});
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
    await audit(req.user.id, 'refund', 'order', order.id, { reason, amount_paise: order.total_paise });
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
      `SELECT t.*, u.name AS user_name, u.phone AS user_phone, u.role AS user_role
       FROM support_tickets t JOIN users u ON u.id = t.user_id
       ${where} ORDER BY t.created_at DESC LIMIT 100`,
      params
    );
    res.json({ tickets: rows });
  })
);

router.put(
  '/tickets/:id',
  ah(async (req, res) => {
    const { status } = req.body;
    if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const { rows } = await db.query(
      'UPDATE support_tickets SET status = $1 WHERE id = $2 RETURNING *',
      [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Ticket not found' });
    await audit(req.user.id, 'ticket_update', 'support_ticket', req.params.id, { status });
    res.json({ ticket: rows[0] });
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
    await audit(req.user.id, 'sos_' + status, 'sos_alert', req.params.id, {});
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
    await audit(req.user.id, 'quest_create', 'quest', rows[0].id, { name: b.name });
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
    await audit(req.user.id, 'quest_update', 'quest', req.params.id, b);
    res.json({ quest: rows[0] });
  })
);

// DELETE /api/admin/quests/:id
router.delete(
  '/quests/:id',
  ah(async (req, res) => {
    const { rows } = await db.query('DELETE FROM quests WHERE id = $1 RETURNING id', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Quest not found' });
    await audit(req.user.id, 'quest_delete', 'quest', req.params.id, {});
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

// ---- Delivery zones (per-zone promise time) ----
router.get(
  '/zones',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM zones ORDER BY is_default DESC, name ASC'
    );
    res.json({ zones: rows });
  })
);

router.post(
  '/zones',
  ah(async (req, res) => {
    const { name, promise_minutes } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Zone name is required' });
    }
    const mins = Number(promise_minutes);
    if (!mins || mins <= 0) {
      return res.status(400).json({ error: 'Promise minutes must be a positive number' });
    }
    const { rows } = await db.query(
      'INSERT INTO zones (name, promise_minutes) VALUES ($1, $2) RETURNING *',
      [String(name).trim(), mins]
    );
    res.status(201).json({ zone: rows[0] });
  })
);

router.put(
  '/zones/:id',
  ah(async (req, res) => {
    const { name, promise_minutes, is_default } = req.body;
    const mins = Number(promise_minutes);
    if (name != null && !String(name).trim()) {
      return res.status(400).json({ error: 'Zone name cannot be empty' });
    }
    if (promise_minutes != null && (!mins || mins <= 0)) {
      return res.status(400).json({ error: 'Promise minutes must be a positive number' });
    }
    // Only one default zone: setting one clears the others.
    if (is_default === true) {
      await db.query('UPDATE zones SET is_default = false');
    }
    const { rows } = await db.query(
      `UPDATE zones SET
         name = COALESCE($2, name),
         promise_minutes = COALESCE($3, promise_minutes),
         is_default = COALESCE($4, is_default)
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        name != null ? String(name).trim() : null,
        promise_minutes != null ? mins : null,
        is_default != null ? !!is_default : null,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Zone not found' });
    res.json({ zone: rows[0] });
  })
);

router.delete(
  '/zones/:id',
  ah(async (req, res) => {
    const { rows } = await db.query('DELETE FROM zones WHERE id = $1 RETURNING *', [
      req.params.id,
    ]);
    if (!rows[0]) return res.status(404).json({ error: 'Zone not found' });
    if (rows[0].is_default) {
      // Never leave the system without a default zone.
      await db.query(
        'UPDATE zones SET is_default = true WHERE id = (SELECT id FROM zones ORDER BY created_at LIMIT 1)'
      );
    }
    res.json({ ok: true });
  })
);

// ---- Promise-hit-rate stats (on-time vs late deliveries) ----
router.get(
  '/promise-stats',
  ah(async (req, res) => {
    const days = Math.min(Number(req.query.days) || 30, 365);
    const { rows } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
         COUNT(*) FILTER (WHERE status = 'delivered' AND promised_at IS NOT NULL
                          AND delivered_at <= promised_at) AS on_time,
         COUNT(*) FILTER (WHERE status = 'delivered' AND promised_at IS NOT NULL
                          AND delivered_at > promised_at) AS late,
         ROUND(AVG(EXTRACT(EPOCH FROM (delivered_at - placed_at)) / 60)
               FILTER (WHERE status = 'delivered')) AS avg_minutes
       FROM orders
       WHERE placed_at > now() - ($1 || ' days')::interval`,
      [days]
    );
    const s = rows[0] || {};
    const delivered = Number(s.delivered) || 0;
    const onTime = Number(s.on_time) || 0;
    const late = Number(s.late) || 0;
    res.json({
      days,
      delivered,
      on_time: onTime,
      late,
      hit_rate: delivered ? Math.round((onTime / delivered) * 100) : null,
      avg_minutes: s.avg_minutes != null ? Number(s.avg_minutes) : null,
    });
  })
);


module.exports = router;
