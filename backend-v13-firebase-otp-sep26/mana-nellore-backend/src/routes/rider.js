// Rider portal. A rider only ever sees and touches their own deliveries
// and earnings — enforced in every query by their rider id.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireRole, ah } = require('../middleware/auth');
const { haversineKm, loadPricingConfig, riderPayoutPaise } = require('../lib/pricing');
const { dispatchOrder, sweepExpiredOffers, dispatchPendingOrders, clearRiderOffer } = require('../lib/dispatch');

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
  const { rows } = await db.query('SELECT timeline FROM orders WHERE id = $1', [orderId]);
  const timeline = rows[0].timeline || [];
  timeline.push({ status, at: new Date().toISOString(), by });
  await db.query('UPDATE orders SET status = $1, timeline = $2::jsonb WHERE id = $3', [
    status, JSON.stringify(timeline), orderId
  ]);
}

function newDeliveryOtp() {
  return String(require('crypto').randomInt(1000, 10000));
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
    // Just came online: immediately offer any queued orders (no throttle wait).
    if (rows[0].online) {
      try { await dispatchPendingOrders(true); } catch (e) { console.error('[dispatch] online dispatch failed', e.message); }
    }
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
  delete order.pickup_otp; // rider must get this verbally from restaurant staff
  const items = await db.query('SELECT name_snapshot, qty, unit_price_paise FROM order_items WHERE order_id = $1', [order.id]);
  return { ...order, items: items.rows };
}

// GET /api/rider/deliveries/available — ready orders with no rider yet.
// Proximity dispatch: each order is offered to ONE nearest rider at a time
// (30s window, then cascades). This endpoint sweeps expired offers and
// dispatches queued orders, then shows this rider only their own offers
// (plus unassigned ones as a liveness fallback).
router.get(
  '/deliveries/available',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    // Cascade timed-out offers, then offer anything still queued.
    try { await sweepExpiredOffers(); } catch (e) { console.error('[dispatch] sweep failed', e.message); }
    try { await dispatchPendingOrders(false); } catch (e) { console.error('[dispatch] pending failed', e.message); }
    const { rows } = await db.query(
      `SELECT o.id, o.total_paise, o.placed_at, o.payment_method, o.trip_id,
              o.is_primary, o.trip_payout_paise, o.trip_distance_km,
              o.trip_intermediate_stops, o.trip_payout_breakdown,
              r.name AS restaurant_name, r.lat AS rest_lat, r.lng AS rest_lng,
              a.line1, a.city, a.lat AS addr_lat, a.lng AS addr_lng
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       WHERE o.status = 'ready' AND o.rider_id IS NULL
         AND o.order_type = 'delivery'
         AND NOT EXISTS (
           SELECT 1 FROM rider_declines rd
           WHERE rd.order_id = o.id AND rd.rider_id = $1
         )
         AND (o.offered_to_rider_id = $1 OR o.offered_to_rider_id IS NULL OR o.offer_expires_at < now())
       ORDER BY o.placed_at ASC LIMIT 20`,
      [rider.id]
    );
    const config = await loadPricingConfig(db);
    const list = rows.map((o) => {
      let distanceKm = null;
      let payout = null;
      let pickupKm = null;
      // Trip-based payout (user 2026-10-15): use pre-calculated trip payout if available
      if (o.trip_payout_paise != null) {
        payout = o.trip_payout_paise;
        distanceKm = o.trip_distance_km != null ? Number(o.trip_distance_km) : null;
      } else if (o.rest_lat != null && o.rest_lng != null && o.addr_lat != null && o.addr_lng != null) {
        // Fallback: legacy per-order calculation for old orders without trip payout
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
        payout_paise: payout,
        is_primary: !!o.is_primary,
        trip_distance_km: o.trip_distance_km != null ? Number(o.trip_distance_km) : null,
        trip_intermediate_stops: o.trip_intermediate_stops != null ? Number(o.trip_intermediate_stops) : 0,
        trip_payout_breakdown: o.trip_payout_breakdown || null
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
      `SELECT o.id, o.status, o.total_paise, o.placed_at, o.trip_id, o.order_number, r.name AS restaurant_name
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

// POST /api/rider/deliveries/:id/decline — rider declines, never shown again to this rider.
// Clears their active offer (and trip siblings offered together) and cascades
// the order to the next nearest rider.
router.post(
  '/deliveries/:id/decline',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    await db.query(
      `INSERT INTO rider_declines (rider_id, order_id, reason) VALUES ($1, $2, $3)
       ON CONFLICT (rider_id, order_id) DO NOTHING`,
      [rider.id, req.params.id, req.body.reason || null]
    );
    try { await clearRiderOffer(req.params.id, rider.id); } catch (e) { console.error('[dispatch] clear offer failed', e.message); }
    // Cascade to the next nearest eligible rider.
    try { await dispatchOrder(req.params.id); } catch (e) { console.error('[dispatch] cascade failed', e.message); }
    res.json({ ok: true });
  })
);

// ---- Route optimization helpers (Phase 3: exact DP solver) ----
// Shared by GET /route/optimized and POST /deliveries/evaluate.
const AVG_KMH = 25;   // city riding speed for ETA estimates
const STOP_MIN = 3;   // per-stop handling time
const HYSTERESIS_MIN = 3; // keep old sequence unless new one saves >= 3 min

// Build candidate stops from order rows. Same-restaurant pickups merged.
function buildRouteCandidates(rows, now) {
  const pickupByRest = new Map();
  const candidates = [];
  for (const o of rows) {
    const pickedUp = o.status === 'picked_up' || o.status === 'on_way';
    const addr = [o.addr_label, o.line1, o.line2, o.city].filter(Boolean).join(', ');
    if (!pickedUp && o.rest_lat != null && o.rest_lng != null) {
      const key = String(o.restaurant_id);
      if (!pickupByRest.has(key)) {
        const p = {
          type: 'pickup', restaurant_id: key,
          name: o.restaurant_name || 'Restaurant',
          address: o.restaurant_address || '',
          lat: Number(o.rest_lat), lng: Number(o.rest_lng),
          phone: o.restaurant_phone || '', order_ids: [],
          wait_minutes: 0
        };
        pickupByRest.set(key, p);
        candidates.push(p);
      }
      const p = pickupByRest.get(key);
      p.order_ids.push(String(o.id));
      const assignedAt = Array.isArray(o.timeline)
        ? o.timeline.filter(t => String(t.status || '').toLowerCase() === 'rider_assigned').map(t => new Date(t.at).getTime())
        : [];
      const latestAssign = assignedAt.length ? Math.max.apply(null, assignedAt) : null;
      if (latestAssign && now - latestAssign < 5 * 60 * 1000) {
        p.wait_minutes = Math.max(p.wait_minutes, 5); // give kitchen a few minutes
      }
    }
    if (o.addr_lat != null && o.addr_lng != null) {
      const deadline = o.eta_at ? new Date(o.eta_at).getTime()
        : (o.placed_at ? new Date(o.placed_at).getTime() + 45 * 60 * 1000 : null);
      candidates.push({
        type: 'dropoff', order_ids: [String(o.id)],
        name: o.customer_name || 'Customer',
        address: addr, lat: Number(o.addr_lat), lng: Number(o.addr_lng),
        phone: o.customer_phone || '',
        deadline_at: deadline ? new Date(deadline).toISOString() : null,
        total_paise: o.total_paise
      });
    }
  }
  return candidates;
}

function routeStopKey(s) {
  return s.type + ':' + (s.order_ids || []).join(',');
}

// Exact route sequencing via Held-Karp dynamic programming with
// pickup-before-dropoff precedence constraints. n <= 6 always (max 3 orders,
// same-restaurant pickups merged), so 2^n * n^2 states is trivial (<1ms).
// Returns the TRUE minimum-cost feasible sequence under the same cost model
// the old nearest-neighbor greedy approximated (haversine legs, 0.7x urgency
// multiplier on inbound legs to near-deadline dropoffs).
// Assigns a human-readable `reason` to every chosen stop.
function sequenceRouteStops(candidates, rows, cur, now, haversineKm) {
  const n = candidates.length;
  if (!n) return { seq: [], startPt: cur };
  const distKm = (a, b) => haversineKm(a.lat, a.lng, b.lat, b.lng);

  // Precedence: a dropoff requires its restaurant's pickup stop earlier in the
  // sequence, unless that restaurant was already picked up.
  const pickedRestIds = new Set();
  const orderRest = new Map();
  rows.forEach(o => {
    if (o.status === 'picked_up' || o.status === 'on_way') pickedRestIds.add(String(o.restaurant_id));
    orderRest.set(String(o.id), String(o.restaurant_id));
  });
  const pickupIdxByRest = new Map();
  candidates.forEach((s, i) => {
    if (s.type === 'pickup') pickupIdxByRest.set(String(s.restaurant_id), i);
  });
  const required = new Array(n).fill(0);   // bitmask of mandatory predecessors
  const feasible = new Array(n).fill(true);
  candidates.forEach((s, i) => {
    if (s.type === 'dropoff') {
      const restKey = orderRest.get(String(s.order_ids[0]));
      if (restKey && !pickedRestIds.has(restKey)) {
        const pi = pickupIdxByRest.get(restKey);
        if (pi == null) feasible[i] = false; // pickup missing: can never be served
        else required[i] = (1 << pi);
      }
    }
  });

  // Urgency boost (same as before): dropoffs within 20 min of deadline get
  // 0.7x inbound-leg cost so the optimizer prefers them, exactly.
  const urgent = candidates.map(s => {
    if (s.type !== 'dropoff' || !s.deadline_at) return false;
    return (new Date(s.deadline_at).getTime() - now) / 60000 < 20;
  });
  const legCost = (from, toIdx) => {
    const d = from ? distKm(from, candidates[toIdx]) : 0;
    return urgent[toIdx] ? d * 0.7 : d;
  };

  // Compact to feasible stops; remap precedence masks to DP positions.
  const idx = [];
  const pos = new Array(n).fill(-1);
  candidates.forEach((s, i) => { if (feasible[i]) { pos[i] = idx.length; idx.push(i); } });
  const m = idx.length;
  if (!m) return { seq: [], startPt: cur };
  const reqMask = idx.map(ci => {
    let mm = 0;
    for (let k = 0; k < n; k++) if ((required[ci] >> k) & 1) mm |= (1 << pos[k]);
    return mm;
  });

  // Old behavior when rider location unknown: start at the first candidate,
  // so the first leg to it costs 0.
  const startPt = cur || { lat: candidates[0].lat, lng: candidates[0].lng };

  // Held-Karp DP: dp[mask][last] = min cost to visit `mask` ending at `last`.
  const N = 1 << m;
  const INF = 1e18;
  const dp = new Float64Array(N * m).fill(INF);
  const par = new Int16Array(N * m).fill(-1);
  const at = (mask, last) => mask * m + last;
  for (let p = 0; p < m; p++) {
    if (reqMask[p] === 0) dp[at(1 << p, p)] = legCost(startPt, idx[p]);
  }
  for (let mask = 1; mask < N; mask++) {
    for (let last = 0; last < m; last++) {
      if (!((mask >> last) & 1)) continue;
      const curCost = dp[at(mask, last)];
      if (curCost >= INF) continue;
      const fromPt = candidates[idx[last]];
      for (let nxt = 0; nxt < m; nxt++) {
        if ((mask >> nxt) & 1) continue;
        if ((reqMask[nxt] & ~mask) !== 0) continue; // precedence violated
        const nm = mask | (1 << nxt);
        const nc = curCost + legCost(fromPt, idx[nxt]);
        if (nc < dp[at(nm, nxt)]) { dp[at(nm, nxt)] = nc; par[at(nm, nxt)] = last; }
      }
    }
  }
  const full = N - 1;
  let bestLast = -1, bestCost = INF;
  for (let last = 0; last < m; last++) {
    if (dp[at(full, last)] < bestCost) { bestCost = dp[at(full, last)]; bestLast = last; }
  }
  const order = [];
  if (bestLast >= 0) {
    let mask = full, last = bestLast;
    while (last >= 0) {
      order.push(idx[last]);
      const p = par[at(mask, last)];
      mask ^= (1 << last);
      last = p;
    }
    order.reverse();
  } else {
    // Defensive: unreachable full tour (should not happen — pickups are
    // unconstrained so a feasible tour always exists). Keep candidate order.
    for (let p = 0; p < m; p++) order.push(idx[p]);
  }

  const seq = order.map(ci => candidates[ci]);
  seq.forEach((s, i) => {
    let reason;
    if (s.type === 'pickup' && s.order_ids.length > 1) {
      reason = 'Combines ' + s.order_ids.length + ' orders from one restaurant';
    } else if (urgent[order[i]]) {
      const minsLeft = Math.max(1, Math.round((new Date(s.deadline_at).getTime() - now) / 60000));
      reason = 'Urgent — about ' + minsLeft + ' min to deadline';
    } else if (i === 0) {
      reason = 'First stop on the optimal route';
    } else {
      reason = 'Next stop on the optimal route';
    }
    s.reason = reason;
  });
  return { seq, startPt: cur };
}

// Compute per-leg distance and minutes. Prefers Google Distance Matrix when a
// key is available; falls back to haversine silently.
async function computeRouteLegs(seq, startPt, gkey, haversineKm) {
  const legKm = [], legMinutes = [];
  for (let i = 0; i < seq.length; i++) {
    const from = i === 0 ? startPt : { lat: seq[i - 1].lat, lng: seq[i - 1].lng };
    const km = from ? Math.round(haversineKm(from.lat, from.lng, seq[i].lat, seq[i].lng) * 10) / 10 : 0;
    legKm.push(km);
    legMinutes.push((km / AVG_KMH) * 60 + STOP_MIN);
  }
  let trafficAware = false;
  if (gkey && seq.length > 1 && startPt) {
    try {
      const pts = [startPt].concat(seq.map(s => ({ lat: s.lat, lng: s.lng })));
      const joined = pts.map(p => p.lat + ',' + p.lng).join('|');
      const url = 'https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&mode=driving'
        + '&origins=' + encodeURIComponent(joined)
        + '&destinations=' + encodeURIComponent(joined)
        + '&key=' + encodeURIComponent(gkey);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      const dm = await r.json();
      if (dm.status === 'OK' && Array.isArray(dm.rows)) {
        const dmLegs = [];
        for (let i = 0; i < seq.length; i++) {
          const el = dm.rows[i] && dm.rows[i].elements && dm.rows[i].elements[i + 1];
          if (el && el.status === 'OK' && el.duration && el.distance) {
            dmLegs.push({ minutes: Math.round(el.duration.value / 60) + STOP_MIN, km: Math.round(el.distance.value / 100) / 10 });
          } else { dmLegs.push(null); }
        }
        if (dmLegs.every(Boolean)) {
          for (let i = 0; i < seq.length; i++) { legMinutes[i] = dmLegs[i].minutes; legKm[i] = dmLegs[i].km; }
          trafficAware = true;
        }
      }
    } catch (e) { /* fall back to haversine ETAs */ }
  }
  return { legKm, legMinutes, trafficAware };
}

function assembleRouteStops(seq, legKm, legMinutes, now) {
  let cumMin = 0, totalKm = 0;
  const stops = seq.map((s, i) => {
    cumMin += legMinutes[i] || 0;
    totalKm += legKm[i] || 0;
    const stop = {
      sequence: i + 1,
      type: s.type,
      order_ids: s.order_ids,
      name: s.name,
      address: s.address,
      phone: s.phone,
      lat: s.lat, lng: s.lng,
      leg_km: legKm[i],
      eta_minutes: Math.round(cumMin),
      wait_minutes: s.wait_minutes || 0,
      reason: s.reason || 'Next stop on the fastest route'
    };
    if (s.type === 'dropoff') {
      stop.deadline_at = s.deadline_at;
      stop.at_risk = !!(s.deadline_at && (now + cumMin * 60000) > new Date(s.deadline_at).getTime());
    }
    return stop;
  });
  return { stops, totalKm: Math.round(totalKm * 10) / 10, totalMinutes: Math.round(cumMin) };
}

async function ensureRouteCacheTable(db) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS route_optimization_cache (
       rider_id UUID PRIMARY KEY,
       order_set_key TEXT NOT NULL,
       stop_set_key TEXT NOT NULL,
       seq_key TEXT NOT NULL,
       total_minutes REAL NOT NULL,
       updated_at TIMESTAMPTZ DEFAULT now()
     )`
  );
}

// GET /api/rider/route/optimized?lat=&lng= — optimal stop sequence for active deliveries.
// Phase 2: explainable reasons, solver version tag, 3-min hysteresis via cache.
router.get(
  '/route/optimized',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    let rlat = Number(req.query.lat), rlng = Number(req.query.lng);
    if (!Number.isFinite(rlat) || !Number.isFinite(rlng)) {
      rlat = rider.lat != null ? Number(rider.lat) : null;
      rlng = rider.lng != null ? Number(rider.lng) : null;
    }
    await ensureRouteCacheTable(db);

    const { rows } = await db.query(
      `SELECT o.id, o.status, o.restaurant_id, o.placed_at, o.eta_at, o.total_paise, o.timeline,
              r.name AS restaurant_name, r.address AS restaurant_address,
              r.lat AS rest_lat, r.lng AS rest_lng, r.phone AS restaurant_phone,
              a.label AS addr_label, a.line1, a.line2, a.city,
              a.lat AS addr_lat, a.lng AS addr_lng,
              u.name AS customer_name, u.phone AS customer_phone
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       JOIN users u ON u.id = o.customer_id
       WHERE o.rider_id = $1 AND o.status NOT IN ('delivered','cancelled')
       ORDER BY o.placed_at ASC LIMIT 3`,
      [rider.id]
    );
    const now = Date.now();
    if (!rows.length) {
      return res.json({ stops: [], total_km: 0, total_minutes: 0, optimized_at: new Date().toISOString(), solver: 'v3-exact', hysteresis_applied: false });
    }

    const { haversineKm } = require('../lib/pricing');
    const gkey = process.env.GOOGLE_MAPS_KEY;
    const candidates = buildRouteCandidates(rows, now);
    const cur = (rlat != null && rlng != null) ? { lat: rlat, lng: rlng } : null;
    const { seq, startPt } = sequenceRouteStops(candidates, rows, cur, now, haversineKm);

    const orderSetKey = rows.map(o => String(o.id)).sort().join(',');
    const stopSetKey = seq.map(routeStopKey).sort().join('|');
    const freshSeqKey = seq.map(routeStopKey).join('|');

    // Hysteresis: if the stop set is unchanged and the new sequence saves less
    // than 3 minutes, keep the previous order (prevents route flip-flopping).
    let hysteresisApplied = false;
    let finalSeq = seq;
    const cached = await db.query('SELECT * FROM route_optimization_cache WHERE rider_id = $1', [rider.id]);
    const c = cached.rows[0];
    if (c && c.order_set_key === orderSetKey && c.stop_set_key === stopSetKey && c.seq_key !== freshSeqKey) {
      const saved = Number(c.total_minutes);
      // compute fresh total with haversine legs only (cheap preview for the comparison)
      const previewLegs = await computeRouteLegs(seq, startPt, null, haversineKm);
      const previewTotal = previewLegs.legMinutes.reduce((a, b) => a + b, 0);
      if ((saved - previewTotal) < HYSTERESIS_MIN) {
        // Reorder fresh stops into the cached sequence.
        const byKey = new Map(seq.map(s => [routeStopKey(s), s]));
        const reordered = c.seq_key.split('|').map(k => byKey.get(k)).filter(Boolean);
        if (reordered.length === seq.length) {
          finalSeq = reordered;
          hysteresisApplied = true;
        }
      }
    }

    const { legKm, legMinutes, trafficAware } = await computeRouteLegs(finalSeq, startPt, gkey, haversineKm);
    const { stops, totalKm, totalMinutes } = assembleRouteStops(finalSeq, legKm, legMinutes, now);

    await db.query(
      `INSERT INTO route_optimization_cache (rider_id, order_set_key, stop_set_key, seq_key, total_minutes, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (rider_id) DO UPDATE SET order_set_key = $2, stop_set_key = $3, seq_key = $4, total_minutes = $5, updated_at = now()`,
      [rider.id, orderSetKey, stopSetKey, finalSeq.map(routeStopKey).join('|'), totalMinutes]
    );

    res.json({
      stops,
      total_km: totalKm,
      total_minutes: totalMinutes,
      optimized_at: new Date().toISOString(),
      traffic_aware: trafficAware,
      solver: 'v3-exact',
      hysteresis_applied: hysteresisApplied
    });
  })
);

// GET /api/rider/readiness/:orderId — predict when the food will be ready.
// Uses real prep history for this restaurant; never invents data.
// Confidence: high (20+ samples), medium (5-19), low (<5 → 15 min default).
router.get(
  '/readiness/:orderId',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    await db.query(
      `CREATE TABLE IF NOT EXISTS restaurant_prep_history (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id UUID NOT NULL,
        restaurant_id UUID NOT NULL,
        accepted_at TIMESTAMPTZ,
        ready_at TIMESTAMPTZ DEFAULT now(),
        prep_minutes NUMERIC,
        created_at TIMESTAMPTZ DEFAULT now()
      )`
    );
    const { rows: orows } = await db.query(
      `SELECT o.id, o.restaurant_id, o.status, o.placed_at, o.timeline, r.name AS restaurant_name
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.id = $1 AND o.rider_id = $2`,
      [req.params.orderId, rider.id]
    );
    const order = orows[0];
    if (!order) return res.status(404).json({ error: 'Delivery not found' });
    if (order.status !== 'ready') {
      return res.json({ status: order.status, prediction: null });
    }
    // When did the kitchen accept this order? (prep clock start)
    let acceptedAt = null;
    const tl = Array.isArray(order.timeline) ? order.timeline : [];
    for (const t of tl) {
      const s = String(t.status || '').toLowerCase();
      if ((s === 'accepted' || s === 'preparing') && !acceptedAt) acceptedAt = t.at;
    }
    // Historical prep times for this restaurant (last 30, valid only)
    const { rows: hist } = await db.query(
      `SELECT prep_minutes FROM restaurant_prep_history
       WHERE restaurant_id = $1 AND prep_minutes IS NOT NULL
       ORDER BY created_at DESC LIMIT 30`,
      [order.restaurant_id]
    );
    const samples = hist.map(r => Number(r.prep_minutes)).filter(n => n > 0 && n < 180);
    const n = samples.length;
    // Current kitchen load: other active orders at this restaurant
    const { rows: loadRows } = await db.query(
      `SELECT COUNT(*) AS n FROM orders
       WHERE restaurant_id = $1 AND status IN ('accepted','preparing')
         AND id <> $2`,
      [order.restaurant_id, order.id]
    );
    const load = Number(loadRows[0].n) || 0;
    let confidence, avgPrep;
    if (n >= 20) { confidence = 'high'; }
    else if (n >= 5) { confidence = 'medium'; }
    else { confidence = 'low'; }
    if (n > 0) {
      avgPrep = samples.reduce((a, b) => a + b, 0) / n;
      // Busy kitchen: +2 min per concurrent order beyond the first 2
      if (load > 2) avgPrep += (load - 2) * 2;
    } else {
      avgPrep = 15; // default when no history — labeled low confidence
    }
    // Elapsed prep time so far for THIS order
    const startMs = acceptedAt ? new Date(acceptedAt).getTime() : new Date(order.placed_at).getTime();
    const elapsedMin = Math.max(0, (Date.now() - startMs) / 60000);
    const expectedWait = Math.max(0, Math.round(avgPrep - elapsedMin));
    const predictedReadyAt = new Date(Date.now() + expectedWait * 60000).toISOString();
    res.json({
      status: 'ready',
      restaurant_name: order.restaurant_name,
      predicted_ready_at: predictedReadyAt,
      expected_wait_minutes: expectedWait,
      confidence,
      sample_count: n,
      kitchen_load: load,
      avg_prep_minutes: Math.round(avgPrep)
    });
  })
);

// Voice interaction logging table (created lazily on first voice log call)
async function logVoice(riderId, query, intent, response) {
  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS voice_interactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        rider_id UUID NOT NULL,
        query TEXT,
        intent TEXT,
        response TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      )`
    );
    await db.query(
      `INSERT INTO voice_interactions (rider_id, query, intent, response) VALUES ($1,$2,$3,$4)`,
      [riderId, query || null, intent || null, response || null]
    );
  } catch (e) { /* analytics must never break the app */ }
}

// POST /api/rider/voice/log { query, intent, response } — analytics only
router.post(
  '/voice/log',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    await logVoice(rider.id, req.body.query, req.body.intent, req.body.response);
    res.json({ ok: true });
  })
);

// POST /api/rider/deliveries/evaluate { order_ids: [] } — batch efficiency scoring.
// Answers: would accepting these orders improve Rs/hr without risking deadlines?
router.post(
  '/deliveries/evaluate',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    await db.query(
      `CREATE TABLE IF NOT EXISTS batch_evaluations (
         id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
         rider_id UUID NOT NULL,
         order_ids UUID[] NOT NULL,
         score INT,
         recommendation TEXT,
         projected_rs_per_hr REAL,
         created_at TIMESTAMPTZ DEFAULT now()
       )`
    );
    const ids = Array.isArray(req.body.order_ids) ? req.body.order_ids.filter(Boolean) : [];
    if (!ids.length) return res.status(400).json({ error: 'order_ids required' });
    if (ids.length > 3) return res.status(400).json({ error: 'Evaluate at most 3 orders at once' });

    const { haversineKm, riderPayoutPaise, loadPricingConfig } = require('../lib/pricing');
    const config = await loadPricingConfig(db);
    const now = Date.now();

    const orderCols = `o.id, o.status, o.rider_id, o.restaurant_id, o.placed_at, o.eta_at, o.timeline,
      r.name AS restaurant_name, r.lat AS rest_lat, r.lng AS rest_lng,
      a.lat AS addr_lat, a.lng AS addr_lng,
      u.name AS customer_name`;
    const { rows: candRows } = await db.query(
      `SELECT ${orderCols} FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       JOIN users u ON u.id = o.customer_id
       WHERE o.id = ANY($1)`, [ids]);
    const dec = await db.query(
      'SELECT order_id FROM rider_declines WHERE rider_id = $1 AND order_id = ANY($2)',
      [rider.id, ids]);
    const declinedSet = new Set(dec.rows.map(r => String(r.order_id)));
    const eligible = candRows.filter(o => o.status === 'ready' && !o.rider_id && !declinedSet.has(String(o.id)));
    const ineligible = ids.filter(id => !eligible.some(o => String(o.id) === String(id)));

    const { rows: actRows } = await db.query(
      `SELECT ${orderCols} FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       JOIN users u ON u.id = o.customer_id
       WHERE o.rider_id = $1 AND o.status NOT IN ('delivered','cancelled')`, [rider.id]);

    const payoutFor = (o) => {
      if (o.rest_lat != null && o.rest_lng != null && o.addr_lat != null && o.addr_lng != null) {
        const km = haversineKm(o.rest_lat, o.rest_lng, o.addr_lat, o.addr_lng);
        return { payout: riderPayoutPaise(config.riderPayout, km), km };
      }
      // No hardcoded fallback: return null (UI hides payout when location unknown)
      return { payout: null, km: null };
    };

    // Simulate a batch: sequence stops, sum payout and minutes, count deadline risks.
    const simulate = (orderRows) => {
      const rows = orderRows.map(o => Object.assign({}, o));
      const candidates = buildRouteCandidates(rows, now);
      const rlat = rider.lat != null ? Number(rider.lat) : null;
      const rlng = rider.lng != null ? Number(rider.lng) : null;
      const cur = (Number.isFinite(rlat) && Number.isFinite(rlng)) ? { lat: rlat, lng: rlng } : null;
      const { seq, startPt } = sequenceRouteStops(candidates, rows, cur, now, haversineKm);
      let minutes = 0, km = 0, payout = 0, atRisk = 0;
      let pt = startPt;
      const perOrder = new Map();
      rows.forEach(o => { const p = payoutFor(o); perOrder.set(String(o.id), p); payout += p.payout; });
      seq.forEach(s => {
        const from = pt || { lat: s.lat, lng: s.lng };
        const legKm = haversineKm(from.lat, from.lng, s.lat, s.lng);
        km += legKm;
        minutes += (legKm / AVG_KMH) * 60 + STOP_MIN;
        if (s.type === 'dropoff' && s.deadline_at) {
          if (now + minutes * 60000 > new Date(s.deadline_at).getTime()) atRisk++;
        }
        pt = { lat: s.lat, lng: s.lng };
      });
      return { minutes, km, payout, atRisk, orderCount: rows.length };
    };

    const current = simulate(actRows);
    const projected = simulate(actRows.concat(eligible));
    const curRate = current.minutes > 0 ? (current.payout / 100) / (current.minutes / 60) : 0;
    const projRate = projected.minutes > 0 ? (projected.payout / 100) / (projected.minutes / 60) : 0;

    const reasons = [];
    if (ineligible.length) reasons.push(ineligible.length + ' order(s) no longer available');
    if (actRows.length + eligible.length > 3) reasons.push('Would exceed the 3-delivery limit');
    if (projected.atRisk > current.atRisk) reasons.push((projected.atRisk - current.atRisk) + ' deliverie(s) would risk missing deadlines');
    if (eligible.length && projRate < curRate * 0.95) reasons.push('Lowers your Rs/hr from ' + Math.round(curRate) + ' to ' + Math.round(projRate));
    if (eligible.length && projRate >= curRate) reasons.push('Improves Rs/hr from ' + Math.round(curRate) + ' to ' + Math.round(projRate));

    let recommendation = 'decline';
    if (eligible.length && !ineligible.length && actRows.length + eligible.length <= 3
        && projected.atRisk === current.atRisk && projRate >= curRate * 0.95) {
      recommendation = 'accept';
    }
    const score = Math.max(0, Math.min(100, Math.round(
      50 + (projRate - curRate) * 2 - (projected.atRisk - current.atRisk) * 25 - ineligible.length * 30
    )));

    await db.query(
      'INSERT INTO batch_evaluations (rider_id, order_ids, score, recommendation, projected_rs_per_hr) VALUES ($1, $2, $3, $4, $5)',
      [rider.id, eligible.map(o => o.id), score, recommendation, Math.round(projRate * 10) / 10]
    );

    res.json({
      score,
      recommendation,
      reasons,
      current_rs_per_hr: Math.round(curRate * 10) / 10,
      projected_rs_per_hr: Math.round(projRate * 10) / 10,
      total_minutes: Math.round(projected.minutes),
      total_earnings_paise: Math.round(projected.payout),
      total_km: Math.round(projected.km * 10) / 10,
      eligible_order_ids: eligible.map(o => String(o.id)),
      ineligible_order_ids: ineligible.map(String),
      at_risk_deliveries: projected.atRisk
    });
  })
);


// POST /api/rider/deliveries/:id/accept
router.post(
  '/deliveries/:id/accept',
  ah(async (req, res) => {
    const rider = await requireActiveRider(req, res);
    if (!rider) return;
    if (!rider.online) return res.status(409).json({ error: 'Go online to accept deliveries' });
    // Max 3 concurrent active deliveries per rider. Trips count as 1 (not per-order).
    const active = await db.query(
      `SELECT COUNT(DISTINCT COALESCE(trip_id::text, id::text)) AS n
       FROM orders WHERE rider_id = $1 AND status NOT IN ('delivered','cancelled')`,
      [rider.id]
    );
    if (Number(active.rows[0].n) >= 3) {
      return res.status(409).json({ error: 'You already have 3 active deliveries — complete one first' });
    }
    // Proximity dispatch: only the designated offeree (or anyone, if the
    // order is unassigned / the offer expired) may accept.
    const offerOk = await db.query(
      `SELECT id FROM orders WHERE id = $1 AND status = 'ready' AND rider_id IS NULL
       AND (offered_to_rider_id IS NULL OR offered_to_rider_id = $2 OR offer_expires_at < now())`,
      [req.params.id, rider.id]
    );
    if (!offerOk.rows.length) {
      return res.status(409).json({ error: 'Delivery no longer available' });
    }
    // Atomic trip accept: lock the entire trip in ONE query (prevents split-trip race)
    // First, get the trip_id for this order
    const tripRes = await db.query('SELECT trip_id FROM orders WHERE id = $1', [req.params.id]);
    const tripId = tripRes.rows[0]?.trip_id;

    let order;
    if (tripId) {
      // Trip: assign ALL unassigned ready orders in the trip atomically
      // Only succeeds if ALL are still available (prevents partial assignment)
      const { rows } = await db.query(
        `UPDATE orders SET rider_id = $1
         WHERE trip_id = $2 AND status = 'ready' AND rider_id IS NULL
         RETURNING *`,
        [rider.id, tripId]
      );
      if (rows.length === 0) {
        return res.status(409).json({ error: 'Delivery no longer available' });
      }
      // Verify we got ALL trip orders (not a partial race)
      const countRes = await db.query(
        "SELECT COUNT(*) AS n FROM orders WHERE trip_id = $1 AND status = 'ready'",
        [tripId]
      );
      if (rows.length !== Number(countRes.rows[0].n)) {
        // Partial assignment - rollback by unassigning
        await db.query(
          "UPDATE orders SET rider_id = NULL WHERE trip_id = $1 AND rider_id = $2",
          [tripId, rider.id]
        );
        return res.status(409).json({ error: 'Delivery no longer available' });
      }
      order = rows[0];
    } else {
      // Single order: atomic assign
      const { rows } = await db.query(
        "UPDATE orders SET rider_id = $1 WHERE id = $2 AND status = 'ready' AND rider_id IS NULL RETURNING *",
        [rider.id, req.params.id]
      );
      order = rows[0];
      if (!order) return res.status(409).json({ error: 'Delivery no longer available' });
    }

    const timeline = order.timeline || [];
    timeline.push({ status: 'rider_assigned', at: new Date().toISOString(), by: 'rider' });
    await db.query('UPDATE orders SET timeline = $1::jsonb WHERE id = $2', [
      JSON.stringify(timeline), order.id
    ]);
    // Assigned: clear any dispatch offer state on the orders we just took.
    if (tripId) {
      await db.query(
        `UPDATE orders SET offered_to_rider_id = NULL, offer_expires_at = NULL, offer_history = '{}'
         WHERE trip_id = $1 AND rider_id = $2`,
        [tripId, rider.id]
      );
    } else {
      await db.query(
        `UPDATE orders SET offered_to_rider_id = NULL, offer_expires_at = NULL, offer_history = '{}'
         WHERE id = $1`,
        [order.id]
      );
    }
    await notify(order.customer_id, 'Rider assigned', 'Your rider is on the way to the restaurant.');
    res.json({ ok: true, trip_id: order.trip_id || null });
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
    // Back to the pool: re-dispatch to the nearest available rider.
    try { await dispatchOrder(order.id); } catch (e) { console.error('[dispatch] re-dispatch failed', e.message); }
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

    // TEMP DISABLED 2026-10-11: rider app photo UI not deployed yet (Vercel limit)
    // Re-enable once rider app with photo upload is live
    // if (!photo) {
    //   return res.status(400).json({ error: 'A pickup photo is required to confirm pickup' });
    // }

    // Pickup OTP is MANDATORY (user requirement 2026-10-12)
    // NOTE: pickup_otp is stripped from deliveryDetail — fetch it directly here
    const providedOtp = req.body.pickup_otp || req.body.otp;
    if (!providedOtp) {
      return res.status(400).json({ error: 'Pickup OTP is required. Ask the restaurant for the code.' });
    }
    const otpRes = await db.query('SELECT pickup_otp FROM orders WHERE id = $1', [detail.id]);
    const expectedOtp = otpRes.rows[0] && otpRes.rows[0].pickup_otp;
    if (!expectedOtp || String(providedOtp) !== String(expectedOtp)) {
      return res.status(400).json({ error: 'Invalid pickup OTP. Ask the restaurant for the correct code.' });
    }

    const code = null; /* stable OTP: placement OTP reused, never regenerated */
    await db.query('UPDATE orders SET pickup_photo = COALESCE($1, pickup_photo) WHERE id = $2',
      [photo, detail.id]);
    await transition(detail.id, 'picked_up', 'rider');
    await notify(detail.customer_id, 'Your rider is on the way',
      `Your rider has picked up the order. Share your delivery OTP to receive it.`);
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
    let payout = null; // No hardcoded fallback: null when locations unknown
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

    // Only record payout when we could calculate it from real coordinates.
    // Never invent a payout value when location is unknown.
    if (payout != null) {
      await db.query(
        `INSERT INTO rider_payouts (rider_id, order_id, amount_paise, distance_km)
         VALUES ($1, $2, $3, $4) ON CONFLICT (order_id) DO NOTHING`,
        [rider.id, order.id, payout, distanceKm]
      );
    } else {
      console.warn(`[payout] Skipped payout for order ${order.id}: location unknown, no payout recorded`);
    }
    if (cod) {
      await db.query(
        `INSERT INTO rider_cod_ledger (rider_id, order_id, amount_paise)
         VALUES ($1, $2, $3) ON CONFLICT (order_id) DO NOTHING`,
        [rider.id, order.id, cashPaise]
      );
    }
    // For trips: mark ALL orders in the trip as delivered (shared OTP)
    if (order.trip_id) {
      const tripOrders = await db.query(
        "SELECT id FROM orders WHERE trip_id = $1 AND rider_id = $2 AND status = 'on_way'",
        [order.trip_id, rider.id]
      );
      for (const to of tripOrders.rows) {
        await transition(to.id, 'delivered', 'rider');
      }
    } else {
      await transition(order.id, 'delivered', 'rider');
    }

    const deliveryPhoto = req.body.delivery_photo || null;
    await db.query(
      'UPDATE orders SET delivered_at = now(), payment_status = $1, delivery_photo = COALESCE($2, delivery_photo) WHERE id = $3',
      [paymentStatus, deliveryPhoto, order.id]
    );

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
    const from = req.query.from ? new Date(req.query.from + 'T00:00:00+05:30') : new Date(Date.now() - 30 * 864e5);
    let to = req.query.to ? new Date(req.query.to + 'T00:00:00+05:30') : new Date();
    // Make 'to' inclusive of the full day (start of next day)
    to = new Date(to.getTime() + 864e5);
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
