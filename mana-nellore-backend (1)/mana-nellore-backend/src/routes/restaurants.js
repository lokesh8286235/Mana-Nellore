// Public restaurant discovery (customer app home + restaurant page).
const express = require('express');
const db = require('../db');
const { ah } = require('../middleware/auth');
const { haversineKm, loadPricingConfig, deliveryFeePaise } = require('../lib/pricing');

const router = express.Router();

function isOpenNow(r) {
  if (!r.is_open) return false;
  if (!r.opens_at || !r.closes_at) return r.is_open;
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const [oh, om] = String(r.opens_at).split(':').map(Number);
  const [ch, cm] = String(r.closes_at).split(':').map(Number);
  const open = oh * 60 + om;
  const close = ch * 60 + cm;
  if (close > open) return mins >= open && mins < close;
  return mins >= open || mins < close; // overnight hours
}

// GET /api/restaurants?q=&veg=&open=&lat=&lng=
router.get(
  '/',
  ah(async (req, res) => {
    const { q, veg, open, lat, lng } = req.query;
    const conditions = ["r.status = 'approved'"];
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      const qp = `$${params.length}`;
      conditions.push(`(r.name ILIKE ${qp} OR r.description ILIKE ${qp} OR EXISTS (
        SELECT 1 FROM menu_items mi
        WHERE mi.restaurant_id = r.id AND mi.available = true AND mi.name ILIKE ${qp}
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

    const { rows } = await db.query(
      `SELECT r.* FROM restaurants r WHERE ${conditions.join(' AND ')} ORDER BY r.rating_avg DESC, r.name ASC`,
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
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        image_url: r.image_url,
        rating_avg: Number(r.rating_avg),
        is_open: isOpenNow(r),
        opens_at: r.opens_at,
        closes_at: r.closes_at,
        distance_km: distanceKm == null ? null : Math.round(distanceKm * 10) / 10,
        delivery_fee_paise: fee,
        eta_minutes: distanceKm == null ? 30 : Math.round(20 + distanceKm * 3)
      };
    });
    res.json({ restaurants: list });
  })
);

// GET /api/restaurants/:id -> restaurant + categories + available menu items
router.get(
  '/:id',
  ah(async (req, res) => {
    const { rows } = await db.query(
      "SELECT * FROM restaurants WHERE id = $1 AND status = 'approved'",
      [req.params.id]
    );
    const restaurant = rows[0];
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' });

    const cats = await db.query(
      'SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY sort_order, name',
      [restaurant.id]
    );
    const items = await db.query(
      `SELECT * FROM menu_items WHERE restaurant_id = $1 AND available = true
       ORDER BY sort_order, name`,
      [restaurant.id]
    );
    const byCat = {};
    for (const it of items.rows) {
      const key = it.category_id || 'uncategorized';
      (byCat[key] = byCat[key] || []).push(it);
    }
    res.json({
      restaurant: { ...restaurant, rating_avg: Number(restaurant.rating_avg), is_open: isOpenNow(restaurant) },
      categories: cats.rows.map((c) => ({ ...c, items: byCat[c.id] || [] })),
      uncategorized: byCat.uncategorized || []
    });
  })
);

module.exports = router;
