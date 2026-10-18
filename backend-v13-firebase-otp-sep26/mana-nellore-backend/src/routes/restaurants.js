// Public restaurant discovery (customer app home + restaurant page).
const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { ah } = require('../middleware/auth');
const { haversineKm, loadPricingConfig, deliveryFeePaise, otwSecondaryFeePaise } = require('../lib/pricing');
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

    const conditions = ["r.status = 'approved'"];
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      const qp = `$${params.length}`;
      conditions.push(`(r.name ILIKE ${qp} OR r.description ILIKE ${qp} OR EXISTS (
        SELECT 1 FROM menu_items mi
        WHERE mi.restaurant_id = r.id AND mi.available = true AND mi.name ILIKE ${qp}
      ) OR EXISTS (
        SELECT 1 FROM categories c
        WHERE c.restaurant_id = r.id AND c.name ILIKE ${qp}
          AND EXISTS (SELECT 1 FROM menu_items mi2
                      WHERE mi2.category_id = c.id AND mi2.available = true)
      ))`);
    }
    if (veg === 'true') {
      conditions.push(
        `EXISTS (SELECT 1 FROM menu_items mi WHERE mi.restaurant_id = r.id AND mi.veg = true AND mi.available = true)`
      );
    }
    if (open === 'true') {
      conditions.push('r.is_open = true');
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
              COALESCE(ap.avg_min, 0)::int AS avg_pack_minutes,
              COALESCE(hv.has_veg, false) AS has_veg,
              COALESCE(o7.cnt, 0)::int AS orders_7d,
              COALESCE(rn.cnt, 0)::int AS rating_n${scoreCols}
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
       LEFT JOIN (SELECT ratee_id, COUNT(*) AS cnt FROM ratings
                  WHERE ratee_type = 'restaurant' AND food_rating IS NOT NULL
                  GROUP BY ratee_id) rn ON rn.ratee_id = r.id
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
        fee = deliveryFeePaise(config.deliveryTiers, distanceKm, 0, []);
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
        rating_avg: Number(r.rating_avg),
        rating_count: n,
        verified: !!r.verified,
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
    for (const c of rows) {
      const rs = await db.query(
        `SELECT r.id, r.name, r.image_url, r.rating_avg, r.verified
         FROM collection_restaurants cr JOIN restaurants r ON r.id = cr.restaurant_id
         WHERE cr.collection_id = $1 AND r.status = 'approved'`,
        [c.id]
      );
      c.restaurants = rs.rows.map((r) => ({ ...r, rating_avg: Number(r.rating_avg) }));
    }
    res.json({ collections: rows });
  })
);

// GET /api/restaurants/charts/top-dishes — Nellore food charts: most-ordered dishes this week
router.get(
  '/charts/top-dishes',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT oi.menu_item_id, oi.name_snapshot AS name, mi.image_url,
              r.name AS restaurant_name, COUNT(*) AS orders
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id
       LEFT JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.status = 'delivered' AND o.placed_at > now() - interval '7 days'
       GROUP BY oi.menu_item_id, oi.name_snapshot, mi.image_url, r.name
       ORDER BY orders DESC LIMIT 20`
    );
    res.json({ top_dishes: rows.map((x) => ({ ...x, orders: Number(x.orders) })) });
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
       WHERE status = 'approved' AND lat IS NOT NULL AND lng IS NOT NULL`
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
      const normalFee = deliveryFeePaise(config.deliveryTiers, yzKm, 0, []);
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

// GET /api/restaurants/dishes/search?q=&max_price_paise= — Ask Floop dish search
// Spelling-tolerant via ILIKE; accepts missing q (returns popular available dishes).
router.get(
  '/dishes/search',
  ah(async (req, res) => {
    const q = String(req.query.q || '').trim();
    const maxPrice = req.query.max_price_paise ? Number(req.query.max_price_paise) : null;
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
      const words = q.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 1);
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
    const { rows } = await db.query(
      `SELECT mi.id, mi.name, mi.price_paise, mi.image_url, mi.veg, mi.description,
              mi.restaurant_id, r.name AS restaurant_name, r.image_url AS restaurant_image,
              r.rating_avg AS restaurant_rating, r.is_open AS restaurant_open,
              COALESCE(dr.avg_rating, 0)::float AS rating_avg,
              COALESCE(dr.rating_count, 0)::int AS rating_count
       FROM menu_items mi
       JOIN restaurants r ON r.id = mi.restaurant_id
       LEFT JOIN (
         SELECT dish_id, AVG(rating) AS avg_rating, COUNT(*) AS rating_count
         FROM dish_ratings GROUP BY dish_id
       ) dr ON dr.dish_id = mi.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.rating_avg DESC NULLS LAST, mi.price_paise ASC
       LIMIT 30`,
      params
    );
    res.json({
      dishes: rows.map((d) => ({
        ...d,
        price_paise: Number(d.price_paise),
        rating_avg: Number(d.rating_avg) || 0,
        rating_count: Number(d.rating_count) || 0,
        restaurant_rating: d.restaurant_rating == null ? null : Number(d.restaurant_rating),
      })),
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
    const [restRes, liveRatings, catsRes] = await Promise.all([
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
      `SELECT mi.*,
              COALESCE(dr.avg_rating, 0)::float AS rating_avg,
              COALESCE(dr.rating_count, 0)::int AS rating_count
       FROM menu_items mi
       LEFT JOIN (
         SELECT dish_id, AVG(rating) AS avg_rating, COUNT(*) AS rating_count
         FROM dish_ratings GROUP BY dish_id
       ) dr ON dr.dish_id = mi.id
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
    const { aadhar, gstin, owner_id, commission_pct, bank_account, ifsc, ...safeRestaurant } = restaurant;
    res.json({
      restaurant: { ...safeRestaurant, rating_avg: Number(restaurant.rating_avg), is_open: isOpenNow(restaurant),
        verified: !!restaurant.verified, distance_km: detailDist },
      categories: cats.rows.map((c) => ({ ...c, items: byCat[c.id] || [] })),
      uncategorized: byCat.uncategorized || [],
      review_photos: photos.rows
    });
  })
);

module.exports = router;
