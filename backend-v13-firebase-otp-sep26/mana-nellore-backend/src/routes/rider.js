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

// Award quest bonuses a rider has just earned. Idempotent: one bonus per rider per quest.
async function checkQuests(riderId) {
  const quests = await db.query(
    `SELECT * FROM quests WHERE active = true AND now() BETWEEN starts_at AND ends_at`
  );
  for (const q of quests.rows) {
    const done = await db.query(
      `SELECT COUNT(*) AS n FROM orders
       WHERE rider_id = $1 AND status = 'delivered' AND delivered_at BETWEEN $2 AND $3`,
      [riderId, q.starts_at, q.ends_at]
    );
    if (Number(done.rows[0].n) >= q.target_deliveries) {
      await db.query(
        `INSERT INTO rider_bonuses (rider_id, quest_id, amount_paise)
         VALUES ($1, $2, $3) ON CONFLICT (rider_id, quest_id) DO NOTHING`,
        [riderId, q.id, q.bonus_paise]
      );
    }
  }
}

async function transition(orderId, status, by) {
  // Single UPDATE with a jsonb append: concurrent transitions can no longer
  // silently drop each other's timeline entries (read-modify-write race).
  await db.query(
    `UPDATE orders SET status = $1,
       timeline = COALESCE(timeline, '[]'::jsonb)
                || jsonb_build_object('status', $1::text, 'at', $2::text, 'by', $3::text)
     WHERE id = $4`,
    [status, new Date().toISOString(), by, orderId]
  );
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

// PUT /api/rider/profile { name, vehicle_type, vehicle_number, licence_no, aadhaar_no, aadhaar_photo, profile_photo }
router.put(
  '/profile',
  ah(async (req, res) => {
    const { name, vehicle_type, vehicle_number, licence_no, aadhaar_no, aadhaar_photo, profile_photo } = req.body;
    // Update user name if provided
    if (name && String(name).trim()) {
      await db.query('UPDATE users SET name = $1 WHERE id = $2', [String(name).trim().slice(0, 60), req.user.id]);
    }
    const checkPhoto = (p) => {
      if (p == null) return null;
      const s = String(p);
      const okPrefix = s.startsWith('data:image/') || s.startsWith('http');
      if (!okPrefix || s.length > 1500000) {
        const err = new Error('Photo must be an image under ~1.5MB.');
        err.status = 400;
        throw err;
      }
      return s;
    };
    const { rows } = await db.query(
      `UPDATE riders SET vehicle_type = COALESCE($1, vehicle_type),
                         vehicle_number = COALESCE($2, vehicle_number),
                         licence_no = COALESCE($3, licence_no),
                         aadhaar_no = COALESCE($4, aadhaar_no),
                         aadhaar_photo = COALESCE($5, aadhaar_photo),
                         profile_photo = COALESCE($6, profile_photo),
                         status = CASE WHEN status IN ('rejected','suspended') THEN 'pending' ELSE status END
       WHERE user_id = $7 RETURNING *`,
      [
        vehicle_type || null,
        vehicle_number || null,
        licence_no || null,
        aadhaar_no || null,
        checkPhoto(aadhaar_photo),
        checkPhoto(profile_photo),
        req.user.id,
      ]
    );
    const uRows = await db.query('SELECT id, phone, name FROM users WHERE id = $1', [req.user.id]);
    res.json({ rider: { ...rows[0], user: uRows.rows[0] } });
  })
);

// PUT /api/rider/online { online }
router.put(
  '/online',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    // A rider holding active deliveries may never go offline mid-delivery.
    if (req.body.online === false) {
      const active = await db.query(
        "SELECT COUNT(*) AS n FROM orders WHERE rider_id = $1 AND status NOT IN ('delivered','cancelled')",
        [rider.id]
      );
      if (Number(active.rows[0].n) > 0) {
        return res.status(409).json({ error: 'Finish your active deliveries before going offline' });
      }
    }
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
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln) || Math.abs(la) > 90 || Math.abs(ln) > 180) {
      return res.status(400).json({ error: 'Invalid lat/lng' });
    }
    await db.query('UPDATE riders SET lat = $1, lng = $2 WHERE id = $3', [la, ln, rider.id]);
    res.json({ ok: true });
  })
);

// POST /api/rider/sos { lat, lng } — one-tap emergency alert to admin
router.post(
  '/sos',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const lat = req.body && req.body.lat != null ? Number(req.body.lat) : null;
    const lng = req.body && req.body.lng != null ? Number(req.body.lng) : null;
    await db.query(
      'INSERT INTO sos_alerts (rider_id, lat, lng) VALUES ($1, $2, $3)',
      [rider.id, Number.isFinite(lat) ? lat : null, Number.isFinite(lng) ? lng : null]
    );
    // Push a notification to every admin user as well.
    const admins = await db.query("SELECT id FROM users WHERE role = 'admin'");
    const rname = rider.name || 'Rider';
    await Promise.all(admins.rows.map(a =>
      notify(a.id, 'RIDER SOS — ' + rname, 'Emergency alert from rider ' + rname + '. Check SOS alerts immediately.')
    ));
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

// GET /api/rider/deliveries/available — ready orders with no rider yet.
// Sorted nearest-first by rider-to-restaurant distance when the rider's
// location is known (proximity dispatch); oldest first as fallback.
router.get(
  '/deliveries/available',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const { rows } = await db.query(
      `SELECT o.id, o.total_paise, o.placed_at, o.payment_method,
              r.name AS restaurant_name, r.lat AS rest_lat, r.lng AS rest_lng,
              a.line1, a.city, a.lat AS addr_lat, a.lng AS addr_lng
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       WHERE o.status = 'ready' AND o.rider_id IS NULL
         AND o.order_type = 'delivery'
       ORDER BY o.placed_at ASC LIMIT 20`
    );
    const config = await loadPricingConfig(db);
    const list = rows.map((o) => {
      let distanceKm = null;
      let payout = null;
      let pickupKm = null;
      if (o.rest_lat != null && o.rest_lng != null && o.addr_lat != null && o.addr_lng != null) {
        distanceKm = haversineKm(o.rest_lat, o.rest_lng, o.addr_lat, o.addr_lng);
        payout = riderPayoutPaise(config.riderPayout, distanceKm);
      }
      // Rider-to-restaurant distance drives nearest-first sorting
      if (rider.lat != null && rider.lng != null && o.rest_lat != null && o.rest_lng != null) {
        pickupKm = haversineKm(Number(rider.lat), Number(rider.lng), Number(o.rest_lat), Number(o.rest_lng));
      }
      return {
        id: o.id,
        total_paise: o.total_paise,
        placed_at: o.placed_at,
        payment_method: o.payment_method,
        restaurant_name: o.restaurant_name,
        address: [o.line1, o.city].filter(Boolean).join(', '),
        distance_km: distanceKm == null ? null : Math.round(distanceKm * 10) / 10,
        pickup_km: pickupKm == null ? null : Math.round(pickupKm * 10) / 10,
        payout_paise: payout
      };
    });
    list.sort((a, b) => {
      if (a.pickup_km != null && b.pickup_km != null) return a.pickup_km - b.pickup_km;
      return new Date(a.placed_at) - new Date(b.placed_at);
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
    // Max 3 concurrent active deliveries per rider.
    const active = await db.query(
      "SELECT COUNT(*) AS n FROM orders WHERE rider_id = $1 AND status NOT IN ('delivered','cancelled')",
      [rider.id]
    );
    if (Number(active.rows[0].n) >= 3) {
      return res.status(409).json({ error: 'You already have 3 active deliveries — complete one first' });
    }
    const { rows } = await db.query(
      `UPDATE orders SET rider_id = $1,
         timeline = COALESCE(timeline, '[]'::jsonb)
           || jsonb_build_object('status', 'rider_assigned', 'at', $3::text, 'by', 'rider')
       WHERE id = $2 AND status = 'ready' AND rider_id IS NULL
         AND (SELECT COUNT(*) FROM orders o
              WHERE o.rider_id = $1 AND o.status NOT IN ('delivered', 'cancelled')) < 3
       RETURNING *`,
      [rider.id, req.params.id, new Date().toISOString()]
    );
    const order = rows[0];
    if (!order) return res.status(409).json({ error: 'Delivery no longer available' });
    await notify(order.customer_id, 'Rider assigned', 'Your rider is on the way to the restaurant.');
    res.json({ ok: true });
  })
);

// POST /api/rider/deliveries/:id/cancel { reason? } — rider releases the delivery.
// Only before pickup: the order returns to the available pool for another rider.
router.post(
  '/deliveries/:id/cancel',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND rider_id = $2',
      [req.params.id, rider.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Delivery not found' });
    if (!['ready'].includes(order.status)) {
      return res.status(409).json({ error: 'Too late to cancel — the food is already picked up' });
    }
    const timeline = order.timeline || [];
    timeline.push({
      status: 'rider_cancelled', at: new Date().toISOString(), by: 'rider',
      reason: req.body.reason || 'Rider cancelled'
    });
    await db.query(
      'UPDATE orders SET rider_id = NULL, timeline = $1::jsonb WHERE id = $2',
      [JSON.stringify(timeline), order.id]
    );
    await db.query(
      'UPDATE riders SET cancelled_deliveries = COALESCE(cancelled_deliveries, 0) + 1 WHERE id = $1',
      [rider.id]
    );
    await notify(order.customer_id, 'Finding you another rider 🛵',
      'Your rider had to step away — we\u2019re assigning a new one right now.');
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

// PUT /api/rider/deliveries/:id/picked-up { photo } — generates the delivery OTP
// for the customer. Pickup photo (image data URL, max ~1.5MB) is REQUIRED and
// is shown to the customer on live tracking as proof of packed-food pickup.
router.put(
  '/deliveries/:id/picked-up',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const detail = await deliveryDetail(req.params.id, rider.id);
    if (!detail) return res.status(404).json({ error: 'Delivery not found' });
    if (detail.status !== 'ready') return res.status(409).json({ error: `Invalid status ${detail.status}` });

    let photo = null;
    if (req.body.photo != null) {
      photo = String(req.body.photo);
      const okPrefix = photo.startsWith('data:image/') || photo.startsWith('http');
      if (!okPrefix || photo.length > 1500000) {
        return res.status(400).json({ error: 'Photo must be an image under ~1.5MB' });
      }
    }

    if (!photo) {
      return res.status(400).json({ error: 'A pickup photo is required to confirm pickup' });
    }

    const code = newDeliveryOtp();
    const hash = await bcrypt.hash(code, 8);
    await db.query('UPDATE orders SET delivery_otp_hash = $1, pickup_photo = $2 WHERE id = $3',
      [hash, photo, detail.id]);
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
      return res.status(400).json({ error: 'Invalid delivery OTP' });
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

    // COD: validate cash collection BEFORE any mutation — a failed confirmation
    // must not leave the order marked delivered with money uncollected.
    const cod = order.payment_method === 'cod' && order.payment_status === 'pending';
    let paymentStatus = order.payment_status;
    let cashPaise = 0;
    if (cod) {
      const cashConfirmed = req.body.cash_confirmed === true;
      cashPaise = Math.round(Number(req.body.cash_amount_paise) || 0);
      if (!cashConfirmed || cashPaise !== Number(order.total_paise)) {
        return res.status(400).json({
          error: `Please confirm you collected exactly Rs ${(order.total_paise / 100).toFixed(2)} in cash`
        });
      }
      paymentStatus = 'collected';
    }

    await db.query(
      `INSERT INTO rider_payouts (rider_id, order_id, amount_paise, distance_km)
       VALUES ($1, $2, $3, $4) ON CONFLICT (order_id) DO NOTHING`,
      [rider.id, order.id, payout, distanceKm]
    );
    if (cod) {
      await db.query(
        `INSERT INTO rider_cod_ledger (rider_id, order_id, amount_paise)
         VALUES ($1, $2, $3) ON CONFLICT (order_id) DO NOTHING`,
        [rider.id, order.id, cashPaise]
      );
    }
    await transition(order.id, 'delivered', 'rider');

    let deliveryPhoto = null;
    if (req.body.delivery_photo) {
      deliveryPhoto = String(req.body.delivery_photo);
      const okPrefix = deliveryPhoto.startsWith('data:image/') || deliveryPhoto.startsWith('http');
      if (!okPrefix || deliveryPhoto.length > 1500000) {
        return res.status(400).json({ error: 'Photo must be an image under ~1.5MB' });
      }
    }
    if (deliveryPhoto) {
      await db.query(
        'UPDATE orders SET delivered_at = now(), payment_status = $1, delivery_photo = $2 WHERE id = $3',
        [paymentStatus, deliveryPhoto, order.id]
      );
    } else {
      await db.query(
        'UPDATE orders SET delivered_at = now(), payment_status = $1 WHERE id = $3',
        [paymentStatus, order.id]
      );
    }

    await notify(order.customer_id, 'Delivered! 🍽️',
      'Wash your hands — your food is here! Enjoy every bite. Loved it? Tap to rate ⭐');
    await checkQuests(rider.id);
    res.json({ ok: true, status: 'delivered', payout_paise: payout });
  })
);

// GET /api/rider/cod-balance — cash in hand vs earnings vs amount owed
router.get(
  '/cod-balance',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const cash = await db.query(
      `SELECT COALESCE(SUM(amount_paise), 0) AS s FROM rider_cod_ledger
       WHERE rider_id = $1 AND settled = false`, [rider.id]
    );
    const earn = await db.query(
      `SELECT COALESCE(SUM(amount_paise), 0) AS s FROM rider_payouts
       WHERE rider_id = $1 AND status = 'pending'`, [rider.id]
    );
    const cashInHand = Number(cash.rows[0].s);
    const pendingEarnings = Number(earn.rows[0].s);
    res.json({
      cash_in_hand_paise: cashInHand,
      pending_earnings_paise: pendingEarnings,
      // What the rider owes the company: cash collected minus their earnings
      owes_company_paise: cashInHand - pendingEarnings
    });
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

// GET /api/rider/quests — active quests with my progress and bonus status
router.get(
  '/quests',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const quests = await db.query(
      `SELECT q.*, b.id AS bonus_id
       FROM quests q
       LEFT JOIN rider_bonuses b ON b.quest_id = q.id AND b.rider_id = $1
       WHERE q.active = true AND now() BETWEEN q.starts_at AND q.ends_at
       ORDER BY q.ends_at ASC`,
      [rider.id]
    );
    const out = [];
    for (const q of quests.rows) {
      const done = await db.query(
        `SELECT COUNT(*) AS n FROM orders
         WHERE rider_id = $1 AND status = 'delivered' AND delivered_at BETWEEN $2 AND $3`,
        [rider.id, q.starts_at, q.ends_at]
      );
      out.push({
        id: q.id,
        name: q.name,
        target_deliveries: q.target_deliveries,
        bonus_paise: q.bonus_paise,
        starts_at: q.starts_at,
        ends_at: q.ends_at,
        completed: Number(done.rows[0].n),
        bonus_earned: !!q.bonus_id
      });
    }
    res.json({ quests: out });
  })
);

module.exports = router;
