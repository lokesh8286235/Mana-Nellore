// Public (unauthenticated) endpoints: dine-in QR lookup, restaurant
// applications, and shareable order tracking links.
const express = require('express');
const db = require('../db');
const { ah, optionalAuth } = require('../middleware/auth');
const { normalizeTaxRates } = require('../lib/pricing');
const secure = require('../lib/secure');

const router = express.Router();

// GET /api/tables/:token — resolve a dine-in QR code to restaurant + table
router.get(
  '/tables/:token',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT t.id AS table_id, t.label, r.id AS restaurant_id, r.name AS restaurant_name,
              r.image_url, r.is_open
       FROM tables t JOIN restaurants r ON r.id = t.restaurant_id
       WHERE t.qr_token = $1 AND r.status = 'approved'`,
      [req.params.token]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Table not found' });
    res.json({ table: rows[0] });
  })
);

// GET /api/applications/check?phone= — does this number already have a
// restaurant account, a restaurant, or a pending application? Lets the
// "new restaurant" form warn before the user fills everything in.
router.get(
  '/applications/check',
  ah(async (req, res) => {
    let digits = String(req.query.phone || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (!/^\d{10}$/.test(digits)) return res.json({ registered: false, applied: false });
    const { rows } = await db.query(
      `SELECT 'registered' AS kind FROM users WHERE RIGHT(phone, 10) = $1 AND role = 'restaurant_owner'
       UNION ALL
       SELECT 'registered' FROM restaurants WHERE RIGHT(phone, 10) = $1
       UNION ALL
       SELECT 'applied' FROM restaurant_applications WHERE RIGHT(phone, 10) = $1 AND status = 'pending'
       LIMIT 1`,
      [digits]
    );
    const kind = rows[0] && rows[0].kind;
    res.json({ registered: kind === 'registered', applied: kind === 'applied' });
  })
);

// POST /api/applications — restaurant onboarding application.
// A photo is MANDATORY: the application cannot be submitted without one.
// Address, FSSAI license and owner Aadhar are also mandatory.
router.post(
  '/applications',
  ah(async (req, res) => {
    const { restaurant_name, owner_name, phone, address, lat, lng, fssai, aadhar, photo_url } = req.body || {};
    if (!restaurant_name || !owner_name || !phone) {
      return res.status(400).json({ error: 'Restaurant name, owner name and phone are required' });
    }
    // Normalize to 10 digits so duplicates are caught regardless of formatting.
    let digits = String(phone).replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (!/^\d{10}$/.test(digits)) {
      return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
    }
    // Duplicate guard: a number that already has a restaurant account, an
    // approved restaurant, or a pending application cannot apply again as "new".
    const dupe = await db.query(
      `SELECT 'registered' AS kind FROM users WHERE RIGHT(phone, 10) = $1 AND role = 'restaurant_owner'
       UNION ALL
       SELECT 'registered' FROM restaurants WHERE RIGHT(phone, 10) = $1
       UNION ALL
       SELECT 'applied' FROM restaurant_applications WHERE RIGHT(phone, 10) = $1 AND status = 'pending'
       LIMIT 1`,
      [digits]
    );
    if (dupe.rows[0]) {
      const already = dupe.rows[0].kind === 'registered';
      return res.status(409).json({
        code: already ? 'already_registered' : 'already_applied',
        error: already
          ? 'There is already an account with this mobile number. Please go back and log in.'
          : 'You have already applied with this mobile number. Your application is under review.'
      });
    }
    if (!address || !String(address).trim()) {
      return res.status(400).json({ error: 'Restaurant address is required' });
    }
    if (!fssai || !String(fssai).trim()) {
      return res.status(400).json({ error: 'FSSAI license number is required' });
    }
    if (!aadhar || !/^\d{12}$/.test(String(aadhar).replace(/\D/g, ''))) {
      return res.status(400).json({ error: 'A valid 12-digit owner Aadhar number is required' });
    }
    if (!photo_url) {
      return res.status(400).json({ error: 'A restaurant photo is required to apply' });
    }
    const { rows } = await db.query(
      `INSERT INTO restaurant_applications
         (restaurant_name, owner_name, phone, address, lat, lng, fssai, aadhar, photo_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, status`,
      [restaurant_name, owner_name, digits, address || null, lat || null, lng || null,
       fssai || null, secure.encryptField(String(aadhar).replace(/\D/g, '')), photo_url]
    );
    res.status(201).json({ application: rows[0] });
  })
);

// GET /api/track/:token — shareable live tracking link (no login needed).
// Exposes only the minimum needed to follow the order.
router.get(
  '/track/:token',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT o.id, o.status, o.placed_at, o.packed_at, o.eta_at, o.timeline,
              r.name AS restaurant_name,
              ru.name AS rider_name, rd.profile_photo AS rider_photo
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN riders rd ON rd.id = o.rider_id
       LEFT JOIN users ru ON ru.id = rd.user_id
       WHERE o.share_token = $1`,
      [req.params.token]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    delete order.share_token;
    res.json({ order });
  })
);

// GET /api/config — public app config.
// maps_key / razorpay_key are public-by-design browser keys (domain-restricted
// in their dashboards). Empty string = not configured yet; the apps hide the
// Maps and online-payment UI until the owner adds the keys.
router.get(
  '/config',
  ah(async (req, res) => {
    const { rows } = await db.query(
      "SELECT key, value FROM pricing_config WHERE key IN ('call_to_order_phone', 'customer_fee', 'budget_threshold_paise', 'referral_reward_paise', 'tip_min_paise', 'tip_max_paise', 'prep_lead_minutes', 'tax_rates', 'otw_flat_fee_paise')"
    );
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    // Customer delivery fee tiers (user 2026-10-15): backend-configurable, nothing hardcoded in apps
    const customerFee = m.customer_fee || {
      base_paise: 2000,
      base_km: 2,
      per_km_paise: 800,
      tiers: [
        { min_order_paise: 50100, free_km: 3 },
        { min_order_paise: 90100, free_km: 5 },
        { min_order_paise: 130100, free_km: 8 }
      ]
    };
    // Budget section threshold (user 2026-10-19): backend-driven, nothing hardcoded in apps
    const budgetThreshold = m.budget_threshold_paise ? parseInt(m.budget_threshold_paise, 10) : 15000;
    // Referral reward (user 2026-10-20): backend-driven, nothing hardcoded in apps
    const referralReward = m.referral_reward_paise ? parseInt(m.referral_reward_paise, 10) : 5000;
    // Tip limits (user 2026-10-20): backend-driven, nothing hardcoded in apps
    const tipMin = m.tip_min_paise ? parseInt(m.tip_min_paise, 10) : 1000;
    const tipMax = m.tip_max_paise ? parseInt(m.tip_max_paise, 10) : 50000;
    // Prep lead time (user 2026-10-20): backend-driven, nothing hardcoded in apps
    const prepLead = m.prep_lead_minutes ? parseInt(m.prep_lead_minutes, 10) : 30;
    // GST rates (user rule: food 5%, delivery 18%, platform 18%) + on-the-way
    // flat fee — backend-driven, admin-editable, single source of truth.
    const taxRates = normalizeTaxRates(m.tax_rates);
    const otwFlatFeePaise = m.otw_flat_fee_paise != null ? Number(m.otw_flat_fee_paise) : 500;
    res.json({
      call_to_order_phone: (m.call_to_order_phone) || '',
      maps_key: process.env.GOOGLE_MAPS_KEY || '',
      razorpay_key: process.env.RAZORPAY_KEY_ID || '',
      customer_fee: customerFee,
      budget_threshold_paise: budgetThreshold,
      referral_reward_paise: referralReward,
      tip_min_paise: tipMin,
      tip_max_paise: tipMax,
      prep_lead_minutes: prepLead,
      tax_rates: taxRates,
      otw_flat_fee_paise: otwFlatFeePaise
    });
  })
);

// GET /api/banner-promotions — active banner promotions only. A promotion
// is active while now is between starts_at and ends_at (ends_at null =
// no expiry). Expired promotions stop appearing on their own — no code,
// no manual removal. The customer app renders these as hero banner slides.
router.get(
  '/banner-promotions',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT bp.id, bp.restaurant_id, r.name AS restaurant_name, bp.title, bp.image_url,
              bp.starts_at, bp.ends_at
       FROM banner_promotions bp JOIN restaurants r ON r.id = bp.restaurant_id
       WHERE bp.starts_at <= now() AND (bp.ends_at IS NULL OR bp.ends_at > now())
         AND r.status = 'approved'
       ORDER BY bp.starts_at DESC, bp.created_at DESC`
    );
    res.json({ promotions: rows });
  })
);

// POST /api/search-events — log one submitted search for trending.
// Public (searches happen signed-out too); logging failures must never
// break search. Body: { query: string (required, non-empty),
// dish_ids: string[] (optional, max 50, UUIDs only — others dropped) }.
router.post(
  '/search-events',
  optionalAuth,
  ah(async (req, res) => {
    const body = req.body || {};
    const query = typeof body.query === 'string' ? body.query.trim().slice(0, 200) : '';
    if (!query) {
      return res.status(400).json({ error: 'query is required' });
    }
    if (body.dish_ids !== undefined && !Array.isArray(body.dish_ids)) {
      return res.status(400).json({ error: 'dish_ids must be an array' });
    }
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ids = [...new Set(
      (Array.isArray(body.dish_ids) ? body.dish_ids : [])
        .filter((d) => typeof d === 'string' && uuidRe.test(d))
    )].slice(0, 50);
    await db.query(
      'INSERT INTO search_events (query, dish_ids, user_id) VALUES ($1, $2::jsonb, $3)',
      [query, JSON.stringify(ids), (req.user && req.user.id) || null]
    );
    res.status(201).json({ ok: true });
  })
);

module.exports = router;
