// Rider portal. A rider only ever sees and touches their own deliveries
// and earnings — enforced in every query by their rider id.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { activateDueScheduledOrders } = require('../lib/scheduled');
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

// ---------- Multi-stop (on-the-way) group helpers ----------
// A customer order with on-the-way secondaries is stored as SPLIT rows:
// one primary (otw_role='primary') + secondaries (otw_role='secondary',
// otw_primary_order_id = primary id). One rider handles the whole group:
// multiple pickups in route order, one final delivery.
// Route order = placement order: primary first, then secondaries by placed_at.

// All rows of a group (primary + secondaries) in route order.
async function groupRows(primaryId) {
  const { rows } = await db.query(
    `SELECT * FROM orders WHERE id = $1 OR otw_primary_order_id = $1
     ORDER BY CASE WHEN otw_role = 'primary' THEN 0 ELSE 1 END, placed_at ASC, id ASC`,
    [primaryId]
  );
  return rows;
}

// Resolve any order row id to its group's primary id.
async function groupPrimaryId(orderId) {
  const { rows } = await db.query(
    'SELECT id, otw_role, otw_primary_order_id FROM orders WHERE id = $1',
    [orderId]
  );
  const o = rows[0];
  if (!o) return null;
  return o.otw_role === 'secondary' && o.otw_primary_order_id
    ? String(o.otw_primary_order_id)
    : String(o.id);
}

// Combined rider payout for a group: primary-leg distance payout plus a flat
// bonus per extra pickup stop (from pricing config, default ₹15).
function groupPayoutPaise(config, primaryDistanceKm, extraStops) {
  const base =
    primaryDistanceKm != null ? riderPayoutPaise(config.riderPayout, primaryDistanceKm) : 3000;
  const bonus = Number(config.riderPayoutExtraStopPaise || 1500);
  return base + Math.max(0, extraStops) * bonus;
}

// Number of ACTIVE delivery groups (not rows) a rider holds — the 3-slot limit.
async function activeGroupCount(riderId) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM orders
     WHERE rider_id = $1 AND status NOT IN ('delivered','cancelled')
       AND (otw_role IS NULL OR otw_role = 'primary')`,
    [riderId]
  );
  return Number(rows[0].n);
}

// True if the rider holds an active multi-restaurant (on-the-way) group.
// A rider on a multi-delivery is locked to it: no other offers, no new accepts.
async function hasActiveMultiDelivery(riderId) {
  const { rows } = await db.query(
    `SELECT 1 FROM orders o
     WHERE o.rider_id = $1 AND o.status NOT IN ('delivered','cancelled')
       AND (o.otw_role IS NULL OR o.otw_role = 'primary')
       AND EXISTS (
         SELECT 1 FROM orders s
         WHERE s.otw_primary_order_id = o.id
           AND s.status NOT IN ('delivered','cancelled')
       )
     LIMIT 1`,
    [riderId]
  );
  return rows.length > 0;
}

// Per-stop detail for a group: restaurant info + items + status + timeline,
// in route order. Stops not assigned to this rider are flagged detached
// (transitional only — cascade accept keeps groups whole going forward).
async function groupStops(primaryId, riderId) {
  const rows = await groupRows(primaryId);
  const stops = [];
  for (const o of rows) {
    const r = await db.query(
      'SELECT id, name, address, phone, lat, lng FROM restaurants WHERE id = $1',
      [o.restaurant_id]
    );
    const items = await db.query(
      'SELECT name_snapshot, qty, unit_price_paise FROM order_items WHERE order_id = $1',
      [o.id]
    );
    const rest = r.rows[0] || {};
    stops.push({
      order_id: o.id,
      restaurant_id: o.restaurant_id,
      restaurant_name: rest.name || 'Restaurant',
      restaurant_address: rest.address || null,
      restaurant_phone: rest.phone || null,
      rest_lat: rest.lat, rest_lng: rest.lng,
      status: o.status,
      timeline: o.timeline || [],
      items: items.rows,
      primary: o.otw_role !== 'secondary',
      detached: String(o.rider_id || '') !== String(riderId),
      pickup_photo: o.pickup_photo || null,
    });
  }
  return stops;
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
  // orderId is a group id: a primary row id (or a standalone row id).
  // Returns the primary's fields plus stops[] for the whole group in route
  // order. Backward compatible: a standalone order yields stops=[itself].
  const primaryId = await groupPrimaryId(orderId);
  if (!primaryId) return null;
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
    [primaryId, riderId]
  );
  const order = rows[0];
  if (!order) return null;
  delete order.delivery_otp_hash;
  const stops = await groupStops(primaryId, riderId);
  const grandTotal = stops.reduce((a, s) => a + (s.items || []).reduce((x, it) => x + Number(it.unit_price_paise || 0) * Number(it.qty || 0), 0), 0);
  const items = await db.query('SELECT name_snapshot, qty, unit_price_paise FROM order_items WHERE order_id = $1', [order.id]);
  return {
    ...order,
    items: items.rows,
    stops,
    stop_count: stops.length,
    grand_total_paise: grandTotal || Number(order.total_paise || 0),
  };
}

// Single stop row belonging to this rider (for per-stop arrived/picked-up).
// Returns { stop, primaryId } or null.
async function stopRow(stopId, riderId) {
  const { rows } = await db.query('SELECT * FROM orders WHERE id = $1 AND rider_id = $2', [stopId, riderId]);
  const stop = rows[0];
  if (!stop) return null;
  const primaryId = stop.otw_role === 'secondary' && stop.otw_primary_order_id
    ? String(stop.otw_primary_order_id) : String(stop.id);
  return { stop, primaryId };
}

// GET /api/rider/deliveries/available — ready orders with no rider yet.
// Sorted nearest-first by rider-to-restaurant distance when the rider's
// location is known (proximity dispatch); oldest first as fallback.
//
// MULTI-STOP: one offer per GROUP (primary row id). Secondary rows never
// appear alone — accepting the primary assigns the whole group to one rider.
// A group is offered only when EVERY non-cancelled stop is 'ready', so the
// rider can run the route without waiting on a kitchen.
router.get(
  '/deliveries/available',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    // Opportunistic activation: a scheduled order whose slot just came due
    // goes live (placed -> ... -> ready) so offers pick it up on time.
    // NOTE: scheduled orders never appear here directly — offers only list
    // status='ready' (see the WHERE below); activation must run first.
    try { await activateDueScheduledOrders(); } catch (e) { console.error('scheduled activation failed:', e.message); }
    // ---- On-the-way rider rules (founder) ----
    // Rule 3 (multi-delivery exclusivity): if the rider holds ANY active
    // multi-restaurant group, they are locked to it — show zero other offers.
    // Rule 1 (1km filter): with single-restaurant active deliveries, only show
    // new offers whose restaurant is within 1km of an active delivery's
    // restaurant. Missing coords never fail closed (offer stays visible).
    const activeGroups = await db.query(
      `SELECT o.id, r.lat AS rest_lat, r.lng AS rest_lng,
              (SELECT COUNT(*) FROM orders s
                 WHERE s.otw_primary_order_id = o.id AND s.status <> 'cancelled') AS secondary_count
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.rider_id = $1 AND o.status NOT IN ('delivered','cancelled')
         AND (o.otw_role IS NULL OR o.otw_role = 'primary')`,
      [rider.id]
    );
    if (activeGroups.rows.some((g) => Number(g.secondary_count) > 0)) {
      return res.json({ deliveries: [], multi_delivery_active: true, on_the_way_filter: false });
    }
    const anchors = activeGroups.rows
      .filter((g) => g.rest_lat != null && g.rest_lng != null)
      .map((g) => ({ lat: Number(g.rest_lat), lng: Number(g.rest_lng) }));
    const onWayFilter = anchors.length > 0;
    const { rows } = await db.query(
      `SELECT o.id, o.total_paise, o.placed_at, o.payment_method, o.otw_group_size,
              r.id AS rest_id, r.name AS restaurant_name, r.address AS rest_address,
              r.lat AS rest_lat, r.lng AS rest_lng,
              a.line1, a.city, a.lat AS addr_lat, a.lng AS addr_lng
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       WHERE o.status = 'ready' AND o.rider_id IS NULL
         AND o.order_type = 'delivery'
         AND (o.otw_role IS NULL OR o.otw_role = 'primary')
       ORDER BY o.placed_at ASC LIMIT 20`
    );
    const config = await loadPricingConfig(db);
    const list = [];
    for (const o of rows) {
      // Gather the group's secondary rows.
      const sec = await db.query(
        `SELECT s.id, s.status, r.name AS restaurant_name, r.address AS rest_address,
                r.lat AS rest_lat, r.lng AS rest_lng
         FROM orders s JOIN restaurants r ON r.id = s.restaurant_id
         WHERE s.otw_primary_order_id = $1
         ORDER BY s.placed_at ASC, s.id ASC`,
        [o.id]
      );
      const liveSecs = sec.rows.filter((s) => s.status !== 'cancelled');
      // Every live stop must be ready — otherwise the group isn't offerable yet.
      if (liveSecs.some((s) => s.status !== 'ready')) continue;
      const stops = [
        { restaurant_id: o.rest_id, restaurant_name: o.restaurant_name, restaurant_address: o.rest_address, primary: true },
        ...liveSecs.map((s) => ({
          restaurant_id: s.restaurant_id, restaurant_name: s.restaurant_name,
          restaurant_address: s.rest_address, primary: false,
        })),
      ];
      const stopCount = stops.length;
      let distanceKm = null;
      let payout = null;
      let pickupKm = null;
      if (o.rest_lat != null && o.rest_lng != null && o.addr_lat != null && o.addr_lng != null) {
        distanceKm = haversineKm(o.rest_lat, o.rest_lng, o.addr_lat, o.addr_lng);
        payout = groupPayoutPaise(config, distanceKm, stopCount - 1);
      }
      // Rider-to-first-pickup distance drives nearest-first sorting
      if (rider.lat != null && rider.lng != null && o.rest_lat != null && o.rest_lng != null) {
        pickupKm = haversineKm(Number(rider.lat), Number(rider.lng), Number(o.rest_lat), Number(o.rest_lng));
      }
      // Rule 1 (1km on-the-way): when the rider already holds deliveries, only
      // surface offers whose restaurant is within 1km of an active delivery's
      // restaurant. Missing coords never hide an offer (fail open).
      if (onWayFilter && o.rest_lat != null && o.rest_lng != null) {
        const near = anchors.some(
          (a) => haversineKm(a.lat, a.lng, Number(o.rest_lat), Number(o.rest_lng)) <= 1.0
        );
        if (!near) continue;
      }
      list.push({
        id: o.id,
        total_paise: o.total_paise,
        placed_at: o.placed_at,
        payment_method: o.payment_method,
        restaurant_name: o.restaurant_name,
        rest_address: o.rest_address,
        address: [o.line1, o.city].filter(Boolean).join(', '),
        distance_km: distanceKm == null ? null : Math.round(distanceKm * 10) / 10,
        pickup_km: pickupKm == null ? null : Math.round(pickupKm * 10) / 10,
        payout_paise: payout,
        stop_count: stopCount,
        stops,
      });
    }
    list.sort((a, b) => {
      if (a.pickup_km != null && b.pickup_km != null) return a.pickup_km - b.pickup_km;
      return new Date(a.placed_at) - new Date(b.placed_at);
    });
    res.json({ deliveries: list, multi_delivery_active: false, on_the_way_filter: onWayFilter });
  })
);

// ---- Scheduled order pre-acceptance (founder) ----
// Riders see future scheduled orders, commit to one now ("Accept for later"),
// and get a reminder 1 hour before it goes live. At activation (30 min lead)
// the group auto-assigns to the committed rider when eligible.

// GET /api/rider/deliveries/scheduled-offers — future scheduled delivery
// orders open for pre-acceptance. One entry per GROUP.
router.get(
  '/deliveries/scheduled-offers',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const { rows } = await db.query(
      `SELECT o.id, o.scheduled_for, o.total_paise, o.payment_method, o.otw_group_size,
              o.scheduled_rider_id,
              r.id AS rest_id, r.name AS restaurant_name, r.address AS rest_address,
              r.lat AS rest_lat, r.lng AS rest_lng,
              a.line1, a.city, a.lat AS addr_lat, a.lng AS addr_lng
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       WHERE o.status = 'scheduled' AND o.order_type = 'delivery'
         AND o.scheduled_for > now()
         AND (o.otw_role IS NULL OR o.otw_role = 'primary')
         AND (o.scheduled_rider_id IS NULL OR o.scheduled_rider_id = $1)
       ORDER BY o.scheduled_for ASC LIMIT 20`,
      [rider.id]
    );
    const config = await loadPricingConfig(db);
    const list = [];
    for (const o of rows) {
      const sec = await db.query(
        `SELECT s.id, s.status, r.name AS restaurant_name, r.address AS rest_address
         FROM orders s JOIN restaurants r ON r.id = s.restaurant_id
         WHERE s.otw_primary_order_id = $1 AND s.status = 'scheduled'
         ORDER BY s.placed_at ASC, s.id ASC`,
        [o.id]
      );
      const stops = [
        { restaurant_id: o.rest_id, restaurant_name: o.restaurant_name, restaurant_address: o.rest_address, primary: true },
        ...sec.rows.map((s) => ({
          restaurant_id: s.restaurant_id, restaurant_name: s.restaurant_name,
          restaurant_address: s.rest_address, primary: false,
        })),
      ];
      const stopCount = stops.length;
      let distanceKm = null;
      let payout = null;
      let pickupKm = null;
      if (o.rest_lat != null && o.rest_lng != null && o.addr_lat != null && o.addr_lng != null) {
        distanceKm = haversineKm(o.rest_lat, o.rest_lng, o.addr_lat, o.addr_lng);
        payout = groupPayoutPaise(config, distanceKm, stopCount - 1);
      }
      if (rider.lat != null && rider.lng != null && o.rest_lat != null && o.rest_lng != null) {
        pickupKm = haversineKm(Number(rider.lat), Number(rider.lng), Number(o.rest_lat), Number(o.rest_lng));
      }
      list.push({
        id: o.id,
        scheduled_for: o.scheduled_for,
        total_paise: o.total_paise,
        payment_method: o.payment_method,
        restaurant_name: o.restaurant_name,
        rest_address: o.rest_address,
        address: [o.line1, o.city].filter(Boolean).join(', '),
        distance_km: distanceKm == null ? null : Math.round(distanceKm * 10) / 10,
        pickup_km: pickupKm == null ? null : Math.round(pickupKm * 10) / 10,
        payout_paise: payout,
        stop_count: stopCount,
        stops,
        pre_accepted_by_me: String(o.scheduled_rider_id) === String(rider.id),
      });
    }
    res.json({ scheduled: list });
  })
);

// POST /api/rider/deliveries/:id/pre-accept — commit to a scheduled order now.
router.post(
  '/deliveries/:id/pre-accept',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    if (!rider.online) return res.status(409).json({ error: 'Go online to accept scheduled deliveries' });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT * FROM orders WHERE id = $1 AND status = 'scheduled'
           AND order_type = 'delivery'
           AND (otw_role IS NULL OR otw_role = 'primary') FOR UPDATE`,
        [req.params.id]
      );
      const order = rows[0];
      if (!order) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Scheduled order no longer available' });
      }
      if (order.scheduled_rider_id && String(order.scheduled_rider_id) !== String(rider.id)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Another rider already accepted this scheduled order' });
      }
      if (order.scheduled_rider_id && String(order.scheduled_rider_id) === String(rider.id)) {
        await client.query('ROLLBACK');
        return res.json({ ok: true, already: true });
      }
      // Overlap warning: another pre-accepted scheduled order within 2 hours.
      const ov = await client.query(
        `SELECT id FROM orders
         WHERE scheduled_rider_id = $1 AND status = 'scheduled' AND id <> $2
           AND ABS(EXTRACT(EPOCH FROM (scheduled_for - $3::timestamptz))) < 7200
         LIMIT 1`,
        [rider.id, order.id, order.scheduled_for]
      );
      await client.query(
        `UPDATE orders SET scheduled_rider_id = $1, scheduled_rider_at = now(), rider_reminded = false
         WHERE id = $2`,
        [rider.id, order.id]
      );
      await client.query('COMMIT');
      const { formatKolkata } = require('../lib/scheduled');
      await notify(rider.user_id, '✅ Scheduled delivery accepted',
        `We'll remind you 1 hour before your scheduled delivery (${formatKolkata(order.scheduled_for)}).`);
      res.json({ ok: true, overlap_warning: ov.rows.length > 0 });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw e;
    } finally {
      client.release();
    }
  })
);

// POST /api/rider/deliveries/:id/pre-cancel — release my pre-acceptance.
router.post(
  '/deliveries/:id/pre-cancel',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const { rows } = await db.query(
      `UPDATE orders SET scheduled_rider_id = NULL, scheduled_rider_at = NULL, rider_reminded = false
       WHERE id = $1 AND scheduled_rider_id = $2 AND status = 'scheduled'
       RETURNING id`,
      [req.params.id, rider.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Scheduled delivery not found' });
    res.json({ ok: true });
  })
);

// GET /api/rider/deliveries/my-scheduled — scheduled orders I pre-accepted.
router.get(
  '/deliveries/my-scheduled',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const { rows } = await db.query(
      `SELECT o.id, o.scheduled_for, o.total_paise, o.payment_method,
              r.name AS restaurant_name, r.address AS rest_address,
              a.line1, a.city
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       WHERE o.scheduled_rider_id = $1 AND o.status = 'scheduled'
         AND (o.otw_role IS NULL OR o.otw_role = 'primary')
       ORDER BY o.scheduled_for ASC LIMIT 20`,
      [rider.id]
    );
    res.json({
      scheduled: rows.map((o) => ({
        id: o.id,
        scheduled_for: o.scheduled_for,
        total_paise: o.total_paise,
        payment_method: o.payment_method,
        restaurant_name: o.restaurant_name,
        rest_address: o.rest_address,
        address: [o.line1, o.city].filter(Boolean).join(', '),
      })),
    });
  })
);

// GET /api/rider/notifications — unread notifications for the rider.
router.get(
  '/notifications',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const { rows } = await db.query(
      `SELECT id, title, body, created_at FROM notifications
       WHERE user_id = $1 AND (read = false OR read IS NULL)
       ORDER BY created_at DESC LIMIT 20`,
      [rider.user_id]
    );
    res.json({ notifications: rows });
  })
);

// POST /api/rider/notifications/read { ids: [] } — mark as read.
router.post(
  '/notifications/read',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const ids = Array.isArray(req.body.ids) ? req.body.ids.filter(Boolean) : [];
    if (ids.length) {
      await db.query(
        `UPDATE notifications SET read = true WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [rider.user_id, ids]
      );
    }
    res.json({ ok: true });
  })
);

// GET /api/rider/deliveries?status=active — my deliveries, ONE entry per
// GROUP (a multi-stop order counts as one delivery slot, not N rows).
router.get(
  '/deliveries',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    let where = 'o.rider_id = $1 AND (o.otw_role IS NULL OR o.otw_role = \'primary\')';
    const params = [rider.id];
    if (req.query.status === 'active') {
      where += " AND o.status NOT IN ('delivered','cancelled')";
    } else if (req.query.status) {
      params.push(req.query.status);
      where += ` AND o.status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT o.id, o.status, o.total_paise, o.placed_at, r.name AS restaurant_name,
              o.otw_role, o.otw_primary_order_id, o.otw_group_size,
              (SELECT COUNT(*) FROM orders s
                 WHERE s.otw_primary_order_id = o.id AND s.status <> 'cancelled') AS secondary_count
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

// POST /api/rider/deliveries/:id/accept — accepts a whole GROUP (primary +
// its secondaries) in one transaction: one rider, multiple pickups, one
// delivery. Accepting a secondary row directly is rejected. The 3-slot
// limit counts groups, not rows.
router.post(
  '/deliveries/:id/accept',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    if (!rider.online) return res.status(409).json({ error: 'Go online to accept deliveries' });
    // Multi-delivery lock: a rider on a multi-restaurant order cannot accept more.
    if (await hasActiveMultiDelivery(rider.id)) {
      return res.status(409).json({ error: 'You are on a multi-restaurant delivery — complete it before accepting new orders' });
    }
    // Max 3 concurrent active delivery GROUPS per rider.
    if ((await activeGroupCount(rider.id)) >= 3) {
      return res.status(409).json({ error: 'You already have 3 active deliveries — complete one first' });
    }
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `SELECT * FROM orders WHERE id = $1 AND status = 'ready' AND rider_id IS NULL
           AND (otw_role IS NULL OR otw_role = 'primary') FOR UPDATE`,
        [req.params.id]
      );
      const order = rows[0];
      if (!order) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Delivery no longer available' });
      }
      const _md = await client.query(
        `SELECT 1 FROM orders o
         WHERE o.rider_id = $1 AND o.status NOT IN ('delivered','cancelled')
           AND (o.otw_role IS NULL OR o.otw_role = 'primary')
           AND EXISTS (
             SELECT 1 FROM orders s
             WHERE s.otw_primary_order_id = o.id
               AND s.status NOT IN ('delivered','cancelled')
           )
         LIMIT 1`,
        [rider.id]
      );
      if (_md.rows.length) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'You are on a multi-restaurant delivery — complete it before accepting new orders' });
      }
      if ((await activeGroupCount(rider.id)) >= 3) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'You already have 3 active deliveries — complete one first' });
      }
      const now = new Date().toISOString();
      // Assign the primary AND every live secondary of the group to this rider.
      const upd = await client.query(
        `UPDATE orders SET rider_id = $1,
           timeline = COALESCE(timeline, '[]'::jsonb)
             || jsonb_build_object('status', 'rider_assigned', 'at', $3::text, 'by', 'rider')
         WHERE (id = $2 OR otw_primary_order_id = $2)
           AND status = 'ready' AND rider_id IS NULL AND status <> 'cancelled'
         RETURNING id, otw_role`,
        [rider.id, req.params.id, now]
      );
      await client.query('COMMIT');
      const stopCount = upd.rows.length;
      await notify(order.customer_id, 'Rider assigned', 'Your rider is on the way to the restaurant.');
      res.json({ ok: true, stop_count: stopCount });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
      throw e;
    } finally {
      client.release();
    }
  })
);

// POST /api/rider/deliveries/:id/cancel { reason? } — rider releases the
// delivery. Only before ANY pickup: the whole group returns to the available
// pool for another rider.
router.post(
  '/deliveries/:id/cancel',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const primaryId = await groupPrimaryId(req.params.id);
    if (!primaryId) return res.status(404).json({ error: 'Delivery not found' });
    const rows = await groupRows(primaryId);
    const mine = rows.filter((o) => String(o.rider_id) === String(rider.id));
    if (!mine.length) return res.status(404).json({ error: 'Delivery not found' });
    if (mine.some((o) => !['ready'].includes(o.status))) {
      return res.status(409).json({ error: 'Too late to cancel — the food is already picked up' });
    }
    const timeline = (rows[0].timeline || []);
    timeline.push({
      status: 'rider_cancelled', at: new Date().toISOString(), by: 'rider',
      reason: req.body.reason || 'Rider cancelled'
    });
    await db.query(
      `UPDATE orders SET rider_id = NULL, timeline = $1::jsonb
       WHERE (id = $2 OR otw_primary_order_id = $2) AND rider_id = $3`,
      [JSON.stringify(timeline), primaryId, rider.id]
    );
    await db.query(
      'UPDATE riders SET cancelled_deliveries = COALESCE(cancelled_deliveries, 0) + 1 WHERE id = $1',
      [rider.id]
    );
    await notify(rows[0].customer_id, 'Finding you another rider 🛵',
      'Your rider had to step away — we\u2019re assigning a new one right now.');
    res.json({ ok: true });
  })
);

// POST /api/rider/deliveries/:stopId/flag-issue { reason } — rider reports a
// problem with one pickup stop (kitchen closed, unreachable, wrong items…).
// The stop is flagged on its timeline and every admin is notified. The order
// is NOT silently dropped: the stop stays visible in the rail as failed and
// the rider continues with the remaining stops; admin follows up.
router.post(
  '/deliveries/:id/flag-issue',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const found = await stopRow(req.params.id, rider.id);
    if (!found) return res.status(404).json({ error: 'Delivery not found' });
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 280);
    if (!reason) return res.status(400).json({ error: 'Tell us what went wrong at this stop' });
    const timeline = found.stop.timeline || [];
    timeline.push({
      status: 'stop_issue', at: new Date().toISOString(), by: 'rider', reason,
    });
    await db.query('UPDATE orders SET timeline = $1::jsonb WHERE id = $2', [
      JSON.stringify(timeline), found.stop.id
    ]);
    const rname = rider.name || 'Rider';
    const admins = await db.query("SELECT id FROM users WHERE role = 'admin'");
    const stopName = found.stop.restaurant_id || 'a pickup stop';
    await Promise.all(admins.rows.map((a) =>
      notify(a.id, 'Rider stop issue — ' + rname,
        `${rname} flagged a problem at stop ${stopName} (order ${found.primaryId}): ${reason}`)
    ));
    res.json({ ok: true });
  })
);

// PUT /api/rider/deliveries/:stopId/arrived-restaurant — per pickup stop.
// :stopId is the stop's own order row id (primary or secondary).
router.put(
  '/deliveries/:id/arrived-restaurant',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const found = await stopRow(req.params.id, rider.id);
    if (!found) return res.status(404).json({ error: 'Delivery not found' });
    if (found.stop.status !== 'ready') return res.status(409).json({ error: `Invalid status ${found.stop.status}` });
    const timeline = found.stop.timeline || [];
    timeline.push({ status: 'arrived_restaurant', at: new Date().toISOString(), by: 'rider' });
    await db.query('UPDATE orders SET timeline = $1::jsonb WHERE id = $2', [
      JSON.stringify(timeline), found.stop.id
    ]);
    res.json({ ok: true });
  })
);

// PUT /api/rider/deliveries/:stopId/picked-up { photo } — per pickup stop.
// Pickup photo (image data URL, max ~1.5MB) is REQUIRED and is shown to the
// customer on live tracking as proof of packed-food pickup.
// The delivery OTP is generated only when the LAST stop is picked up, so the
// customer gets a single OTP notification for the whole multi-stop order.
router.put(
  '/deliveries/:id/picked-up',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const found = await stopRow(req.params.id, rider.id);
    if (!found) return res.status(404).json({ error: 'Delivery not found' });
    if (found.stop.status !== 'ready') return res.status(409).json({ error: `Invalid status ${found.stop.status}` });

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

    await db.query('UPDATE orders SET pickup_photo = $1 WHERE id = $2', [photo, found.stop.id]);
    await transition(found.stop.id, 'picked_up', 'rider');

    // Last stop picked up? Generate the single delivery OTP on the primary
    // and notify the customer once. (Single-stop orders: this stop IS the last.)
    const grp = await groupRows(found.primaryId);
    const mine = grp.filter((o) => String(o.rider_id) === String(rider.id) && o.status !== 'cancelled');
    if (mine.length && mine.every((o) => o.status === 'picked_up')) {
      // OTP is generated at order placement now; this is a fallback for
      // orders placed before that change.
      const ex = await db.query('SELECT delivery_otp, delivery_otp_hash FROM orders WHERE id = $1', [found.primaryId]);
      if (!ex.rows[0] || !ex.rows[0].delivery_otp_hash) {
        const code = newDeliveryOtp();
        const hash = await bcrypt.hash(code, 8);
        await db.query('UPDATE orders SET delivery_otp = $1, delivery_otp_hash = $2 WHERE id = $3', [code, hash, found.primaryId]);
        const cust = grp[0].customer_id;
        await notify(cust, 'Your delivery OTP',
          `Your rider has picked up the order. Share this OTP to receive it: ${code}`);
      }
    }
    res.json({ ok: true, status: 'picked_up' });
  })
);

// PUT /api/rider/deliveries/:id/arrived-customer — :id is the group (primary)
// id. For multi-stop groups every stop must be picked up first.
router.put(
  '/deliveries/:id/arrived-customer',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const detail = await deliveryDetail(req.params.id, rider.id);
    if (!detail) return res.status(404).json({ error: 'Delivery not found' });
    if (detail.status !== 'picked_up') return res.status(409).json({ error: `Invalid status ${detail.status}` });
    const open = (detail.stops || []).filter(
      (s) => !s.detached && s.status !== 'cancelled' && s.status !== 'picked_up'
    );
    if (open.length) {
      return res.status(409).json({ error: 'Pick up every stop before heading to the customer' });
    }
    await transition(detail.id, 'on_way', 'rider');
    res.json({ ok: true, status: 'on_way' });
  })
);

// POST /api/rider/deliveries/:id/complete { otp } — :id is the group
// (primary) id. Completes the whole group: every stop cascades to
// 'delivered', one combined payout is credited, and COD validates against
// the GRAND total across all stops.
router.post(
  '/deliveries/:id/complete',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    const detail = await deliveryDetail(req.params.id, rider.id);
    if (!detail) return res.status(404).json({ error: 'Delivery not found' });
    const order = detail;
    if (order.status !== 'on_way') return res.status(409).json({ error: `Invalid status ${order.status}` });
    const stops = (detail.stops || []).filter((s) => !s.detached && s.status !== 'cancelled');
    if (stops.some((s) => s.status !== 'picked_up')) {
      return res.status(409).json({ error: 'Pick up every stop before completing the delivery' });
    }
    if (!order.delivery_otp_hash || !(await bcrypt.compare(String(req.body.otp || ''), order.delivery_otp_hash))) {
      return res.status(400).json({ error: 'Invalid delivery OTP' });
    }

    // Grand total across the group's stops — this is the cash to collect.
    const grandTotal = stops.reduce(
      (a, s) => a + (s.items || []).reduce((x, it) => x + Number(it.unit_price_paise || 0) * Number(it.qty || 0), 0), 0
    ) || Number(order.total_paise || 0);

    // Compute combined payout from live pricing config: primary-leg distance
    // payout plus the flat per-extra-stop bonus.
    const loc = await db.query(
      `SELECT r.lat AS rest_lat, r.lng AS rest_lng, a.lat AS addr_lat, a.lng AS addr_lng
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id WHERE o.id = $1`,
      [order.id]
    );
    const l = loc.rows[0];
    const config = await loadPricingConfig(db);
    let distanceKm = null;
    if (l.rest_lat != null && l.rest_lng != null && l.addr_lat != null && l.addr_lng != null) {
      distanceKm = haversineKm(l.rest_lat, l.rest_lng, l.addr_lat, l.addr_lng);
    }
    const extraStops = Math.max(0, stops.length - 1);
    const payout = distanceKm != null
      ? groupPayoutPaise(config, distanceKm, extraStops)
      : 3000 + extraStops * Number(config.riderPayoutExtraStopPaise || 1500);

    // COD: validate cash collection BEFORE any mutation — a failed confirmation
    // must not leave the order marked delivered with money uncollected.
    const cod = order.payment_method === 'cod' && order.payment_status === 'pending';
    let paymentStatus = order.payment_status;
    let cashPaise = 0;
    if (cod) {
      const cashConfirmed = req.body.cash_confirmed === true;
      cashPaise = Math.round(Number(req.body.cash_amount_paise) || 0);
      if (!cashConfirmed || cashPaise !== Number(grandTotal)) {
        return res.status(400).json({
          error: `Please confirm you collected exactly Rs ${(grandTotal / 100).toFixed(2)} in cash`
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
    // Cascade delivered across the whole group.
    for (const s of stops) {
      await transition(s.order_id, 'delivered', 'rider');
    }

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
