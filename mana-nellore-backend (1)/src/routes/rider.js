// Rider portal. A rider only ever sees and touches their own deliveries
// and earnings — enforced in every query by their rider id.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireRole, ah } = require('../middleware/auth');
const { haversineKm, loadPricingConfig, riderPayoutPaise } = require('../lib/pricing');

const router = express.Router();
router.use(authenticate, requireRole('rider'));

async function myRider(userId) {
  const { rows } = await db.query('SELECT * FROM riders WHERE user_id = $1', [userId]);
  return rows[0] || null;
}

async function requireActiveRider(req, res) {
  const rider = await myRider(req.user.id);
  if (!rider) {
    res.status(404).json({ error: 'Rider profile not found' });
    return null;
  }
  if (rider.status !== 'approved') {
    res.status(403).json({ error: `Rider account is ${rider.status}` });
    return null;
  }
  return rider;
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

function newDeliveryOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// GET /api/rider/profile
router.get(
  '/profile',
  ah(async (req, res) => {
    const rider = await myRider(req.user.id);
    if (!rider) return res.status(404).json({ error: 'Rider profile not found' });
    const { rows } = await db.query('SELECT id, phone, name FROM users WHERE id = $1', [req.user.id]);
    res.json({ rider: { ...rider, rating_avg: Number(rider.rating_avg), user: rows[0] } });
  })
);

// PUT /api/rider/profile { vehicle_type, vehicle_number, licence_no }
router.put(
  '/profile',
  ah(async (req, res) => {
    const { vehicle_type, vehicle_number, licence_no } = req.body;
    const { rows } = await db.query(
      `UPDATE riders SET vehicle_type = COALESCE($1, vehicle_type),
                         vehicle_number = COALESCE($2, vehicle_number),
                         licence_no = COALESCE($3, licence_no)
       WHERE user_id = $4 RETURNING *`,
      [vehicle_type || null, vehicle_number || null, licence_no || null, req.user.id]
    );
    res.json({ rider: rows[0] });
  })
);

// PUT /api/rider/online { online }
router.put(
  '/online',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const { rows } = await db.query(
      'UPDATE riders SET online = $1 WHERE id = $2 RETURNING online',
      [!!req.body.online, rider.id]
    );
    res.json({ online: rows[0].online });
  })
);

// PUT /api/rider/location { lat, lng }
router.put(
  '/location',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const { lat, lng } = req.body;
    if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng are required' });
    await db.query('UPDATE riders SET lat = $1, lng = $2 WHERE id = $3', [lat, lng, rider.id]);
    res.json({ ok: true });
  })
);

// Delivery detail (scoped to this rider's deliveries)
async function deliveryDetail(orderId, riderId) {
  const { rows } = await db.query(
    `SELECT o.*, r.name AS restaurant_name, r.address AS restaurant_address,
            r.lat AS rest_lat, r.lng AS rest_lng, r.phone AS restaurant_phone,
            a.label AS addr_label, a.line1, a.line2, a.city,
            a.lat AS addr_lat, a.lng AS addr_lng,
            u.name AS customer_name, u.phone AS customer_phone
     FROM orders o
     JOIN restaurants r ON r.id = o.restaurant_id
     LEFT JOIN addresses a ON a.id = o.address_id
     JOIN users u ON u.id = o.customer_id
     WHERE o.id = $1 AND o.rider_id = $2`,
    [orderId, riderId]
  );
  const order = rows[0];
  if (!order) return null;
  delete order.delivery_otp_hash;
  const items = await db.query('SELECT name_snapshot, qty, unit_price_paise FROM order_items WHERE order_id = $1', [order.id]);
  return { ...order, items: items.rows };
}

// GET /api/rider/deliveries/available — ready orders with no rider yet
router.get(
  '/deliveries/available',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const { rows } = await db.query(
      `SELECT o.id, o.total_paise, o.placed_at,
              r.name AS restaurant_name, r.lat AS rest_lat, r.lng AS rest_lng,
              a.line1, a.city, a.lat AS addr_lat, a.lng AS addr_lng
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       WHERE o.status = 'ready' AND o.rider_id IS NULL
       ORDER BY o.placed_at ASC LIMIT 20`
    );
    const config = await loadPricingConfig(db);
    const list = rows.map((o) => {
      let distanceKm = null;
      let payout = null;
      if (o.rest_lat != null && o.rest_lng != null && o.addr_lat != null && o.addr_lng != null) {
        distanceKm = haversineKm(o.rest_lat, o.rest_lng, o.addr_lat, o.addr_lng);
        payout = riderPayoutPaise(config.riderPayout, distanceKm);
      }
      return {
        id: o.id,
        total_paise: o.total_paise,
        placed_at: o.placed_at,
        restaurant_name: o.restaurant_name,
        address: [o.line1, o.city].filter(Boolean).join(', '),
        distance_km: distanceKm == null ? null : Math.round(distanceKm * 10) / 10,
        payout_paise: payout
      };
    });
    res.json({ deliveries: list });
  })
);

// GET /api/rider/deliveries?status=active — my deliveries
router.get(
  '/deliveries',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    let where = 'o.rider_id = $1';
    const params = [rider.id];
    if (req.query.status === 'active') {
      where += " AND o.status NOT IN ('delivered','cancelled')";
    } else if (req.query.status) {
      params.push(req.query.status);
      where += ` AND o.status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT o.id, o.status, o.total_paise, o.placed_at, r.name AS restaurant_name
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE ${where} ORDER BY o.placed_at DESC LIMIT 50`,
      params
    );
    res.json({ deliveries: rows });
  })
);

// GET /api/rider/deliveries/:id
router.get(
  '/deliveries/:id',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const detail = await deliveryDetail(req.params.id, rider.id);
    if (!detail) return res.status(404).json({ error: 'Delivery not found' });
    res.json({ delivery: detail });
  })
);

// POST /api/rider/deliveries/:id/accept
router.post(
  '/deliveries/:id/accept',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    if (!rider.online) return res.status(409).json({ error: 'Go online to accept deliveries' });
    const { rows } = await db.query(
      "SELECT * FROM orders WHERE id = $1 AND status = 'ready' AND rider_id IS NULL",
      [req.params.id]
    );
    const order = rows[0];
    if (!order) return res.status(409).json({ error: 'Delivery no longer available' });
    await db.query('UPDATE orders SET rider_id = $1 WHERE id = $2', [rider.id, order.id]);
    const timeline = order.timeline || [];
    timeline.push({ status: 'rider_assigned', at: new Date().toISOString(), by: 'rider' });
    await db.query('UPDATE orders SET timeline = $1::jsonb WHERE id = $2', [
      JSON.stringify(timeline), order.id
    ]);
    await notify(order.customer_id, 'Rider assigned', 'Your rider is on the way to the restaurant.');
    res.json({ ok: true });
  })
);

// PUT /api/rider/deliveries/:id/arrived-restaurant
router.put(
  '/deliveries/:id/arrived-restaurant',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const detail = await deliveryDetail(req.params.id, rider.id);
    if (!detail) return res.status(404).json({ error: 'Delivery not found' });
    if (detail.status !== 'ready') return res.status(409).json({ error: `Invalid status ${detail.status}` });
    const timeline = detail.timeline || [];
    timeline.push({ status: 'arrived_restaurant', at: new Date().toISOString(), by: 'rider' });
    await db.query('UPDATE orders SET timeline = $1::jsonb WHERE id = $2', [
      JSON.stringify(timeline), detail.id
    ]);
    res.json({ ok: true });
  })
);

// PUT /api/rider/deliveries/:id/picked-up — generates the delivery OTP for the customer
router.put(
  '/deliveries/:id/picked-up',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const detail = await deliveryDetail(req.params.id, rider.id);
    if (!detail) return res.status(404).json({ error: 'Delivery not found' });
    if (detail.status !== 'ready') return res.status(409).json({ error: `Invalid status ${detail.status}` });

    const code = newDeliveryOtp();
    const hash = await bcrypt.hash(code, 8);
    await db.query('UPDATE orders SET delivery_otp_hash = $1 WHERE id = $2', [hash, detail.id]);
    await transition(detail.id, 'picked_up', 'rider');
    await notify(detail.customer_id, 'Your delivery OTP',
      `Your rider has picked up the order. Share this OTP to receive it: ${code}`);
    res.json({ ok: true, status: 'picked_up' });
  })
);

// PUT /api/rider/deliveries/:id/arrived-customer
router.put(
  '/deliveries/:id/arrived-customer',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const detail = await deliveryDetail(req.params.id, rider.id);
    if (!detail) return res.status(404).json({ error: 'Delivery not found' });
    if (detail.status !== 'picked_up') return res.status(409).json({ error: `Invalid status ${detail.status}` });
    await transition(detail.id, 'on_way', 'rider');
    res.json({ ok: true, status: 'on_way' });
  })
);

// POST /api/rider/deliveries/:id/complete { otp }
router.post(
  '/deliveries/:id/complete',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND rider_id = $2',
      [req.params.id, rider.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Delivery not found' });
    if (order.status !== 'on_way') return res.status(409).json({ error: `Invalid status ${order.status}` });
    if (!order.delivery_otp_hash || !(await bcrypt.compare(String(req.body.otp || ''), order.delivery_otp_hash))) {
      return res.status(401).json({ error: 'Invalid delivery OTP' });
    }

    // Compute payout from live pricing config
    const loc = await db.query(
      `SELECT r.lat AS rest_lat, r.lng AS rest_lng, a.lat AS addr_lat, a.lng AS addr_lng
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id WHERE o.id = $1`,
      [order.id]
    );
    const l = loc.rows[0];
    const config = await loadPricingConfig(db);
    let distanceKm = null;
    let payout = 3000; // fallback Rs 30 when locations unknown
    if (l.rest_lat != null && l.rest_lng != null && l.addr_lat != null && l.addr_lng != null) {
      distanceKm = haversineKm(l.rest_lat, l.rest_lng, l.addr_lat, l.addr_lng);
      payout = riderPayoutPaise(config.riderPayout, distanceKm);
    }

    await db.query(
      `INSERT INTO rider_payouts (rider_id, order_id, amount_paise, distance_km)
       VALUES ($1, $2, $3, $4) ON CONFLICT (order_id) DO NOTHING`,
      [rider.id, order.id, payout, distanceKm]
    );
    await transition(order.id, 'delivered', 'rider');
    const cod = order.payment_method === 'cod' && order.payment_status === 'pending';
    await db.query(
      "UPDATE orders SET delivered_at = now(), payment_status = $1 WHERE id = $2",
      [cod ? 'paid' : order.payment_status, order.id]
    );
    await notify(order.customer_id, 'Order delivered',
      `Enjoy your meal! Please rate your experience.`);
    res.json({ ok: true, status: 'delivered', payout_paise: payout });
  })
);

// GET /api/rider/earnings?from=&to=
router.get(
  '/earnings',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 864e5);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const sum = await db.query(
      `SELECT COALESCE(SUM(amount_paise), 0) AS total_paise, COUNT(*) AS trips
       FROM rider_payouts WHERE rider_id = $1 AND created_at BETWEEN $2 AND $3`,
      [rider.id, from.toISOString(), to.toISOString()]
    );
    const list = await db.query(
      `SELECT rp.*, o.total_paise AS order_total
       FROM rider_payouts rp JOIN orders o ON o.id = rp.order_id
       WHERE rp.rider_id = $1 AND rp.created_at BETWEEN $2 AND $3
       ORDER BY rp.created_at DESC`,
      [rider.id, from.toISOString(), to.toISOString()]
    );
    res.json({
      total_paise: Number(sum.rows[0].total_paise),
      trips: Number(sum.rows[0].trips),
      payouts: list.rows
    });
  })
);

module.exports = router;
