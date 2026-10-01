// Public (unauthenticated) endpoints: dine-in QR lookup, restaurant
// applications, and shareable order tracking links.
const express = require('express');
const db = require('../db');
const { ah } = require('../middleware/auth');

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
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [restaurant_name, owner_name, digits, address || null, lat || null, lng || null,
       fssai || null, String(aadhar).replace(/\D/g, ''), photo_url]
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
      "SELECT value FROM pricing_config WHERE key = 'call_to_order_phone'"
    );
    res.json({
      call_to_order_phone: (rows[0] && rows[0].value) || '',
      maps_key: process.env.GOOGLE_MAPS_KEY || '',
      razorpay_key: process.env.RAZORPAY_KEY_ID || ''
    });
  })
);

module.exports = router;
