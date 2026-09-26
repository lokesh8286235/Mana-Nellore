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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const iso = today.toISOString();

    const q = async (text, params = []) => (await db.query(text, params)).rows[0];

    const ordersToday = await q(
      "SELECT COUNT(*) AS c FROM orders WHERE placed_at >= $1", [iso]);
    const salesToday = await q(
      "SELECT COALESCE(SUM(total_paise),0) AS s FROM orders WHERE placed_at >= $1 AND payment_status = 'paid'", [iso]);
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
         (SELECT COUNT(*) FROM users WHERE role = 'customer') AS customers`);

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
      `SELECT r.*, u.name AS owner_name, u.phone AS owner_phone FROM restaurants r
       LEFT JOIN users u ON u.id = r.owner_id WHERE r.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Restaurant not found' });
    res.json({ restaurant: rows[0] });
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
    const params = ["'customer'"];
    let where = 'u.role = $1';
    if (req.query.q) {
      params.push(`%${req.query.q}%`);
      where += ` AND (u.name ILIKE $${params.length} OR u.phone ILIKE $${params.length})`;
    }
    const { rows } = await db.query(
      `SELECT u.id, u.phone, u.name, u.created_at,
              (SELECT COUNT(*) FROM orders o WHERE o.customer_id = u.id) AS total_orders,
              (SELECT COALESCE(SUM(total_paise),0) FROM orders o WHERE o.customer_id = u.id AND o.payment_status='paid') AS lifetime_paise
       FROM users u WHERE ${where} ORDER BY u.created_at DESC LIMIT 100`,
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
    let where = '';
    if (req.query.status) {
      params.push(req.query.status);
      where = `WHERE t.status = $${params.length}`;
    }
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
    const f = from.toISOString();
    const t = to.toISOString();

    const totals = await db.query(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total_paise),0) AS sales,
              COALESCE(AVG(total_paise),0) AS avg_order
       FROM orders WHERE placed_at BETWEEN $1 AND $2 AND payment_status = 'paid'`,
      [f, t]
    );
    const byDay = await db.query(
      `SELECT placed_at::date AS day, COUNT(*) AS orders, COALESCE(SUM(total_paise),0) AS sales
       FROM orders WHERE placed_at BETWEEN $1 AND $2 AND payment_status = 'paid'
       GROUP BY day ORDER BY day`,
      [f, t]
    );
    const topRestaurants = await db.query(
      `SELECT r.name, COUNT(o.id) AS orders, COALESCE(SUM(o.total_paise),0) AS sales
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.placed_at BETWEEN $1 AND $2 AND o.payment_status = 'paid'
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

// ---- Audit logs ----
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

module.exports = router;
