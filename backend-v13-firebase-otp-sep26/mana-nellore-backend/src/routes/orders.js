// Customer order lifecycle: place, pay, track, cancel, rate.
// Pricing is computed server-side from pricing_config — clients never send totals.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireRole, ah } = require('../middleware/auth');
const { haversineKm, loadPricingConfig, computeQuote } = require('../lib/pricing');

const router = express.Router();
router.use(authenticate);

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

// POST /api/orders/quote { restaurant_id, address_id, items:[{menu_item_id, qty}], coupon_code?, use_credits? }
// Read-only bill preview: returns the exact fee breakdown the customer will
// pay, computed with the same pricing engine as order placement. No order created.
router.post(
  '/quote',
  ah(async (req, res) => {
    const { restaurant_id, address_id, items, coupon_code, use_credits } = req.body;
    if (!restaurant_id || !address_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'restaurant_id, address_id and items are required' });
    }
    const rRes = await db.query(
      "SELECT id, lat, lng, commission_pct FROM restaurants WHERE id = $1 AND status = 'approved'",
      [restaurant_id]
    );
    const restaurant = rRes.rows[0];
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not available' });

    const aRes = await db.query('SELECT lat, lng FROM addresses WHERE id = $1 AND user_id = $2', [
      address_id,
      req.user.id
    ]);
    const address = aRes.rows[0];
    if (!address) return res.status(400).json({ error: 'Delivery address not found' });

    const ids = items.map((i) => i.menu_item_id);
    const mRes = await db.query(
      'SELECT id, price_paise, available FROM menu_items WHERE id = ANY($1) AND restaurant_id = $2',
      [ids, restaurant_id]
    );
    const menuById = Object.fromEntries(mRes.rows.map((m) => [m.id, m]));

    let subtotal = 0;
    for (const it of items) {
      const m = menuById[it.menu_item_id];
      const qty = Number(it.qty);
      if (!m || !m.available || !Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ error: 'Cart contains an unavailable item' });
      }
      let custExtra = 0;
      if (Array.isArray(it.customizations) && it.customizations.length) {
        const optIds = it.customizations.map((c) => c.option_id).filter(Boolean);
        if (optIds.length) {
          const oRes = await db.query(
            `SELECT o.price_paise FROM customization_options o
             JOIN customization_groups g ON g.id = o.group_id
             WHERE o.id = ANY($1) AND g.menu_item_id = $2`,
            [optIds, m.id]
          );
          for (const o of oRes.rows) custExtra += Number(o.price_paise) || 0;
        }
      }
      subtotal += (m.price_paise + custExtra) * qty;
    }

    let discount = 0;
    let couponError = null;
    if (coupon_code) {
      const cRes = await db.query('SELECT * FROM coupons WHERE code = $1 AND active = true', [
        String(coupon_code).toUpperCase()
      ]);
      const coupon = cRes.rows[0];
      const now = new Date();
      if (!coupon) couponError = 'Invalid coupon code';
      else if (coupon.valid_from && new Date(coupon.valid_from) > now) couponError = 'Coupon not yet valid';
      else if (coupon.valid_to && new Date(coupon.valid_to) < now) couponError = 'Coupon expired';
      else if (subtotal < coupon.min_order_paise)
        couponError = `Coupon needs a minimum order of Rs ${(coupon.min_order_paise / 100).toFixed(0)}`;
      else {
        discount =
          coupon.discount_type === 'flat'
            ? coupon.value
            : Math.round((subtotal * coupon.value) / 100);
        if (coupon.max_discount_paise != null) discount = Math.min(discount, coupon.max_discount_paise);
        discount = Math.min(discount, subtotal);
      }
    }

    let distanceKm = null;
    if (restaurant.lat != null && restaurant.lng != null && address.lat != null && address.lng != null) {
      distanceKm = haversineKm(
        Number(restaurant.lat),
        Number(restaurant.lng),
        Number(address.lat),
        Number(address.lng)
      );
    }
    const config = await loadPricingConfig(db);
    const quote = computeQuote({
      config,
      distanceKm,
      subtotalPaise: subtotal,
      discountPaise: discount,
      commissionPct: restaurant.commission_pct
    });

    let creditsUsed = 0;
    let walletBalance = 0;
    if (use_credits) {
      const balRes = await db.query(
        'SELECT COALESCE(SUM(amount_paise), 0) AS balance FROM customer_credits WHERE user_id = $1',
        [req.user.id]
      );
      walletBalance = Number(balRes.rows[0].balance);
      creditsUsed = Math.min(walletBalance, quote.totalPaise);
    }

    res.json({
      bill: {
        subtotal_paise: subtotal,
        discount_paise: discount,
        delivery_fee_paise: quote.deliveryFeePaise,
        platform_fee_paise: quote.platformFeePaise,
        tax_paise: quote.taxPaise,
        credits_used_paise: creditsUsed,
        total_paise: quote.totalPaise - creditsUsed
      },
      wallet_balance_paise: walletBalance,
      coupon_error: couponError,
      promise_minutes: Number(config.promiseMinutes) || 30
    });
  })
);

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
        // Customization price additions
        let custExtra = 0;
        let custNames = [];
        if (Array.isArray(it.customizations) && it.customizations.length) {
          const optIds = it.customizations.map((c) => c.option_id).filter(Boolean);
          if (optIds.length) {
            const oRes = await client.query(
              `SELECT o.id, o.name, o.price_paise FROM customization_options o
               JOIN customization_groups g ON g.id = o.group_id
               WHERE o.id = ANY($1) AND g.menu_item_id = $2`,
              [optIds, m.id]
            );
            for (const o of oRes.rows) {
              custExtra += Number(o.price_paise) || 0;
              custNames.push(o.name);
            }
          }
        }
        subtotal += (m.price_paise + custExtra) * qty;
        snapshots.push({
          menu_item_id: m.id,
          name_snapshot: m.name + (custNames.length ? ' (' + custNames.join(', ') + ')' : ''),
          unit_price_paise: m.price_paise + custExtra,
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

      // Delivery promise clock starts at placement; wallet credits reduce the total.
      const promiseMinutes = Number(config.promiseMinutes) || 30;
      let creditsUsed = 0;
      if (req.body.use_credits) {
        const balRes = await client.query(
          'SELECT COALESCE(SUM(amount_paise), 0) AS balance FROM customer_credits WHERE user_id = $1',
          [req.user.id]
        );
        creditsUsed = Math.min(Number(balRes.rows[0].balance), quote.totalPaise);
      }
      const finalTotal = quote.totalPaise - creditsUsed;

      const oRes = await client.query(
        `INSERT INTO orders
           (customer_id, restaurant_id, address_id, status,
            subtotal_paise, discount_paise, delivery_fee_paise, platform_fee_paise,
            tax_paise, commission_paise, total_paise,
            payment_method, payment_status, timeline, promised_at, credits_used_paise)
         VALUES ($1,$2,$3,'placed',$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12::jsonb,
                 now() + ($13 || ' minutes')::interval, $14)
         RETURNING *`,
        [req.user.id, restaurant_id, address_id,
         subtotal, discount, quote.deliveryFeePaise, quote.platformFeePaise,
         quote.taxPaise, quote.commissionPaise, finalTotal,
         payment_method || 'upi', JSON.stringify(timeline), String(promiseMinutes), creditsUsed]
      );
      const order = oRes.rows[0];

      if (creditsUsed > 0) {
        await client.query(
          `INSERT INTO customer_credits (user_id, amount_paise, reason, order_id)
           VALUES ($1, $2, 'order_payment', $3)`,
          [req.user.id, -creditsUsed, order.id]
        );
      }

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
          credits_used_paise: creditsUsed,
          total_paise: finalTotal,
          promise_minutes: promiseMinutes,
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

// POST /api/orders/:id/rate { food_rating?, delivery_rating?, comment?, photo_url? }
router.post(
  '/:id/rate',
  ah(async (req, res) => {
    const { food_rating, delivery_rating, comment, photo_url } = req.body;
    // Food photos: client-resized data URLs only, capped to protect the DB.
    let photo = null;
    if (photo_url) {
      if (typeof photo_url !== 'string' || !photo_url.startsWith('data:image/') || photo_url.length > 600000) {
        return res.status(400).json({ error: 'Invalid photo' });
      }
      photo = photo_url;
    }
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
      `INSERT INTO ratings (order_id, rater_id, ratee_type, ratee_id, food_rating, delivery_rating, comment, photo_url)
       VALUES ($1,$2,'restaurant',$3,$4,$5,$6,$7)`,
      [order.id, req.user.id, order.restaurant_id, food_rating || null, null, comment || null, photo]
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

// POST /api/orders/:id/report { type: 'cold_food', notes? } — one-tap issue report
// on a delivered order. A validated cold-food report auto-issues the apology credit.
router.post(
  '/:id/report',
  ah(async (req, res) => {
    const { type, notes } = req.body;
    if (type !== 'cold_food') return res.status(400).json({ error: 'Unknown report type' });
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'delivered') {
      return res.status(409).json({ error: 'You can report only delivered orders' });
    }
    const dup = await db.query(
      "SELECT id FROM support_tickets WHERE order_id = $1 AND category = 'cold_food'",
      [order.id]
    );
    if (dup.rows[0]) return res.status(409).json({ error: 'This order was already reported' });

    const ticket = await db.query(
      `INSERT INTO support_tickets (user_id, order_id, category, subject, message)
       VALUES ($1,$2,'cold_food','Food arrived cold',$3) RETURNING *`,
      [req.user.id, order.id, notes || 'Customer reported the food arrived cold.']
    );
    const config = await loadPricingConfig(db);
    const creditPaise = Number(config.apologyCreditPaise) || 0;
    if (creditPaise > 0) {
      await db.query(
        `INSERT INTO customer_credits (user_id, amount_paise, reason, order_id)
         VALUES ($1,$2,'cold_food_apology',$3)`,
        [req.user.id, creditPaise, order.id]
      );
      await notify(req.user.id, 'Apology credit added',
        `We're sorry your food arrived cold. Rs ${(creditPaise / 100).toFixed(0)} credit has been added to your account.`);
    }
    res.status(201).json({ ticket: ticket.rows[0], credit_paise: creditPaise });
  })
);

module.exports = router;
