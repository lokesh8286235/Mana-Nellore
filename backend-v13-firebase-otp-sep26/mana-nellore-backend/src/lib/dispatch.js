// Proximity-based order dispatch (nearest-rider cascade).
//
// Replaces broadcast/first-tap-wins with targeted offers:
//   1. When an order becomes ready, rank eligible riders by distance to the
//      restaurant (haversine), with an on-the-way bonus and a capacity
//      tiebreaker.
//   2. Offer to the nearest rider first (30s window).
//   3. On decline or timeout -> offer to the next nearest (cascade).
//   4. No eligible riders -> order stays queued; retried on poll / when a
//      rider comes online.
//
// Offer state lives on orders:
//   offered_to_rider_id  - current designated offeree (NULL = unassigned)
//   offer_expires_at     - end of the 30s window
//   offer_history        - UUID[] of riders already offered this round
//                          (timeouts go here; declines live in rider_declines)
//   dispatch_attempted_at - last time we tried to dispatch (retry throttle)
//
// The rider app polls GET /api/rider/deliveries/available; it simply sees
// fewer, more relevant offers. The accept endpoint keeps its atomic
// first-tap-wins guard, plus an offer-membership check.

const db = require('../db');
const { haversineKm } = require('./pricing');

const OFFER_WINDOW_SEC = 30;   // how long one rider holds the offer
const RETRY_THROTTLE_SEC = 30; // min gap between dispatch retries for queued orders
const TIEBREAK_M = 0.5;        // within 500m, prefer the rider with fewer active orders
const ON_THE_WAY_DETOUR_KM = 1.0; // detour under 1km => on-the-way bonus
const ON_THE_WAY_BOOST_KM = 2.0;  // effective-distance boost for on-the-way riders
const MAX_ACTIVE = 3;          // capacity cap (mirrors the accept endpoint)

// ---- schema (lazy, idempotent; safe to call on every dispatch) ----
let schemaReady = null;
async function ensureDispatchSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS offered_to_rider_id UUID REFERENCES riders(id) ON DELETE SET NULL`);
      await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS offer_expires_at TIMESTAMPTZ`);
      await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS offer_history UUID[] NOT NULL DEFAULT '{}'`);
      await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatch_attempted_at TIMESTAMPTZ`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_offer_sweep ON orders (offer_expires_at) WHERE rider_id IS NULL AND status = 'ready' AND offered_to_rider_id IS NOT NULL`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_orders_dispatch_pending ON orders (dispatch_attempted_at) WHERE rider_id IS NULL AND status = 'ready' AND offered_to_rider_id IS NULL`);
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function notifyUser(userId, title, body) {
  try {
    await db.query('INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)', [userId, title, body]);
  } catch (e) { /* notifications are best-effort */ }
}

// Upcoming stops for riders with active deliveries, for the on-the-way bonus.
// Returns Map riderId -> [{lat, lng}].
async function upcomingStopsByRider(riderIds) {
  const map = new Map();
  if (!riderIds.length) return map;
  const { rows } = await db.query(
    `SELECT o.rider_id, o.status, r.lat AS rest_lat, r.lng AS rest_lng,
            a.lat AS addr_lat, a.lng AS addr_lng
     FROM orders o
     JOIN restaurants r ON r.id = o.restaurant_id
     LEFT JOIN addresses a ON a.id = o.address_id
     WHERE o.rider_id = ANY($1) AND o.status NOT IN ('delivered','cancelled')`,
    [riderIds]
  );
  for (const o of rows) {
    const pickedUp = o.status === 'picked_up' || o.status === 'on_way';
    const lat = pickedUp ? o.addr_lat : o.rest_lat;
    const lng = pickedUp ? o.addr_lng : o.rest_lng;
    if (lat == null || lng == null) continue;
    if (!map.has(String(o.rider_id))) map.set(String(o.rider_id), []);
    map.get(String(o.rider_id)).push({ lat: Number(lat), lng: Number(lng) });
  }
  return map;
}

// Rank eligible riders for an order. Returns sorted array of
// { id, user_id, distKm, effKm, activeN } — best first.
async function rankRiders(orderId, restLat, restLng, excludeRiderIds) {
  const exclude = [...new Set((excludeRiderIds || []).map(String))];
  const { rows } = await db.query(
    `SELECT r.id, r.user_id, r.lat, r.lng,
            (SELECT COUNT(DISTINCT COALESCE(o.trip_id::text, o.id::text))
             FROM orders o
             WHERE o.rider_id = r.id AND o.status NOT IN ('delivered','cancelled')) AS active_n
     FROM riders r
     WHERE r.status = 'approved' AND r.online = true
       AND NOT EXISTS (SELECT 1 FROM rider_declines rd WHERE rd.rider_id = r.id AND rd.order_id = $1)
       ${exclude.length ? `AND r.id <> ALL($2::uuid[])` : ''}`,
    exclude.length ? [orderId, exclude] : [orderId]
  );
  const eligible = rows.filter(r => Number(r.active_n) < MAX_ACTIVE);
  if (!eligible.length) return [];

  const stopsByRider = await upcomingStopsByRider(eligible.filter(r => Number(r.active_n) > 0).map(r => r.id));
  const hasRest = restLat != null && restLng != null;

  const ranked = eligible.map(r => {
    const rlat = r.lat == null ? null : Number(r.lat);
    const rlng = r.lng == null ? null : Number(r.lng);
    let distKm = Infinity;
    let effKm = Infinity;
    if (hasRest && rlat != null && rlng != null) {
      distKm = haversineKm(rlat, rlng, Number(restLat), Number(restLng));
      effKm = distKm;
      // On-the-way bonus: rider's route already passes near this restaurant.
      const stops = stopsByRider.get(String(r.id)) || [];
      let minDetour = Infinity;
      for (const s of stops) {
        const detour = distKm + haversineKm(Number(restLat), Number(restLng), s.lat, s.lng)
          - haversineKm(rlat, rlng, s.lat, s.lng);
        if (detour < minDetour) minDetour = detour;
      }
      if (minDetour < ON_THE_WAY_DETOUR_KM) effKm = Math.max(0, distKm - ON_THE_WAY_BOOST_KM);
    }
    return { id: r.id, user_id: r.user_id, distKm, effKm, activeN: Number(r.active_n) };
  });

  ranked.sort((a, b) => {
    // Within 500m, prefer the rider with fewer active deliveries.
    if (Math.abs(a.effKm - b.effKm) < TIEBREAK_M && a.activeN !== b.activeN) return a.activeN - b.activeN;
    return a.effKm - b.effKm;
  });
  return ranked;
}

// Offer a batch of order ids (a trip unit) to one rider.
async function placeOffer(orderIds, rider) {
  const expiresAt = new Date(Date.now() + OFFER_WINDOW_SEC * 1000).toISOString();
  await db.query(
    `UPDATE orders SET offered_to_rider_id = $1, offer_expires_at = $2::timestamptz,
       offer_history = array_append(offer_history, $1::uuid),
       dispatch_attempted_at = now()
     WHERE id = ANY($3::uuid[])`,
    [rider.id, expiresAt, orderIds]
  );
  const n = orderIds.length;
  await notifyUser(
    rider.user_id,
    n > 1 ? `New trip offer \u{1F6F5}` : `New delivery offer \u{1F6F5}`,
    n > 1
      ? `${n} orders ready nearby — tap to view. Offer expires in ${OFFER_WINDOW_SEC}s.`
      : `A delivery near you is ready — tap to view. Offer expires in ${OFFER_WINDOW_SEC}s.`
  );
  return { offeredTo: rider.id, expiresAt };
}

// Dispatch one order (plus any ready/unassigned/unoffered trip siblings) to the
// nearest eligible rider. Returns { offeredTo } | { queued: true } | { skipped }.
async function dispatchOrder(orderId) {
  await ensureDispatchSchema();
  const { rows } = await db.query(
    `SELECT o.id, o.trip_id, o.status, o.rider_id, o.order_type,
            o.offered_to_rider_id, o.offer_expires_at, o.offer_history,
            r.lat AS rest_lat, r.lng AS rest_lng, r.name AS restaurant_name
     FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
     WHERE o.id = $1`,
    [orderId]
  );
  const order = rows[0];
  if (!order) return { skipped: 'not-found' };
  if (order.status !== 'ready' || order.rider_id) return { skipped: 'not-ready' };
  if (order.order_type !== 'delivery') return { skipped: 'not-delivery' };
  if (order.offered_to_rider_id && order.offer_expires_at && new Date(order.offer_expires_at) > new Date()) {
    return { skipped: 'offer-active' }; // someone already holds this offer
  }

  // Offer unit: this order + trip siblings that are ready, unassigned, unoffered.
  let unitIds = [order.id];
  if (order.trip_id) {
    const sib = await db.query(
      `SELECT id FROM orders
       WHERE trip_id = $1 AND id <> $2 AND status = 'ready' AND rider_id IS NULL
         AND order_type = 'delivery'
         AND (offered_to_rider_id IS NULL OR offer_expires_at < now())`,
      [order.trip_id, order.id]
    );
    unitIds = unitIds.concat(sib.rows.map(r => r.id));
  }

  const history = (order.offer_history || []).map(String);
  let ranked = await rankRiders(order.id, order.rest_lat, order.rest_lng, history);

  if (!ranked.length) {
    // Everyone eligible already timed out this round -> reset history, try again.
    if (history.length) {
      await db.query(`UPDATE orders SET offer_history = '{}' WHERE id = ANY($1::uuid[])`, [unitIds]);
      ranked = await rankRiders(order.id, order.rest_lat, order.rest_lng, []);
    }
  }
  if (!ranked.length) {
    // Still nobody: stamp the attempt (throttles retries) and stay queued.
    await db.query(`UPDATE orders SET dispatch_attempted_at = now() WHERE id = ANY($1::uuid[])`, [unitIds]);
    return { queued: true };
  }
  return placeOffer(unitIds, ranked[0]);
}

// Expire timed-out offers and cascade each to the next nearest rider.
async function sweepExpiredOffers() {
  await ensureDispatchSchema();
  const { rows } = await db.query(
    `UPDATE orders SET offered_to_rider_id = NULL, offer_expires_at = NULL
     WHERE rider_id IS NULL AND status = 'ready'
       AND offered_to_rider_id IS NOT NULL AND offer_expires_at < now()
     RETURNING id`
  );
  for (const r of rows) {
    try { await dispatchOrder(r.id); } catch (e) { console.error('[dispatch] cascade failed for', r.id, e.message); }
  }
  return rows.length;
}

// Dispatch ready orders that have never been offered (or whose retry throttle elapsed).
// force=true ignores the throttle (e.g. rider just came online).
async function dispatchPendingOrders(force) {
  await ensureDispatchSchema();
  const { rows } = await db.query(
    `SELECT id FROM orders
     WHERE rider_id IS NULL AND status = 'ready' AND order_type = 'delivery'
       AND offered_to_rider_id IS NULL
       AND ($1 OR dispatch_attempted_at IS NULL OR dispatch_attempted_at < now() - ($2 || ' seconds')::interval)
     ORDER BY placed_at ASC LIMIT 20`,
    [!!force, RETRY_THROTTLE_SEC]
  );
  for (const r of rows) {
    try { await dispatchOrder(r.id); } catch (e) { console.error('[dispatch] pending failed for', r.id, e.message); }
  }
  return rows.length;
}

// Clear any active offer this rider holds on an order (and its trip siblings
// offered in the same batch), e.g. on decline.
async function clearRiderOffer(orderId, riderId) {
  await ensureDispatchSchema();
  await db.query(
    `UPDATE orders SET offered_to_rider_id = NULL, offer_expires_at = NULL
     WHERE id = $1 OR (offered_to_rider_id = $2 AND trip_id = (SELECT trip_id FROM orders WHERE id = $1) AND trip_id IS NOT NULL)`,
    [orderId, riderId]
  );
}

module.exports = {
  ensureDispatchSchema,
  dispatchOrder,
  sweepExpiredOffers,
  dispatchPendingOrders,
  clearRiderOffer,
  OFFER_WINDOW_SEC,
};
