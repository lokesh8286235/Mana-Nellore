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
  // Single UPDATE with a jsonb append: concurrent transitions can no longer
  // silently drop each other's timeline entries (read-modify-write race).
  await db.query(
    `UPDATE orders SET status = $1,
       timeline = COALESCE(timeline, '[]'::jsonb)
                || jsonb_build_object('status', $1, 'at', $2, 'by', $3)
     WHERE id = $4`,
    [status, new Date().toISOString(), by, orderId]
  );
}

function newDeliveryOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// POST /api/orders/quote { restaurant_id, address_id?, items, coupon_code?, order_type?, table_id?, tip_paise? }
// Read-only bill preview: returns the exact fee breakdown the customer will
// pay, computed with the same pricing engine as order placement. No order created.
router.post(
  '/quote',
  ah(async (req, res) => {
    const { restaurant_id, address_id, items, coupon_code, order_type, table_id, tip_paise } = req.body;
    const dineIn = order_type === 'dinein';
    if (!restaurant_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'restaurant_id and items are required' });
    }
    if (!dineIn && !address_id) {
      return res.status(400).json({ error: 'address_id is required for delivery orders' });
    }
    const rRes = await db.query(
      "SELECT id, lat, lng, commission_pct FROM restaurants WHERE id = $1 AND status = 'approved'",
      [restaurant_id]
    );
    const restaurant = rRes.rows[0];
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not available' });

    let address = null;
    if (!dineIn) {
      const aRes = await db.query('SELECT lat, lng FROM addresses WHERE id = $1 AND user_id = $2', [
        address_id,
        req.user.id
      ]);
      address = aRes.rows[0];
      if (!address) return res.status(400).json({ error: 'Delivery address not found' });
    } else if (table_id) {
      const tRes = await db.query('SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2', [
        table_id, restaurant_id
      ]);
      if (!tRes.rows[0]) return res.status(400).json({ error: 'Table not found for this restaurant' });
    }

    const ids = items.map((i) => i.menu_item_id);
    const mRes = await db.query(
      'SELECT id, price_paise, available FROM menu_items WHERE id = ANY($1) AND restaurant_id = $2',
      [ids, restaurant_id]
    );
    const menuById = Object.fromEntries(mRes.rows.map((m) => [m.id, m]));
    let subtotal = 0;
    for (const it of items) {
      const m = menuById[it.menu_item_id];
      if (!m || !m.available) continue;
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty <= 0) {
        return res.status(400).json({ error: 'Quantity must be a positive integer' });
      }
      let custExtra = 0;
      if (Array.isArray(it.customizations) && it.customizations.length) {
        const optIds = it.customizations.map((c) => c.option_id).filter(Boolean);
        if (optIds.length) {
          const oRes = await db.query(
            `SELECT o.id, o.price_paise FROM customization_options o
             JOIN customization_groups g ON g.id = o.group_id
             WHERE o.id = ANY($1) AND g.menu_item_id = $2`,
            [optIds, m.id]
          );
          for (const o of oRes.rows) custExtra += Number(o.price_paise) || 0;
        }
      }
      subtotal += (m.price_paise + custExtra) * qty;
    }

    // Coupon (quote only — placement re-validates everything inside its transaction)
    let discount = 0;
    let couponError = null;
    if (coupon_code) {
      const cRes = await db.query(
        'SELECT * FROM coupons WHERE code = $1 AND active = true',
        [String(coupon_code).toUpperCase()]
      );
      const coupon = cRes.rows[0];
      const now = new Date();
      if (!coupon) couponError = 'Invalid coupon code';
      else if (coupon.valid_from && new Date(coupon.valid_from) > now) couponError = 'Coupon not yet valid';
      else if (coupon.valid_to && new Date(coupon.valid_to) < now) couponError = 'Coupon expired';
      else if (subtotal < coupon.min_order_paise) {
        couponError = `Coupon needs a minimum order of Rs ${(coupon.min_order_paise / 100).toFixed(0)}`;
      } else if (coupon.requires_student) {
        const uRes = await db.query('SELECT is_student FROM users WHERE id = $1', [req.user.id]);
        if (!uRes.rows[0] || !uRes.rows[0].is_student) couponError = 'This coupon is for verified students only';
      }
      if (!couponError) {
        discount =
          coupon.discount_type === 'flat'
            ? coupon.value
            : Math.round((subtotal * coupon.value) / 100);
        if (coupon.max_discount_paise != null) discount = Math.min(discount, coupon.max_discount_paise);
        discount = Math.min(discount, subtotal);
      }
    }

    let distanceKm = null;
    if (!dineIn && restaurant.lat != null && restaurant.lng != null && address.lat != null && address.lng != null) {
      distanceKm = haversineKm(
        Number(restaurant.lat),
        Number(restaurant.lng),
        Number(address.lat),
        Number(address.lng)
      );
    }
    const config = await loadPricingConfig(db);
    const tipPaise = Math.max(0, Math.round(Number(tip_paise) || 0));
    const quote = computeQuote({
      config,
      distanceKm: dineIn ? 0 : distanceKm,
      subtotalPaise: subtotal,
      discountPaise: discount,
      commissionPct: restaurant.commission_pct
    });

    res.json({
      bill: {
        subtotal_paise: subtotal,
        discount_paise: discount,
        delivery_fee_paise: dineIn ? 0 : quote.deliveryFeePaise,
        platform_fee_paise: quote.platformFeePaise,
        tax_paise: quote.taxPaise,
        tip_paise: tipPaise,
        total_paise: (dineIn ? 0 : quote.deliveryFeePaise) + quote.platformFeePaise + tipPaise + (subtotal - discount)
      },
      coupon_error: couponError,
      eta_minutes: Number(config.etaMinutes) || 30
    });
  })
);

// POST /api/orders { restaurant_id, address_id?, order_type?, table_id?, items:[{menu_item_id, qty, instructions, customizations}], coupon_code?, payment_method?, delivery_note?, no_cutlery?, tip_paise?, recipient_name?, recipient_phone? }
router.post(
  '/',
  ah(async (req, res) => {
    const { restaurant_id, address_id, items, coupon_code, payment_method,
            order_type, table_id, delivery_note, no_cutlery, tip_paise,
            recipient_name, recipient_phone } = req.body;
    const dineIn = order_type === 'dinein';
    if (!restaurant_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'restaurant_id and items are required' });
    }
    if (!dineIn && !address_id) {
      return res.status(400).json({ error: 'address_id is required for delivery orders' });
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
      if (restaurant.is_coming_soon) throw { status: 400, message: 'Restaurant is opening soon — not accepting orders yet' };
      if (!restaurant.is_open) throw { status: 400, message: 'Restaurant is currently closed' };

      let address = null;
      if (dineIn) {
        if (!table_id) throw { status: 400, message: 'Table is required for dine-in orders' };
        const tRes = await client.query(
          'SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2', [table_id, restaurant_id]
        );
        if (!tRes.rows[0]) throw { status: 400, message: 'Table not found for this restaurant' };
      } else {
        const aRes = await client.query(
          'SELECT * FROM addresses WHERE id = $1 AND user_id = $2',
          [address_id, req.user.id]
        );
        address = aRes.rows[0];
        if (!address) throw { status: 400, message: 'Delivery address not found' };
      }

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
        if (coupon.requires_student) {
          const uRes = await client.query('SELECT is_student FROM users WHERE id = $1', [req.user.id]);
          if (!uRes.rows[0] || !uRes.rows[0].is_student) {
            throw { status: 400, message: 'This coupon is for verified students only' };
          }
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
      if (!dineIn && restaurant.lat != null && restaurant.lng != null && address.lat != null && address.lng != null) {
        distanceKm = haversineKm(restaurant.lat, restaurant.lng, address.lat, address.lng);
      }
      const config = await loadPricingConfig(client);
      const tipPaise = Math.max(0, Math.round(Number(tip_paise) || 0));
      const quote = computeQuote({
        config,
        distanceKm: dineIn ? 0 : distanceKm,
        subtotalPaise: subtotal,
        discountPaise: discount,
        commissionPct: restaurant.commission_pct
      });
      const deliveryFee = dineIn ? 0 : quote.deliveryFeePaise;
      const finalTotal = (subtotal - discount) + deliveryFee + quote.platformFeePaise + tipPaise;

      const timeline = [{ status: 'placed', at: new Date().toISOString(), by: 'customer' }];
      const etaMinutes = Number(config.etaMinutes) || 30;
      const shareToken = require('crypto').randomBytes(6).toString('hex');

      const oRes = await client.query(
        `INSERT INTO orders
           (customer_id, restaurant_id, address_id, status, order_type, table_id,
            subtotal_paise, discount_paise, delivery_fee_paise, platform_fee_paise,
            tax_paise, commission_paise, total_paise, tip_paise,
            delivery_note, no_cutlery, recipient_name, recipient_phone,
            payment_method, payment_status, timeline, eta_at, share_token)
         VALUES ($1,$2,$3,'placed',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending',$19::jsonb,
                 now() + ($20 || ' minutes')::interval, $21)
         RETURNING *`,
        [req.user.id, restaurant_id, dineIn ? null : address_id, dineIn ? 'dinein' : 'delivery',
         dineIn ? table_id : null,
         subtotal, discount, deliveryFee, quote.platformFeePaise,
         quote.taxPaise, quote.commissionPaise, finalTotal, tipPaise,
         delivery_note || null, !!no_cutlery, recipient_name || null, recipient_phone || null,
         payment_method || 'upi', JSON.stringify(timeline), String(etaMinutes), shareToken]
      );
      const order = oRes.rows[0];

      // Single-use referral coupons: burn after applying so "Rs 50 off your
      // next order" can't be replayed on every order. Generic admin coupons
      // (no issuance record) stay multi-use as before.
      if (couponId) {
        const iss = await client.query(
          `SELECT 1 FROM coupon_issuances
           WHERE user_id = $1 AND coupon_code = $2 AND source = 'referral'`,
          [req.user.id, String(coupon_code).toUpperCase()]
        );
        if (iss.rows[0]) {
          await client.query('UPDATE coupons SET active = false WHERE id = $1', [couponId]);
        }
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
        await notify(ownerRes.rows[0].owner_id, '🔔 New order!',
          `${dineIn ? 'Dine-in table order' : 'Delivery order'} worth Rs ${(order.total_paise / 100).toFixed(2)} — the kitchen needs you! 👨‍🍳`);
      }
      await notify(req.user.id, 'Order placed ✅',
        `${restaurant.name} got your order and the kitchen is firing up! 🔥`);

      res.status(201).json({
        order: { ...order, items: snapshots },
        breakdown: {
          subtotal_paise: subtotal,
          discount_paise: discount,
          delivery_fee_paise: deliveryFee,
          platform_fee_paise: quote.platformFeePaise,
          tip_paise: tipPaise,
          total_paise: finalTotal,
          eta_minutes: etaMinutes,
          distance_km: distanceKm == null ? null : Math.round(distanceKm * 100) / 100,
          coupon_id: couponId,
          share_token: shareToken
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
    await db.query(
      `UPDATE orders SET timeline = COALESCE(timeline, '[]'::jsonb)
         || jsonb_build_object('status', 'paid', 'at', $1, 'by', 'customer')
       WHERE id = $2`,
      [new Date().toISOString(), order.id]
    );
    res.json({ ok: true, payment_status: 'paid' });
  })
);

// POST /api/orders/:id/report-missing — "my food never arrived".
// Creates a missing_food ticket; admin resolves it with a refund or a reorder.
router.post(
  '/:id/report-missing',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (['delivered', 'cancelled', 'rejected'].includes(order.status)) {
      return res.status(409).json({ error: `This order is already ${order.status}` });
    }
    const dup = await db.query(
      `SELECT id FROM support_tickets WHERE order_id = $1 AND category = 'missing_food'
       AND status IN ('open','in_progress') LIMIT 1`, [order.id]
    );
    if (dup.rows[0]) return res.status(409).json({ error: 'You already reported this order', ticket_id: dup.rows[0].id });
    const t = await db.query(
      `INSERT INTO support_tickets (user_id, order_id, category, subject, message)
       VALUES ($1, $2, 'missing_food', 'Food never arrived',
               'Customer reports the food never arrived. Please resolve with a refund or a reorder.')
       RETURNING *`,
      [req.user.id, order.id]
    );
    res.status(201).json({ ticket: t.rows[0] });
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
              r.verified AS restaurant_verified, r.lat AS rest_lat, r.lng AS rest_lng,
              rd.lat AS rider_lat, rd.lng AS rider_lng,
              a.line1, a.line2, a.city,
              ru.name AS rider_name, ru.phone AS rider_phone,
              rd.profile_photo AS rider_photo, rd.rating_avg AS rider_rating,
              COALESCE(rdc.cnt, 0) AS rider_deliveries
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       LEFT JOIN riders rd ON rd.id = o.rider_id
       LEFT JOIN users ru ON ru.id = rd.user_id
       LEFT JOIN (
         SELECT rider_id, COUNT(*) AS cnt FROM orders
         WHERE status = 'delivered' GROUP BY rider_id
       ) rdc ON rdc.rider_id = rd.id
       WHERE o.id = $1 AND o.customer_id = $2`,
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    delete order.delivery_otp_hash; // never expose to clients
    const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    // Queue transparency: orders at this restaurant placed before mine, still active
    let queueAhead = 0;
    if (['placed', 'accepted', 'preparing'].includes(order.status)) {
      const qRes = await db.query(
        `SELECT COUNT(*) AS n FROM orders
         WHERE restaurant_id = $1 AND placed_at < $2
           AND status IN ('placed','accepted','preparing')`,
        [order.restaurant_id, order.placed_at]
      );
      queueAhead = Number(qRes.rows[0].n);
    }
    // Restaurant no-response: still 'placed' after 5 minutes -> flag + nudge the kitchen once.
    let noResponse = false;
    if (order.status === 'placed') {
      const minsWaiting = (Date.now() - new Date(order.placed_at).getTime()) / 60000;
      noResponse = minsWaiting >= 5;
      const nudged = (order.timeline || []).some((t) => t.status === 'no_response_nudge');
      if (noResponse && !nudged) {
        const rOwner = await db.query(
          'SELECT owner_id FROM restaurants WHERE id = $1', [order.restaurant_id]
        );
        if (rOwner.rows[0]) {
          await notify(rOwner.rows[0].owner_id, '⏰ Order waiting for your response!',
            'An order has been waiting 5 minutes — please accept it so the customer isn\u2019t left hanging.');
        }
        const timeline = order.timeline || [];
        timeline.push({ status: 'no_response_nudge', at: new Date().toISOString(), by: 'system' });
        await db.query(
          `UPDATE orders SET timeline = COALESCE(timeline, '[]'::jsonb)
             || jsonb_build_object('status', 'no_response_nudge', 'at', $1, 'by', 'system')
           WHERE id = $2 AND NOT (COALESCE(timeline, '[]'::jsonb) @> '[{"status":"no_response_nudge"}]')`,
          [new Date().toISOString(), order.id]);
      }
    }
    res.json({ order: { ...order, items: items.rows, queue_ahead: queueAhead, no_response: noResponse } });
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
    // Ratings must be whole stars 1-5. Without this, out-of-range values hit
    // the DB CHECK constraint and surface as raw 500s (or a misleading 404
    // for non-numeric input via the 22P02 handler) instead of a clean 400.
    const normRating = (v) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
    };
    const foodRating = normRating(food_rating);
    const deliveryRating = normRating(delivery_rating);
    if (foodRating === undefined || deliveryRating === undefined) {
      return res.status(400).json({ error: 'Ratings must be whole numbers from 1 to 5' });
    }
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
      [order.id, req.user.id, order.restaurant_id, foodRating, null, comment || null, photo]
    );
    if (order.rider_id && deliveryRating != null) {
      const rp = await db.query('SELECT user_id FROM riders WHERE id = $1', [order.rider_id]);
      await db.query(
        `INSERT INTO ratings (order_id, rater_id, ratee_type, ratee_id, food_rating, delivery_rating, comment)
         VALUES ($1,$2,'rider',$3,$4,$5,$6)`,
        [order.id, req.user.id, rp.rows[0].user_id, null, deliveryRating, comment || null]
      );
      await db.query(
        `UPDATE riders SET rating_avg = (
           SELECT COALESCE(AVG(delivery_rating), 0) FROM ratings
           WHERE ratee_type = 'rider' AND ratee_id = riders.user_id AND delivery_rating IS NOT NULL
         ) WHERE id = $1`,
        [order.rider_id]
      );
    }
    if (foodRating != null) {
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

// POST /api/orders/:id/report { type, notes? } — one-tap issue report
// on a delivered order. Creates a support ticket for the ops team; no automatic
// credits — every case is reviewed by a human.
router.post(
  '/:id/report',
  ah(async (req, res) => {
    const { type, notes } = req.body;
    const allowed = ['cold_food', 'wrong_item', 'missing_item', 'late', 'other'];
    if (!allowed.includes(type)) return res.status(400).json({ error: 'Unknown report type' });
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
      'SELECT id FROM support_tickets WHERE order_id = $1 AND category = $2',
      [order.id, type]
    );
    if (dup.rows[0]) return res.status(409).json({ error: 'This order was already reported' });

    const subjects = {
      cold_food: 'Food arrived cold',
      wrong_item: 'Wrong item delivered',
      missing_item: 'Item missing from order',
      late: 'Order arrived late',
      other: 'Issue with my order'
    };
    const ticket = await db.query(
      `INSERT INTO support_tickets (user_id, order_id, category, subject, message)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, order.id, type, subjects[type], notes || 'Customer reported an issue with this order.']
    );
    await notify(req.user.id, 'We got your report 🙏',
      'Our team is looking into it right now. We will make this right — thank you for telling us.');
    res.status(201).json({ ticket: ticket.rows[0] });
  })
);

// GET /api/orders/:id/invoice — GST invoice data for the customer
router.get(
  '/:id/invoice',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT o.*, r.name AS restaurant_name, r.address AS restaurant_address, r.gstin,
              r.phone AS restaurant_phone
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.id = $1 AND o.customer_id = $2`,
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    res.json({
      invoice: {
        invoice_no: 'MN-' + order.id.slice(0, 8).toUpperCase(),
        date: order.placed_at,
        restaurant: {
          name: order.restaurant_name,
          address: order.restaurant_address,
          phone: order.restaurant_phone,
          gstin: order.gstin
        },
        items: items.rows,
        subtotal_paise: order.subtotal_paise,
        discount_paise: order.discount_paise,
        delivery_fee_paise: order.delivery_fee_paise,
        platform_fee_paise: order.platform_fee_paise,
        tip_paise: order.tip_paise,
        total_paise: order.total_paise,
        payment_method: order.payment_method,
        payment_status: order.payment_status
      }
    });
  })
);

// ---- Razorpay (key-ready; dormant until RAZORPAY_KEY_ID/SECRET are set) ----
// POST /api/orders/:id/razorpay-order — create a Razorpay order for online payment
router.post(
  '/:id/razorpay-order',
  ah(async (req, res) => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return res.status(503).json({ error: 'Online payments are not configured yet' });
    }
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status !== 'pending') {
      return res.status(409).json({ error: `Payment already ${order.payment_status}` });
    }
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    const rpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: order.total_paise,
        currency: 'INR',
        receipt: 'mn_' + order.id.slice(0, 24),
        notes: { mana_order_id: order.id }
      })
    });
    if (!rpRes.ok) {
      return res.status(502).json({ error: 'Payment gateway error. Please try again.' });
    }
    const rpOrder = await rpRes.json();
    res.json({ razorpay_order_id: rpOrder.id, amount_paise: order.total_paise, key_id: keyId });
  })
);

// POST /api/orders/:id/razorpay-verify { razorpay_payment_id, razorpay_order_id, razorpay_signature }
router.post(
  '/:id/razorpay-verify',
  ah(async (req, res) => {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) return res.status(503).json({ error: 'Online payments are not configured yet' });
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body || {};
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment verification data' });
    }
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', keySecret)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest();
    // Timing-safe compare: never short-circuit on the attacker-controlled value.
    const sigBuf = Buffer.from(String(razorpay_signature), 'hex');
    if (expected.length !== sigBuf.length || !crypto.timingSafeEqual(expected, sigBuf)) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }
    const { rows } = await db.query(
      "SELECT * FROM orders WHERE id = $1 AND customer_id = $2 AND payment_status = 'pending'",
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found or already paid' });
    await db.query("UPDATE orders SET payment_status = 'paid', payment_method = 'razorpay' WHERE id = $1", [order.id]);
    await db.query(
      `UPDATE orders SET timeline = COALESCE(timeline, '[]'::jsonb)
         || jsonb_build_object('status', 'paid', 'at', $1, 'by', 'razorpay')
       WHERE id = $2`,
      [new Date().toISOString(), order.id]
    );
    await notify(order.customer_id, 'Payment successful ✅',
      `Rs ${(order.total_paise / 100).toFixed(2)} paid. The kitchen is firing up! 🔥`);
    res.json({ ok: true, payment_status: 'paid' });
  })
);

module.exports = router;
