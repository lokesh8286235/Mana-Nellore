// Public restaurant discovery (customer app home + restaurant page).
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { ah } = require('../middleware/auth');
const { haversineKm, loadPricingConfig, deliveryFeePaise, customerDeliveryFeePaise, otwSecondaryFeePaise } = require('../lib/pricing');
const { pointToSegKm } = require('../lib/otw');

const router = express.Router();

// ---- 30-second in-memory cache for the restaurant list (scale: 1000+ users) ----
const listCache = new Map(); // key -> { at, data }
const LIST_CACHE_MS = 30 * 1000;
function cacheGet(key) {
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_CACHE_MS) return hit.data;
  listCache.delete(key);
  return null;
}
function cacheSet(key, data) {
  if (listCache.size > 200) listCache.clear();
  listCache.set(key, { at: Date.now(), data });
}

function isOpenNow(r) {
  // The partner's Open/Closed toggle is the master switch — it overrides
  // operating hours. opens_at/closes_at are display info only.
  return !!r.is_open;
}

// ---- Google Distance Matrix for REAL drive ETAs/distances (10-min cache) ----
// Keyed by customer location rounded to a ~100m grid + the restaurant ID set,
// so nearby customers share one batched Matrix call instead of hammering Google.
const matrixCache = new Map(); // key -> { at, data: { [restaurantId]: { eta_minutes, distance_km } } }
const MATRIX_CACHE_MS = 10 * 60 * 1000;
function matrixCacheGet(key) {
  const hit = matrixCache.get(key);
  if (hit && Date.now() - hit.at < MATRIX_CACHE_MS) return hit.data;
  matrixCache.delete(key);
  return null;
}
function matrixCacheSet(key, data) {
  if (matrixCache.size > 200) matrixCache.clear();
  matrixCache.set(key, { at: Date.now(), data });
}
function grid100m(v) { return Math.round(v * 1000) / 1000; }

// Batched Distance Matrix: origins = restaurants (<=25 per call, chunked),
// single destination = customer. Returns null on any failure so callers fall
// back to the haversine estimate — never breaks the list.
async function fetchRealDriveETAs(custLat, custLng, rows, gkey) {
  const withCoords = rows.filter((r) => r.lat != null && r.lng != null);
  if (!withCoords.length || !gkey) return null;
  const key = 'm|' + grid100m(custLat) + ',' + grid100m(custLng)
    + '|' + withCoords.map((r) => String(r.id)).sort().join(',');
  const cached = matrixCacheGet(key);
  if (cached) return cached;

  const dest = custLat + ',' + custLng;
  const out = {};
  try {
    for (let i = 0; i < withCoords.length; i += 25) {
      const chunk = withCoords.slice(i, i + 25);
      const origins = chunk.map((r) => r.lat + ',' + r.lng).join('|');
      const url = 'https://maps.googleapis.com/maps/api/distancematrix/json?units=metric&mode=driving'
        + '&departure_time=now&traffic_model=best_guess'
        + '&origins=' + encodeURIComponent(origins)
        + '&destinations=' + encodeURIComponent(dest)
        + '&key=' + encodeURIComponent(gkey);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 4000);
      const resp = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      const dm = await resp.json();
      if (dm.status !== 'OK' || !Array.isArray(dm.rows)) return null;
      for (let j = 0; j < chunk.length; j++) {
        const el = dm.rows[j] && dm.rows[j].elements && dm.rows[j].elements[0];
        if (el && el.status === 'OK' && el.duration) {
          const dur = (el.duration_in_traffic && el.duration_in_traffic.value) ? el.duration_in_traffic : el.duration;
          out[chunk[j].id] = {
            eta_minutes: Math.round(dur.value / 60),
            distance_km: el.distance ? Math.round(el.distance.value / 100) / 10 : null,
          };
        }
      }
    }
  } catch (e) { return null; }
  matrixCacheSet(key, out);
  return out;
}

// GET /api/restaurants?q=&veg=&open=&lat=&lng=&meal=
router.get(
  '/',
  ah(async (req, res) => {
    const { q, veg, open, lat, lng, meal, sort } = req.query;
    // Optional identity for personalization: decode the token when present,
    // but never reject anonymous browsing (this route is public).
    let customerId = null;
    const authH = req.headers.authorization || '';
    if (authH.startsWith('Bearer ')) {
      try {
        const payload = jwt.verify(authH.slice(7), process.env.JWT_SECRET);
        if (payload && payload.role === 'customer') customerId = payload.sub;
      } catch (e) { /* anonymous */ }
    }
    // Grid-round coords to ~100m so the cache actually hits (raw GPS jitters every reading)
    const glat = lat != null && Number.isFinite(Number(lat)) ? Math.round(Number(lat) * 1000) / 1000 : null;
    const glng = lng != null && Number.isFinite(Number(lng)) ? Math.round(Number(lng) * 1000) / 1000 : null;
    const cacheKey = JSON.stringify({ q, veg, open, lat: glat, lng: glng, meal, sort, customerId });
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const conditions = ["r.status = 'approved'", "COALESCE(r.is_coming_soon, false) = false"];
    const params = [];

    if (q) {
      // Word-split matcher (same as dish search): every word must match, and
      // %/_ wildcards in user input are escaped so they match literally.
      const escLike = (s) => s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
      const words = String(q).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1).slice(0, 5);
      const terms = words.length ? words : [String(q).toLowerCase()];
      for (const w of terms) {
        const pat = `%${escLike(w)}%`;
        params.push(pat, pat);
        const p1 = `$${params.length - 1}`;
        const p2 = `$${params.length}`;
        conditions.push(`(r.name ILIKE ${p1} ESCAPE '\\' OR r.description ILIKE ${p1} ESCAPE '\\' OR EXISTS (
          SELECT 1 FROM menu_items mi
          WHERE mi.restaurant_id = r.id AND mi.available = true AND mi.name ILIKE ${p2} ESCAPE '\\'
        ) OR EXISTS (
          SELECT 1 FROM categories c
          WHERE c.restaurant_id = r.id AND c.name ILIKE ${p2} ESCAPE '\\'
            AND EXISTS (SELECT 1 FROM menu_items mi2
                        WHERE mi2.category_id = c.id AND mi2.available = true)
        ))`);
      }
    }
    if (veg === 'true') {
      conditions.push(
        `EXISTS (SELECT 1 FROM menu_items mi WHERE mi.restaurant_id = r.id AND mi.veg = true AND mi.available = true)`
      );
    }
    if (open === 'true') {
      conditions.push('r.is_open = true');
    }
    // meal=breakfast|lunch|dinner: only restaurants with an available dish
    // served at that meal (meal_slot contains the meal, or 'all'). The param
    // used to be parsed and cache-keyed but never filtered — a silent no-op.
    if (['breakfast', 'lunch', 'dinner'].includes(meal)) {
      params.push(meal);
      const mp = '$' + params.length;
      conditions.push(`EXISTS (SELECT 1 FROM menu_items mi WHERE mi.restaurant_id = r.id
        AND mi.available = true AND ('all' = ANY(mi.meal_slot) OR ${mp} = ANY(mi.meal_slot)))`);
    }

    // ---- Smart "Recommended" scoring inputs (all from the DB, one query) ----
    // Global mean rating across rated restaurants (Bayesian prior), computed once.
    const gmRes = await db.query(
      `SELECT COALESCE(AVG(rating_avg), 0)::float AS m
       FROM restaurants WHERE status = 'approved' AND rating_avg > 0`
    );
    const globalMean = Number(gmRes.rows[0].m) || 3.5;

    // Personalization subqueries only when we know who is browsing.
    const scoreSelect = [];
    if (customerId) {
      params.push(customerId);
      const up = '$' + params.length;
      scoreSelect.push(
        `EXISTS (SELECT 1 FROM orders o WHERE o.restaurant_id = r.id AND o.customer_id = ${up} AND o.status = 'delivered') AS has_ordered`,
        `EXISTS (SELECT 1 FROM favorites f WHERE f.customer_id = ${up} AND f.entity_type = 'restaurant' AND f.entity_id = r.id::text) AS is_fav`
      );
    }
    const scoreCols = scoreSelect.length ? ',\n              ' + scoreSelect.join(',\n              ') : '';

    // sort=rating keeps the legacy highest-rated order; the DB order only
    // matters for that case — reco/fast are sorted in JS after scoring.
    const dbOrder = sort === 'rating' ? 'ORDER BY r.rating_avg DESC, r.name ASC' : '';
    const { rows } = await db.query(
      `SELECT r.*,
              COALESCE(ao.cnt, 0)::int AS active_orders,
              NULLIF(ap.avg_min, 0)::int AS avg_pack_minutes,
              COALESCE(hv.has_veg, false) AS has_veg,
              COALESCE(o7.cnt, 0)::int AS orders_7d,
              COALESCE(rn.cnt, 0)::int AS rating_n,
              COALESCE(rpo.people_ordered, 0)::int AS people_ordered,
              COALESCE(rpo7.people_ordered_7d, 0)::int AS people_ordered_7d,
              COALESCE(rsc.search_count, 0)::int AS search_count,
              rn.live_avg AS rating_avg_live${scoreCols}
       FROM restaurants r
       LEFT JOIN (SELECT restaurant_id, COUNT(*) AS cnt FROM orders
                  WHERE status IN ('placed','accepted','preparing','ready')
                  GROUP BY restaurant_id) ao ON ao.restaurant_id = r.id
       LEFT JOIN (SELECT restaurant_id, ROUND(AVG(EXTRACT(EPOCH FROM (packed_at - placed_at)) / 60)) AS avg_min
                  FROM orders WHERE packed_at IS NOT NULL
                  AND placed_at > now() - interval '30 days'
                  AND (packed_at - placed_at) < interval '120 minutes'
                  GROUP BY restaurant_id) ap ON ap.restaurant_id = r.id
       LEFT JOIN (SELECT DISTINCT restaurant_id, true AS has_veg FROM menu_items
                  WHERE veg = true AND available = true) hv ON hv.restaurant_id = r.id
       LEFT JOIN (SELECT restaurant_id, COUNT(*) AS cnt FROM orders
                  WHERE status NOT IN ('cancelled', 'rejected')
                  AND placed_at > now() - interval '7 days'
                  GROUP BY restaurant_id) o7 ON o7.restaurant_id = r.id
       LEFT JOIN (SELECT ratee_id, COUNT(*) AS cnt,
                         ROUND(AVG(food_rating)::numeric, 1)::float AS live_avg FROM ratings
                  WHERE ratee_type = 'restaurant' AND food_rating IS NOT NULL
                  GROUP BY ratee_id) rn ON rn.ratee_id = r.id
       LEFT JOIN (SELECT restaurant_id, COUNT(DISTINCT customer_id)::int AS people_ordered
                  FROM orders WHERE status = 'delivered'
                  GROUP BY restaurant_id) rpo ON rpo.restaurant_id = r.id
       LEFT JOIN (SELECT restaurant_id, COUNT(DISTINCT customer_id)::int AS people_ordered_7d
                  FROM orders WHERE status = 'delivered'
                    AND placed_at > now() - interval '7 days'
                  GROUP BY restaurant_id) rpo7 ON rpo7.restaurant_id = r.id
       LEFT JOIN (SELECT mi.restaurant_id, COUNT(*)::int AS search_count
                  FROM search_events se,
                       LATERAL jsonb_array_elements_text(se.dish_ids) AS dish_id
                  JOIN menu_items mi ON mi.id::text = dish_id
                  WHERE se.created_at > now() - interval '7 days'
                    AND se.dish_ids IS NOT NULL AND jsonb_typeof(se.dish_ids) = 'array'
                  GROUP BY mi.restaurant_id) rsc ON rsc.restaurant_id = r.id
       WHERE ${conditions.join(' AND ')} ${dbOrder}`,
      params
    );

    let config = null;
    const custLat = parseFloat(lat);
    const custLng = parseFloat(lng);
    const hasLoc = Number.isFinite(custLat) && Number.isFinite(custLng);
    if (hasLoc) config = await loadPricingConfig(db);

    // Real drive times from Google Distance Matrix (cached 10 min); falls back
    // to the haversine formula when the key is missing or the call fails.
    const gkey = process.env.GOOGLE_MAPS_KEY;
    const realETAs = (hasLoc && gkey) ? await fetchRealDriveETAs(custLat, custLng, rows, gkey) : null;

    const list = rows.map((r) => {
      let distanceKm = null;
      let fee = null;
      let eta = null; // null = hidden, never invented
      if (hasLoc && r.lat != null && r.lng != null) {
        distanceKm = haversineKm(custLat, custLng, r.lat, r.lng);
        // Customer fee model (Rs 20 base + Rs 8/km + free-km tiers) — the same
        // model checkout uses. Unknown distance leaves fee null, never wrong.
        fee = customerDeliveryFeePaise(config.customerFee, distanceKm, 0).fee_paise;
        eta = Math.round(20 + distanceKm * 3); // estimate; replaced by Matrix data when available
      }
      const real = realETAs && realETAs[r.id];
      if (real) {
        if (real.eta_minutes != null) eta = real.eta_minutes;
        if (real.distance_km != null) distanceKm = real.distance_km;
      }
      const active = Number(r.active_orders);
      // ---- Smart "Recommended" score (all inputs from the DB) ----
      // Bayesian rating: a 4.8 with 200 reviews beats a 5.0 with 2 reviews.
      const BAYES_C = 10; // confidence weight of the global prior (algorithm constant)
      const n = Number(r.rating_n) || 0;
      const bayesian = (BAYES_C * globalMean + Number(r.rating_avg) * n) / (BAYES_C + n);
      // Popularity: orders in the last 7 days, log-scaled and capped.
      const popularity = Math.min(1.5, Math.log10(1 + (Number(r.orders_7d) || 0)) * 0.75);
      // Personalization: ordered before / favorited.
      let personal = 0;
      if (r.has_ordered) personal += 1.0;
      if (r.is_fav) personal += 1.5;
      // New-restaurant bump: decays linearly over the first 30 days so new
      // places get visibility while they earn their first ratings.
      let newBump = 0;
      if (r.created_at) {
        const ageDays = (Date.now() - new Date(r.created_at).getTime()) / 86400000;
        if (ageDays >= 0 && ageDays < 30) newBump = 0.8 * (1 - ageDays / 30);
      }
      // Distance penalty: gentle nudge toward nearer restaurants; never hides
      // far ones (full-city delivery rule). Uses the real drive distance when
      // the Matrix provided one, else the haversine estimate.
      const distPenalty = distanceKm == null ? 0 : Math.min(1.0, distanceKm * 0.05);
      // Open now ranks above closed.
      const openBoost = isOpenNow(r) ? 0.5 : -2.0;
      const reco_score = Math.round((bayesian + popularity + personal + newBump - distPenalty + openBoost) * 100) / 100;
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        image_url: r.image_url,
        // Live recompute (rn.live_avg), same ROUND(AVG,1) as the detail
        // endpoint — the stored r.rating_avg is only a fallback for
        // restaurants with no ratings at all (live_avg NULL there).
        rating_avg: r.rating_avg_live == null ? Number(r.rating_avg) : Number(r.rating_avg_live),
        rating_count: n,
        people_ordered: Number(r.people_ordered) || 0,
        people_ordered_7d: Number(r.people_ordered_7d) || 0,
        search_count: Number(r.search_count) || 0,
        verified: !!r.verified,
        is_coming_soon: !!r.is_coming_soon,
        is_open: isOpenNow(r),
        opens_at: r.opens_at,
        closes_at: r.closes_at,
        opens_at_we: r.opens_at_we,
        closes_at_we: r.closes_at_we,
        load: active >= 7 ? 'slammed' : active >= 3 ? 'busy' : 'quiet',
        avg_pack_minutes: r.avg_pack_minutes != null ? Number(r.avg_pack_minutes) : null,
        birthday_dessert: !!r.birthday_dessert,
        chef_name: r.chef_name,
        chef_photo: r.chef_photo,
        distance_km: distanceKm == null ? null : Math.round(distanceKm * 10) / 10,
        delivery_fee_paise: fee,
        has_veg: !!r.has_veg,
        eta_minutes: eta,
        reco_score: reco_score
      };
    });
    // Sorting: smart score by default (and ?sort=reco); legacy options kept.
    if (sort === 'fast') {
      list.sort((a, b) => (a.eta_minutes == null ? 9999 : a.eta_minutes) - (b.eta_minutes == null ? 9999 : b.eta_minutes));
    } else if (sort === 'rating') {
      // already ordered by the DB (rating_avg DESC, name ASC)
    } else {
      // default + ?sort=reco: smart score, tie-broken by rating then name
      list.sort((a, b) => (b.reco_score - a.reco_score) || (b.rating_avg - a.rating_avg) || String(a.name).localeCompare(String(b.name)));
    }
    const out = { restaurants: list };
    cacheSet(cacheKey, out);
    res.json(out);
  })
);

// GET /api/collections — curated collections (Taste of Nellore, festivals, ...)
router.get(
  '/collections/list',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT c.* FROM collections c WHERE c.active = true ORDER BY c.sort_order, c.name`
    );
    // One batched member query for ALL collections (the old code ran one
    // query per collection — N+1).
    let members = [];
    if (rows.length) {
      const mRes = await db.query(
        `SELECT cr.collection_id, r.id, r.name, r.image_url, r.rating_avg, r.verified
         FROM collection_restaurants cr JOIN restaurants r ON r.id = cr.restaurant_id
         WHERE cr.collection_id = ANY($1) AND r.status = 'approved'`,
        [rows.map((c) => c.id)]
      );
      members = mRes.rows;
    }
    const byCollection = {};
    for (const m of members) {
      (byCollection[m.collection_id] = byCollection[m.collection_id] || []).push(m);
    }
    for (const c of rows) {
      c.restaurants = (byCollection[c.id] || []).map((r) => {
        const { collection_id: _cid, ...rest } = r;
        return { ...rest, rating_avg: Number(r.rating_avg) };
      });
    }
    res.json({ collections: rows });
  })
);

// GET /api/restaurants/charts/top-dishes — Nellore food charts: most-ordered dishes this week
router.get(
  '/charts/top-dishes',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT oi.menu_item_id, oi.name_snapshot AS name, mi.image_url, mi.veg,
              r.name AS restaurant_name, COUNT(*) AS orders
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
       LEFT JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.status = 'delivered' AND o.placed_at > now() - interval '7 days'
         AND oi.menu_item_id IS NOT NULL
       GROUP BY oi.menu_item_id, oi.name_snapshot, mi.image_url, mi.veg, r.name
       ORDER BY orders DESC LIMIT 20`
    );
    res.json({ top_dishes: rows.map((x) => ({ ...x, orders: Number(x.orders) })) });
  })
);

// GET /api/restaurants/charts/trending-searches — most-searched terms, last 7 days
router.get(
  '/charts/trending-searches',
  ah(async (req, res) => {
    try { await ensureSearchLogs(); } catch (e) { /* table may not exist yet */ }
    let rows = [];
    try {
      const r = await db.query(
        `SELECT q AS term, COUNT(*)::int AS searches FROM search_logs
         WHERE created_at >= now() - interval '7 days'
         GROUP BY q ORDER BY searches DESC, q ASC LIMIT 8`
      );
      rows = r.rows;
    } catch (e) { rows = []; }
    res.json({ trending_searches: rows });
  })
);

// GET /api/restaurants/charts/trending-now — dishes ordered in the last 3 hours
router.get(
  '/charts/trending-now',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT oi.menu_item_id, oi.name_snapshot AS name, mi.image_url, mi.price_paise,
              mi.veg, r.id AS restaurant_id, r.name AS restaurant_name, COUNT(*) AS orders,
              COALESCE(dr.avg_rating, 0)::float AS rating_avg,
              COALESCE(dr.rating_count, 0)::int AS rating_count
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
       LEFT JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN (SELECT dish_id, AVG(rating) AS avg_rating, COUNT(*) AS rating_count
                  FROM dish_ratings GROUP BY dish_id) dr ON dr.dish_id = oi.menu_item_id
       WHERE o.status IN ('placed','accepted','preparing','ready','picked_up','on_way','delivered')
         AND o.placed_at > now() - interval '3 hours'
         AND oi.menu_item_id IS NOT NULL
       GROUP BY oi.menu_item_id, oi.name_snapshot, mi.image_url, mi.price_paise, mi.veg, r.id, r.name,
                dr.avg_rating, dr.rating_count
       ORDER BY orders DESC LIMIT 10`
    );
    res.json({ trending: rows.map((x) => ({ ...x, orders: Number(x.orders) })) });
  })
);

// GET /api/restaurants/:id/rating-summary -> public rating distribution
router.get(
  '/:id/rating-summary',
  ah(async (req, res) => {
    // Validate UUID format to avoid leaking raw DB errors
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    const { rows } = await db.query(
      `SELECT COUNT(*)::int AS count,
              ROUND(AVG(food_rating)::numeric, 1)::float AS avg,
              COUNT(*) FILTER (WHERE food_rating = 5)::int AS s5,
              COUNT(*) FILTER (WHERE food_rating = 4)::int AS s4,
              COUNT(*) FILTER (WHERE food_rating = 3)::int AS s3,
              COUNT(*) FILTER (WHERE food_rating = 2)::int AS s2,
              COUNT(*) FILTER (WHERE food_rating = 1)::int AS s1
       FROM ratings
       WHERE ratee_type = 'restaurant' AND ratee_id = $1 AND food_rating IS NOT NULL`,
      [req.params.id]
    );
    const r = rows[0];
    res.json({
      avg: r.avg == null ? null : Number(r.avg),
      count: r.count,
      dist: { 5: r.s5, 4: r.s4, 3: r.s3, 2: r.s2, 1: r.s1 }
    });
  })
);


// GET /api/restaurants/on-the-way?from_lat=&from_lng=&to_lat=&to_lng=&primary_id=
// Simple on-the-way discovery (user-dictated 2026-10-13):
//   - Only restaurants within 500m (straight-line) of the X→Z route segment.
//   - Each shows delivery_fee_paise = flat on-the-way fee (Rs 5 default).
// No detour calculations, no Routes API calls.
router.get(
  '/on-the-way',
  ah(async (req, res) => {
    const t0 = Date.now();
    const fromLat = Number(req.query.from_lat);
    const fromLng = Number(req.query.from_lng);
    const toLat = Number(req.query.to_lat);
    const toLng = Number(req.query.to_lng);
    if (![fromLat, fromLng, toLat, toLng].every((n) => Number.isFinite(n))) {
      return res.status(400).json({ error: 'from_lat, from_lng, to_lat, to_lng are required' });
    }
    const primaryId = req.query.primary_id ? String(req.query.primary_id) : null;

    const config = await loadPricingConfig(db);
    const THRESHOLD_KM = 0.5; // "on the way" = within 500m of the X→Z route

    const { rows } = await db.query(
      `SELECT id, name, image_url, lat, lng, is_open, rating_avg AS rating
       FROM restaurants
       WHERE status = 'approved' AND is_open = true AND lat IS NOT NULL AND lng IS NOT NULL`
    );

    // Simple: within 500m (straight-line) of the X→Z segment → on the way.
    // Fee = flat on-the-way fee (Rs 5 default, config-driven).
    const out = [];
    for (const r of rows) {
      if (primaryId && String(r.id) === primaryId) continue;
      const distKm = pointToSegKm(
        Number(r.lng), Number(r.lat),
        fromLng, fromLat,
        toLng, toLat
      );
      if (distKm > THRESHOLD_KM) continue;
      const yzKm = haversineKm(Number(r.lat), Number(r.lng), toLat, toLng);
      const normalFee = deliveryFeePaise(config.deliveryTiers, yzKm);
      const feePaise = otwSecondaryFeePaise(normalFee, config);
      out.push({
        id: r.id,
        name: r.name,
        photo_url: r.image_url,
        image_url: r.image_url,
        is_open: !!r.is_open,
        rating: r.rating,
        route_dist_km: Math.round(distKm * 100) / 100,
        delivery_fee_paise: feePaise,
      });
    }
    out.sort((a, b) => a.route_dist_km - b.route_dist_km);

    const elapsedMs = Date.now() - t0;
    res.json({ restaurants: out.slice(0, 20), _elapsed_ms: elapsedMs });
  })
);

// Search-query logging for trending searches (last 7 days). Table is created
// lazily on first use; logging failures never break search.
let searchLogsReady = false;
async function ensureSearchLogs() {
  if (searchLogsReady) return;
  await db.query(`CREATE TABLE IF NOT EXISTS search_logs (
    id SERIAL PRIMARY KEY,
    q TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await db.query('CREATE INDEX IF NOT EXISTS idx_search_logs_created ON search_logs (created_at)');
  searchLogsReady = true;
}

// GET /api/restaurants/dishes/search?q=&max_price_paise= — Ask Floop dish search
// Spelling-tolerant via ILIKE; accepts missing q (returns popular available dishes).
router.get(
  '/dishes/search',
  ah(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const maxPrice = req.query.max_price_paise ? Number(req.query.max_price_paise) : null;
    // Pagination: limit (default 30, max 100) + offset, with a total count
    // so the frontend can page instead of hitting a silent hard cap.
    const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    // Log submitted searches for trending-searches (never breaks search on failure).
    if (q) {
      try {
        await ensureSearchLogs();
        const nq = q.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 100);
        if (nq.length >= 2) await db.query('INSERT INTO search_logs (q) VALUES ($1)', [nq]);
      } catch (e) { /* ignore logging errors */ }
    }
    const params = [];
    const conditions = [
      'mi.available = true',
      "r.status = 'approved'",
      'r.is_open = true',
      'COALESCE(r.is_coming_soon, false) = false',
    ];
    if (q) {
      // Split into words; every word must appear in the dish name (order-free,
      // spelling-tolerant-ish via ILIKE). Frontend also sends alias-normalized q.
      // Digits are kept: "paneer 65" must search "65" too, not just "paneer".
      const words = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
      for (const w of words.slice(0, 5)) {
        params.push(`%${w}%`);
        conditions.push(`mi.name ILIKE $${params.length}`);
      }
      if (!words.length) {
        params.push(`%${q}%`);
        conditions.push(`mi.name ILIKE $${params.length}`);
      }
    }
    if (Number.isFinite(maxPrice) && maxPrice > 0) {
      params.push(String(Math.round(maxPrice)));
      conditions.push(`mi.price_paise <= $${params.length}`);
    }
    const whereSql = conditions.join(' AND ');
    const totalRes = await db.query(
      `SELECT COUNT(*)::int AS n
       FROM menu_items mi
       JOIN restaurants r ON r.id = mi.restaurant_id
       WHERE ${whereSql}`,
      params
    );
    const pageParams = [...params, limit, offset];
    const { rows } = await db.query(
      `SELECT mi.id, mi.name, mi.price_paise, mi.image_url, mi.veg, mi.description,
              mi.calories AS calories_kcal,
              mi.protein_g,
              mi.restaurant_id, r.name AS restaurant_name, r.image_url AS restaurant_image,
              r.rating_avg AS restaurant_rating, r.is_open AS restaurant_open,
              COALESCE(dr.avg_rating, 0)::float AS rating_avg,
              COALESCE(dr.rating_count, 0)::int AS rating_count,
              COALESCE(po.people_ordered, 0)::int AS people_ordered,
              COALESCE(po7.people_ordered_7d, 0)::int AS people_ordered_7d,
              COALESCE(sc.search_count, 0)::int AS search_count
       FROM menu_items mi
       JOIN restaurants r ON r.id = mi.restaurant_id
       LEFT JOIN (
         SELECT dish_id, AVG(rating) AS avg_rating, COUNT(*) AS rating_count
         FROM dish_ratings GROUP BY dish_id
       ) dr ON dr.dish_id = mi.id
       LEFT JOIN (
         SELECT oi.menu_item_id, COUNT(DISTINCT o.customer_id)::int AS people_ordered
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.status = 'delivered' AND oi.menu_item_id IS NOT NULL
         GROUP BY oi.menu_item_id
       ) po ON po.menu_item_id = mi.id
       LEFT JOIN (
         SELECT oi.menu_item_id, COUNT(DISTINCT o.customer_id)::int AS people_ordered_7d
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.status = 'delivered' AND oi.menu_item_id IS NOT NULL
           AND o.placed_at > now() - interval '7 days'
         GROUP BY oi.menu_item_id
       ) po7 ON po7.menu_item_id = mi.id
       LEFT JOIN (
         SELECT dish_id, COUNT(*)::int AS search_count
         FROM search_events se,
              LATERAL jsonb_array_elements_text(se.dish_ids) AS dish_id
         WHERE se.created_at > now() - interval '7 days'
           AND se.dish_ids IS NOT NULL AND jsonb_typeof(se.dish_ids) = 'array'
         GROUP BY dish_id
       ) sc ON sc.dish_id = mi.id::text
       WHERE ${whereSql}
       ORDER BY r.rating_avg DESC NULLS LAST, mi.price_paise ASC
       LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
      pageParams
    );
    res.json({
      dishes: rows.map((d) => ({
        ...d,
        price_paise: Number(d.price_paise),
        rating_avg: Number(d.rating_avg) || 0,
        rating_count: Number(d.rating_count) || 0,
        restaurant_rating: d.restaurant_rating == null ? null : Number(d.restaurant_rating),
        protein_g: d.protein_g != null ? Number(d.protein_g) : null,
      })),
      total: totalRes.rows[0].n,
      limit,
      offset,
    });
  })
);

// GET /api/restaurants/:id -> restaurant + categories + available menu items
router.get(
  '/:id',
  ah(async (req, res) => {
    // Validate UUID format to avoid leaking raw DB errors
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    // Parallelize independent queries: restaurant + live ratings + categories
    const [restRes, liveRatings, catsRes, countsRes] = await Promise.all([
      db.query(
        "SELECT * FROM restaurants WHERE id = $1 AND status = 'approved'",
        [req.params.id]
      ),
      db.query(
        `SELECT COUNT(*)::int AS count,
                ROUND(AVG(food_rating)::numeric, 1)::float AS avg
         FROM ratings
         WHERE ratee_type = 'restaurant' AND ratee_id = $1 AND food_rating IS NOT NULL`,
        [req.params.id]
      ),
      db.query(
        'SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY sort_order, name',
        [req.params.id]
      ),
      db.query(
        `SELECT
           (SELECT COUNT(DISTINCT customer_id)::int FROM orders
            WHERE restaurant_id = $1 AND status = 'delivered') AS people_ordered,
           (SELECT COUNT(DISTINCT customer_id)::int FROM orders
            WHERE restaurant_id = $1 AND status = 'delivered'
              AND placed_at > now() - interval '7 days') AS people_ordered_7d,
           (SELECT COUNT(*)::int FROM search_events se,
              LATERAL jsonb_array_elements_text(se.dish_ids) AS dish_id
            JOIN menu_items mi ON mi.id::text = dish_id
            WHERE mi.restaurant_id = $1
              AND se.created_at > now() - interval '7 days'
              AND se.dish_ids IS NOT NULL AND jsonb_typeof(se.dish_ids) = 'array') AS search_count`,
        [req.params.id]
      ),
    ]);
    const restaurant = restRes.rows[0];
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });
    const cats = catsRes;
    const lr = liveRatings.rows[0] || {};
    restaurant.rating_avg = lr.avg == null ? 0 : Number(lr.avg);
    restaurant.rating_count = Number(lr.count) || 0;

    const meal = req.query.meal; // breakfast | lunch | dinner
    const itemParams = [restaurant.id];
    let mealCond = '';
    if (['breakfast', 'lunch', 'dinner'].includes(meal)) {
      itemParams.push(meal);
      mealCond = ` AND ('all' = ANY(meal_slot) OR $${itemParams.length} = ANY(meal_slot))`;
    }
    const items = await db.query(
      `SELECT mi.*, mi.calories AS calories_kcal,
              COALESCE(dr.avg_rating, 0)::float AS rating_avg,
              COALESCE(dr.rating_count, 0)::int AS rating_count,
              COALESCE(po.people_ordered, 0)::int AS people_ordered,
              COALESCE(po7.people_ordered_7d, 0)::int AS people_ordered_7d,
              COALESCE(sc.search_count, 0)::int AS search_count
       FROM menu_items mi
       LEFT JOIN (
         SELECT dish_id, AVG(rating) AS avg_rating, COUNT(*) AS rating_count
         FROM dish_ratings GROUP BY dish_id
       ) dr ON dr.dish_id = mi.id
       LEFT JOIN (
         SELECT oi.menu_item_id, COUNT(DISTINCT o.customer_id)::int AS people_ordered
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.status = 'delivered' AND oi.menu_item_id IS NOT NULL
         GROUP BY oi.menu_item_id
       ) po ON po.menu_item_id = mi.id
       LEFT JOIN (
         SELECT oi.menu_item_id, COUNT(DISTINCT o.customer_id)::int AS people_ordered_7d
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.status = 'delivered' AND oi.menu_item_id IS NOT NULL
           AND o.placed_at > now() - interval '7 days'
         GROUP BY oi.menu_item_id
       ) po7 ON po7.menu_item_id = mi.id
       LEFT JOIN (
         SELECT dish_id, COUNT(*)::int AS search_count
         FROM search_events se,
              LATERAL jsonb_array_elements_text(se.dish_ids) AS dish_id
         WHERE se.created_at > now() - interval '7 days'
           AND se.dish_ids IS NOT NULL AND jsonb_typeof(se.dish_ids) = 'array'
         GROUP BY dish_id
       ) sc ON sc.dish_id = mi.id::text
       WHERE mi.restaurant_id = $1 AND mi.available = true${mealCond}
       ORDER BY mi.is_combo DESC, mi.sort_order, mi.name`,
      itemParams
    );
    // Attach customizations to items
    const itemIds = items.rows.map((i) => i.id);
    let custByItem = {};
    if (itemIds.length) {
      const groups = await db.query(
        `SELECT * FROM customization_groups WHERE menu_item_id = ANY($1) ORDER BY sort, name`,
        [itemIds]
      );
      const groupIds = groups.rows.map((g) => g.id);
      let optsByGroup = {};
      if (groupIds.length) {
        const opts = await db.query(
          `SELECT * FROM customization_options WHERE group_id = ANY($1) ORDER BY sort, name`,
          [groupIds]
        );
        for (const o of opts.rows) {
          (optsByGroup[o.group_id] = optsByGroup[o.group_id] || []).push(o);
        }
      }
      for (const g of groups.rows) {
        g.options = optsByGroup[g.id] || [];
        (custByItem[g.menu_item_id] = custByItem[g.menu_item_id] || []).push(g);
      }
    }
    const byCat = {};
    for (const it of items.rows) {
      it.customizations = custByItem[it.id] || [];
      const key = it.category_id || 'uncategorized';
      (byCat[key] = byCat[key] || []).push(it);
    }
    const photos = await db.query(
      `SELECT photo_url, food_rating, created_at FROM ratings
       WHERE ratee_type = 'restaurant' AND ratee_id = $1 AND photo_url IS NOT NULL
       ORDER BY created_at DESC LIMIT 12`,
      [restaurant.id]
    );
    const dLat = parseFloat(req.query.lat);
    const dLng = parseFloat(req.query.lng);
    let detailDist = null;
    if (Number.isFinite(dLat) && Number.isFinite(dLng) && restaurant.lat != null && restaurant.lng != null) {
      detailDist = Math.round(haversineKm(dLat, dLng, Number(restaurant.lat), Number(restaurant.lng)) * 10) / 10;
    }
    // Strip PII/sensitive fields before sending to client
    const { aadhar, aadhar_last4, gstin, owner_id, commission_pct, bank_account, ifsc, phone, fssai, fssai_license, ...safeRestaurant } = restaurant;
    res.json({
      restaurant: { ...safeRestaurant, rating_avg: Number(restaurant.rating_avg), is_open: isOpenNow(restaurant),
        verified: !!restaurant.verified, distance_km: detailDist,
        people_ordered: Number(countsRes.rows[0].people_ordered) || 0,
        people_ordered_7d: Number(countsRes.rows[0].people_ordered_7d) || 0,
        search_count: Number(countsRes.rows[0].search_count) || 0 },
      categories: cats.rows.map((c) => ({ ...c, items: byCat[c.id] || [] })),
      uncategorized: byCat.uncategorized || [],
      review_photos: photos.rows
    });
  })
);

module.exports = router;
