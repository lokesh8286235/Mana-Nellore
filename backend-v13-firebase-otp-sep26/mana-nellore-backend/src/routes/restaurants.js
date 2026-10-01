// Public restaurant discovery (customer app home + restaurant page).
const express = require('express');
const db = require('../db');
const { ah } = require('../middleware/auth');
const { haversineKm, loadPricingConfig, deliveryFeePaise } = require('../lib/pricing');

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

// GET /api/restaurants?q=&veg=&open=&lat=&lng=&meal=
router.get(
  '/',
  ah(async (req, res) => {
    const { q, veg, open, lat, lng, meal } = req.query;
    const cacheKey = JSON.stringify({ q, veg, open, lat, lng, meal });
    const cached = cacheGet(cacheKey);
    if (cached) return res.json(cached);

    // Live (approved) restaurants plus Coming-soon ones (pending, not approved yet).
    // Coming soon is a visibility state, not an approval: customers see the full
    // menu but the apps + order guard block ordering until finalized.
    const conditions = ["(r.status = 'approved' OR r.is_coming_soon = true)"];
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
      // Perf: reuse the hv JOIN (already computed for has_veg) instead of a
      // correlated EXISTS per restaurant.
      conditions.push(`hv.rid IS NOT NULL`);
    }
    if (open === 'true') {
      conditions.push('r.is_open = true');
    }

    // Perf: the three per-restaurant aggregates are pre-computed once via LEFT
    // JOINs instead of correlated subqueries (was ~300ms per cache miss).
    const { rows } = await db.query(
      `SELECT r.*,
              COALESCE(ao.cnt, 0) AS active_orders,
              ap.avg_mins AS avg_pack_minutes,
              (hv.rid IS NOT NULL) AS has_veg
       FROM restaurants r
       LEFT JOIN (
         SELECT restaurant_id, COUNT(*) AS cnt FROM orders
         WHERE status IN ('placed','accepted','preparing','ready')
         GROUP BY restaurant_id
       ) ao ON ao.restaurant_id = r.id
       LEFT JOIN (
         SELECT restaurant_id,
                ROUND(AVG(EXTRACT(EPOCH FROM (packed_at - placed_at)) / 60)) AS avg_mins
         FROM orders
         WHERE packed_at IS NOT NULL AND placed_at > now() - interval '30 days'
         GROUP BY restaurant_id
       ) ap ON ap.restaurant_id = r.id
       LEFT JOIN (
         SELECT DISTINCT restaurant_id AS rid FROM menu_items
         WHERE veg = true AND available = true
       ) hv ON hv.rid = r.id
       WHERE ${conditions.join(' AND ')} ORDER BY r.rating_avg DESC, r.name ASC`,
      params
    );

    let config = null;
    const custLat = parseFloat(lat);
    const custLng = parseFloat(lng);
    const hasLoc = Number.isFinite(custLat) && Number.isFinite(custLng);
    if (hasLoc) config = await loadPricingConfig(db);

    const list = rows.map((r) => {
      let distanceKm = null;
      let fee = null;
      if (hasLoc && r.lat != null && r.lng != null) {
        distanceKm = haversineKm(custLat, custLng, r.lat, r.lng);
        fee = deliveryFeePaise(config.deliveryTiers, distanceKm, 0, []);
      }
      const active = Number(r.active_orders);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        image_url: r.image_url,
        rating_avg: Number(r.rating_avg),
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
        is_coming_soon: !!r.is_coming_soon,
        eta_minutes: distanceKm == null ? 30 : Math.round(20 + distanceKm * 3)
      };
    });
    // Nearest first when we know where the customer is
    if (hasLoc) {
      list.sort((a, b) => (a.distance_km == null ? 9999 : a.distance_km) - (b.distance_km == null ? 9999 : b.distance_km));
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

// GET /api/restaurants/:id -> restaurant + categories + available menu items
// GET /api/restaurants/dishes/search?q=biryani&max_price_paise=50000&veg=true
// Cross-restaurant dish search for the "Ask Mana" conversational ordering.
// Must sit BEFORE /:id so Express doesn't treat "dishes" as an id.
// q is optional: without it, browses every dish under the price cap
// ("for 10 under 1000" with no dish named).
router.get(
  '/dishes/search',
  ah(async (req, res) => {
    const q = (req.query.q || '').trim();
    const maxPrice = req.query.max_price_paise != null ? Number(req.query.max_price_paise) : null;
    const vegOnly = req.query.veg === 'true';
    const clauses = [];
    const params = [];
    if (q) {
      params.push('%' + q + '%');
      /* spelling-tolerant: menu spellings vary (Idly vs Idli, Biriyani vs Biryani).
         Normalising y->i on both sides merges that whole class of typos. */
      clauses.push(`REPLACE(LOWER(m.name), 'y', 'i') LIKE REPLACE(LOWER($${params.length}), 'y', 'i')`);
    }
    if (Number.isFinite(maxPrice) && maxPrice >= 0) {
      params.push(Math.floor(maxPrice));
      clauses.push(`m.price_paise <= $${params.length}`);
    }
    if (vegOnly) clauses.push('m.veg = true');
    const { rows } = await db.query(
      `SELECT m.id, m.name, m.price_paise, m.veg, m.image_url,
              r.id AS restaurant_id, r.name AS restaurant_name,
              r.rating_avg, r.is_coming_soon
       FROM menu_items m
       JOIN restaurants r ON r.id = m.restaurant_id
       WHERE m.available = true
         AND r.status = 'approved' AND r.is_coming_soon = false
         ${clauses.map((c) => 'AND ' + c).join(' ')}
       ORDER BY m.price_paise ASC
       LIMIT 30`,
      params
    );
    res.json({
      dishes: rows.map((d) => ({
        id: d.id,
        name: d.name,
        price_paise: d.price_paise,
        veg: !!d.veg,
        image_url: d.image_url,
        restaurant_id: d.restaurant_id,
        restaurant_name: d.restaurant_name,
        rating_avg: Number(d.rating_avg) || 0,
      })),
    });
  })
);

router.get(
  '/:id',
  ah(async (req, res) => {
    // Validate UUID format to avoid leaking raw DB errors
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    const { rows } = await db.query(
      "SELECT * FROM restaurants WHERE id = $1 AND (status = 'approved' OR is_coming_soon = true)",
      [req.params.id]
    );
    const restaurant = rows[0];
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const cats = await db.query(
      'SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY sort_order, name',
      [restaurant.id]
    );
    const meal = req.query.meal; // breakfast | lunch | dinner
    const itemParams = [restaurant.id];
    let mealCond = '';
    if (['breakfast', 'lunch', 'dinner'].includes(meal)) {
      itemParams.push(meal);
      mealCond = ` AND ('all' = ANY(meal_slot) OR $${itemParams.length} = ANY(meal_slot))`;
    }
    const items = await db.query(
      `SELECT * FROM menu_items WHERE restaurant_id = $1 AND available = true${mealCond}
       ORDER BY is_combo DESC, sort_order, name`,
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
    res.json({
      // Whitelisted public fields only: the raw row carries owner PII
      // (aadhar, fssai, owner_id, gstin) that must never reach clients.
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        description: restaurant.description,
        address: restaurant.address,
        phone: restaurant.phone,
        image_url: restaurant.image_url,
        rating_avg: Number(restaurant.rating_avg),
        is_open: isOpenNow(restaurant),
        verified: !!restaurant.verified,
        opens_at: restaurant.opens_at,
        closes_at: restaurant.closes_at,
        opens_at_we: restaurant.opens_at_we,
        closes_at_we: restaurant.closes_at_we,
        birthday_dessert: !!restaurant.birthday_dessert,
        chef_name: restaurant.chef_name,
        chef_photo: restaurant.chef_photo,
        chef_story: restaurant.chef_story,
        is_coming_soon: !!restaurant.is_coming_soon,
        distance_km: detailDist
      },
      categories: cats.rows.map((c) => ({ ...c, items: byCat[c.id] || [] })),
      uncategorized: byCat.uncategorized || [],
      review_photos: photos.rows
    });
  })
);

module.exports = router;
