// Customer order lifecycle: place, pay, track, cancel, rate.
// Pricing is computed server-side from pricing_config — clients never send totals.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireRole, ah } = require('../middleware/auth');
const { haversineKm, loadPricingConfig, computeQuote } = require('../lib/pricing');

const router = express.Router();
router.use(authenticate, requireRole('customer'));

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

// POST /api/orders { restaurant_id, address_id, items:[{menu_item_id, qty, instructions}], coupon_code?, payment_method? }
router.post(
  '/',
  ah(async (req, res) => {
    const { restaurant_id, address_id, items, coupon_code, payment_method } = req.body;
    if (!restaurant_id || !address_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'restaurant_id, address_id and items are required' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const rRes = await client.query(
        "SELECT * FROM restaurants WHERE id = $1 AND status = 'approved'",
        [restaurant_id]
      );
      const restaurant = rRes.rows[0];
      if (!restaurant) throw { status: 404, message: 'Restaurant not available' };
      if (!restaurant.is_open) throw { status: 400, message: 'Restaurant is currently closed' };

      const aRes = await client.query(
        'SELECT * FROM addresses WHERE id = $1 AND user_id = $2',
        [address_id, req.user.id]
      );
      const address = aRes.rows[0];
      if (!address) throw { status: 400, message: 'Delivery address not found' };

      const ids = items.map((i) => i.menu_item_id);
      const mRes = await client.query(
        'SELECT id, name, price_paise, available FROM menu_items WHERE id = ANY($1) AND restaurant_id = $2',
        [ids, restaurant_id]
      );
      const menuById = Object.fromEntries(mRes.rows.map((m) => [m.id, m]));

      let subtotal = 0;
      const snapshots = [];
      for (const it of items) {
        const m = menuById[it.menu_item_id];
        const qty = Number(it.qty);
        if (!m) throw { status: 400, message: 'A menu item is not from this restaurant' };
        if (!m.available) throw { status: 400, message: `"${m.name}" is currently unavailable` };
        if (!Number.isInteger(qty) || qty <= 0) throw { status: 400, message: 'Quantity must be a positive integer' };
        subtotal += m.price_paise * qty;
        snapshots.push({
          menu_item_id: m.id,
          name_snapshot: m.name,
          unit_price_paise: m.price_paise,
          qty,
          instructions: it.instructions || null
        });
      }

      // Coupon
      let discount = 0;
      let couponId = null;
      if (coupon_code) {
        const cRes = await client.query(
          'SELECT * FROM coupons WHERE code = $1 AND active = true',
          [String(coupon_code).toUpperCase()]
        );
        const coupon = cRes.rows[0];
        const now = new Date();
        if (!coupon) throw { status: 400, message: 'Invalid coupon code' };
        if (coupon.valid_from && new Date(coupon.valid_from) > now) throw { status: 400, message: 'Coupon not yet valid' };
        if (coupon.valid_to && new Date(coupon.valid_to) < now) throw { status: 400, message: 'Coupon expired' };
        if (subtotal < coupon.min_order_paise) {
          throw { status: 400, message: `Coupon needs a minimum order of Rs ${(coupon.min_order_paise / 100).toFixed(0)}` };
        }
        discount =
          coupon.discount_type === 'flat'
            ? coupon.value
            : Math.round((subtotal * coupon.value) / 100);
        if (coupon.max_discount_paise != null) discount = Math.min(discount, coupon.max_discount_paise);
        discount = Math.min(discount, subtotal);
        couponId = coupon.id;
      }

      // Distance + quote
      let distanceKm = null;
      if (restaurant.lat != null && restaurant.lng != null && address.lat != null && address.lng != null) {
        distanceKm = haversineKm(restaurant.lat, restaurant.lng, address.lat, address.lng);
      }
      const config = await loadPricingConfig(client);
      const quote = computeQuote({
        config,
        distanceKm,
        subtotalPaise: subtotal,
        discountPaise: discount,
        commissionPct: restaurant.commission_pct
      });

      const timeline = [{ status: 'placed', at: new Date().toISOString(), by: 'customer' }];
      const oRes = await client.query(
        `INSERT INTO orders
           (customer_id, restaurant_id, address_id, status,
            subtotal_paise, discount_paise, delivery_fee_paise, platform_fee_paise,
            tax_paise, commission_paise, total_paise,
            payment_method, payment_status, timeline)
         VALUES ($1,$2,$3,'placed',$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12::jsonb)
         RETURNING *`,
        [req.user.id, restaurant_id, address_id,
         subtotal, discount, quote.deliveryFeePaise, quote.platformFeePaise,
         quote.taxPaise, quote.commissionPaise, quote.totalPaise,
         payment_method || 'upi', JSON.stringify(timeline)]
      );
      const order = oRes.rows[0];

      for (const s of snapshots) {
        await client.query(
          `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, unit_price_paise, qty, instructions)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [order.id, s.menu_item_id, s.name_snapshot, s.unit_price_paise, s.qty, s.instructions]
        );
      }
      await client.query('COMMIT');

      const ownerRes = await db.query('SELECT owner_id FROM restaurants WHERE id = $1', [restaurant_id]);
      if (ownerRes.rows[0] && ownerRes.rows[0].owner_id) {
        await notify(ownerRes.rows[0].owner_id, 'New order received',
          `Order worth Rs ${(order.total_paise / 100).toFixed(2)} from ${restaurant.name}.`);
      }

      res.status(201).json({
        order: { ...order, items: snapshots },
        breakdown: {
          subtotal_paise: subtotal,
          discount_paise: discount,
          delivery_fee_paise: quote.deliveryFeePaise,
          platform_fee_paise: quote.platformFeePaise,
          total_paise: quote.totalPaise,
          distance_km: distanceKm == null ? null : Math.round(distanceKm * 100) / 100,
          coupon_id: couponId
        }
      });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    } finally {
      client.release();
    }
  })
);

// POST /api/orders/:id/pay — simulates gateway success (replace with webhook later)
router.post(
  '/:id/pay',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status !== 'pending') {
      return res.status(409).json({ error: `Payment already ${order.payment_status}` });
    }
    await db.query("UPDATE orders SET payment_status = 'paid' WHERE id = $1", [order.id]);
    const timeline = order.timeline || [];
    timeline.push({ status: 'paid', at: new Date().toISOString(), by: 'customer' });
    await db.query('UPDATE orders SET timeline = $1::jsonb WHERE id = $2', [
      JSON.stringify(timeline), order.id
    ]);
    res.json({ ok: true, payment_status: 'paid' });
  })
);

// GET /api/orders?status=
router.get(
  '/',
  ah(async (req, res) => {
    const params = [req.user.id];
    let where = 'o.customer_id = $1';
    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND o.status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT o.*, r.name AS restaurant_name, r.image_url AS restaurant_image
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE ${where} ORDER BY o.placed_at DESC LIMIT 50`,
      params
    );
    res.json({ orders: rows });
  })
);

// GET /api/orders/:id
router.get(
  '/:id',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT o.*, r.name AS restaurant_name, r.image_url AS restaurant_image, r.phone AS restaurant_phone,
              a.line1, a.line2, a.city, ru.name AS rider_name, ru.phone AS rider_phone
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       LEFT JOIN riders rd ON rd.id = o.rider_id
       LEFT JOIN users ru ON ru.id = rd.user_id
       WHERE o.id = $1 AND o.customer_id = $2`,
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    delete order.delivery_otp_hash; // never expose to clients
    const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    res.json({ order: { ...order, items: items.rows } });
  })
);

// POST /api/orders/:id/cancel { reason } — only before the restaurant accepts
router.post(
  '/:id/cancel',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'placed') {
      return res.status(409).json({ error: 'Order can no longer be cancelled' });
    }
    await transition(order.id, 'cancelled', 'customer');
    const refunded = order.payment_status === 'paid';
    await db.query(
      'UPDATE orders SET cancel_reason = $1, payment_status = $2 WHERE id = $3',
      [req.body.reason || 'Cancelled by customer', refunded ? 'refunded' : order.payment_status, order.id]
    );
    res.json({ ok: true, refunded });
  })
);

// POST /api/orders/:id/delivery-otp — re-issue the delivery OTP (active delivery only)
router.post(
  '/:id/delivery-otp',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!['picked_up', 'on_way'].includes(order.status)) {
      return res.status(409).json({ error: 'Delivery OTP is available only during delivery' });
    }
    const code = newDeliveryOtp();
    const hash = await bcrypt.hash(code, 8);
    await db.query('UPDATE orders SET delivery_otp_hash = $1 WHERE id = $2', [hash, order.id]);
    await notify(req.user.id, 'Your delivery OTP', `Share this OTP with your rider to receive the order: ${code}`);
    res.json({ ok: true, message: 'OTP re-sent to your notifications' });
  })
);

// POST /api/orders/:id/rate { food_rating?, delivery_rating?, comment? }
router.post(
  '/:id/rate',
  ah(async (req, res) => {
    const { food_rating, delivery_rating, comment } = req.body;
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'delivered') {
      return res.status(409).json({ error: 'You can rate only delivered orders' });
    }
    const existing = await db.query(
      'SELECT id FROM ratings WHERE order_id = $1 AND rater_id = $2',
      [order.id, req.user.id]
    );
    if (existing.rows[0]) return res.status(409).json({ error: 'Order already rated' });

    await db.query(
      `INSERT INTO ratings (order_id, rater_id, ratee_type, ratee_id, food_rating, delivery_rating, comment)
       VALUES ($1,$2,'restaurant',$3,$4,$5,$6)`,
      [order.id, req.user.id, order.restaurant_id, food_rating || null, null, comment || null]
    );
    if (order.rider_id && delivery_rating) {
      const rp = await db.query('SELECT user_id FROM riders WHERE id = $1', [order.rider_id]);
      await db.query(
        `INSERT INTO ratings (order_id, rater_id, ratee_type, ratee_id, food_rating, delivery_rating, comment)
         VALUES ($1,$2,'rider',$3,$4,$5,$6)`,
        [order.id, req.user.id, rp.rows[0].user_id, null, delivery_rating, comment || null]
      );
      await db.query(
        `UPDATE riders SET rating_avg = (
           SELECT COALESCE(AVG(delivery_rating), 0) FROM ratings
           WHERE ratee_type = 'rider' AND ratee_id = riders.user_id AND delivery_rating IS NOT NULL
         ) WHERE id = $1`,
        [order.rider_id]
      );
    }
    if (food_rating) {
      await db.query(
        `UPDATE restaurants SET rating_avg = (
           SELECT COALESCE(AVG(food_rating), 0) FROM ratings
           WHERE ratee_type = 'restaurant' AND ratee_id = $1 AND food_rating IS NOT NULL
         ) WHERE id = $1`,
        [order.restaurant_id]
      );
    }
    res.json({ ok: true });
  })
);

module.exports = router;
