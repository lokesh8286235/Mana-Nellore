// Customer portal: saved addresses, notifications, support tickets.
// Addresses are strictly scoped to the logged-in customer.
const express = require('express');
const db = require('../db');
const { authenticate, ah } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ---- Current location (customer) ----
router.put(
  '/location',

  ah(async (req, res) => {
    const { lat, lng } = req.body;
    if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng are required' });
    await db.query('UPDATE users SET lat = $1, lng = $2 WHERE id = $3', [lat, lng, req.user.id]);
    res.json({ ok: true, lat, lng });
  })
);

// ---- Addresses (customer only) ----
router.get(
  '/addresses',
  
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, label',
      [req.user.id]
    );
    res.json({ addresses: rows });
  })
);

router.post(
  '/addresses',
  
  ah(async (req, res) => {
    const { label, line1, line2, city, lat, lng, is_default } = req.body;
    if (!line1) return res.status(400).json({ error: 'Address line1 is required' });
    if (is_default) {
      await db.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    }
    const { rows } = await db.query(
      `INSERT INTO addresses (user_id, label, line1, line2, city, lat, lng, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, label || null, line1, line2 || null, city || 'Nellore',
       lat || null, lng || null, !!is_default]
    );
    res.status(201).json({ address: rows[0] });
  })
);

router.put(
  '/addresses/:id',
  
  ah(async (req, res) => {
    const fields = ['label', 'line1', 'line2', 'city', 'lat', 'lng', 'is_default'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(req.body[f]);
        sets.push(`${f} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    if (req.body.is_default) {
      await db.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    }
    params.push(req.params.id, req.user.id);
    const { rows } = await db.query(
      `UPDATE addresses SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Address not found' });
    res.json({ address: rows[0] });
  })
);

router.delete(
  '/addresses/:id',
  
  ah(async (req, res) => {
    await db.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2', [
      req.params.id, req.user.id
    ]);
    res.json({ ok: true });
  })
);

// ---- Notifications (any authenticated role; always scoped to self) ----
router.get(
  '/notifications',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ notifications: rows });
  })
);

router.put(
  '/notifications/:id/read',
  ah(async (req, res) => {
    await db.query('UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2', [
      req.params.id, req.user.id
    ]);
    res.json({ ok: true });
  })
);

// DELETE /api/customer/notifications — clear all my notifications
router.delete(
  '/notifications',
  ah(async (req, res) => {
    await db.query('DELETE FROM notifications WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  })
);

// ---- Support tickets (any authenticated role; users see only their own) ----
// Photo-aware version (kept); the older no-photo duplicate was removed so
// ticket photos actually reach the server.
router.post(
  '/support/tickets',
  ah(async (req, res) => {
    const { order_id, category, subject, message, photo_url } = req.body;
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required' });
    }
    if (order_id) {
      const o = await db.query('SELECT id FROM orders WHERE id = $1 AND customer_id = $2', [order_id, req.user.id]);
      if (!o.rows[0]) return res.status(400).json({ error: 'Order not found' });
    }
    const { rows } = await db.query(
      `INSERT INTO support_tickets (user_id, order_id, category, subject, message, photo_url)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, order_id || null, category || null, subject, message, photo_url || null]
    );
    res.status(201).json({ ticket: rows[0] });
  })
);

router.get(
  '/support/tickets',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ tickets: rows });
  })
);

// ---- Profile ----
router.get(
  '/profile',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT id, phone, name, role, dob, is_student, referral_code, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    const stats = await db.query(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(total_paise) FILTER (WHERE status != 'cancelled'), 0) AS spent_paise
       FROM orders WHERE customer_id = $1`, [req.user.id]
    );
    res.json({
      profile: rows[0],
      stats: { orders: Number(stats.rows[0].orders), spent_paise: Number(stats.rows[0].spent_paise) }
    });
  })
);

router.put(
  '/profile',
  ah(async (req, res) => {
    const { name, dob } = req.body;
    const { rows } = await db.query(
      `UPDATE users SET name = COALESCE($1, name), dob = COALESCE($2, dob)
       WHERE id = $3
       RETURNING id, phone, name, role, dob, is_student, referral_code`,
      [name || null, dob || null, req.user.id]
    );
    res.json({ profile: rows[0] });
  })
);

// ---- Call me back ----
router.post(
  '/callbacks',
  ah(async (req, res) => {
    const { order_id, reason } = req.body;
    const u = await db.query('SELECT phone FROM users WHERE id = $1', [req.user.id]);
    const { rows } = await db.query(
      `INSERT INTO callback_requests (user_id, phone, order_id, reason)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, u.rows[0].phone, order_id || null, reason || null]
    );
    res.status(201).json({ callback: rows[0] });
  })
);

router.get(
  '/callbacks',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM callback_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json({ callbacks: rows });
  })
);

// ---- Notify-me-when-open alerts ----
router.post(
  '/open-alerts',
  ah(async (req, res) => {
    const { restaurant_id } = req.body;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id is required' });
    await db.query(
      `INSERT INTO restaurant_open_alerts (user_id, restaurant_id)
       VALUES ($1, $2) ON CONFLICT (user_id, restaurant_id) DO NOTHING`,
      [req.user.id, restaurant_id]
    );
    res.json({ ok: true });
  })
);

router.delete(
  '/open-alerts/:restaurantId',
  ah(async (req, res) => {
    await db.query(
      'DELETE FROM restaurant_open_alerts WHERE user_id = $1 AND restaurant_id = $2',
      [req.user.id, req.params.restaurantId]
    );
    res.json({ ok: true });
  })
);

// ---- Referrals: share code, both sides earn a coupon (no wallet credits) ----
function makeReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MN';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

router.get(
  '/referral',
  ah(async (req, res) => {
    let { rows } = await db.query('SELECT referral_code FROM users WHERE id = $1', [req.user.id]);
    let code = rows[0].referral_code;
    if (!code) {
      code = makeReferralCode();
      await db.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, req.user.id]);
    }
    const count = await db.query('SELECT COUNT(*) AS n FROM users WHERE referred_by = $1', [req.user.id]);
    res.json({ code, referrals: Number(count.rows[0].n) });
  })
);

// POST /api/customer/referral/apply { code } — new customer applies a friend's code,
// both get a Rs 50 off coupon.
router.post(
  '/referral/apply',
  ah(async (req, res) => {
    const code = String(req.body.code || '').toUpperCase().trim();
    if (!code) return res.status(400).json({ error: 'Referral code is required' });
    const me = await db.query('SELECT referred_by FROM users WHERE id = $1', [req.user.id]);
    if (me.rows[0].referred_by) return res.status(409).json({ error: 'You already used a referral code' });
    const friend = await db.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (!friend.rows[0] || friend.rows[0].id === req.user.id) {
      return res.status(400).json({ error: 'Invalid referral code' });
    }
    const mkCoupon = async (suffix) => {
      const c = 'REF' + suffix + Math.random().toString(36).slice(2, 7).toUpperCase();
      await db.query(
        `INSERT INTO coupons (code, discount_type, value, min_order_paise, max_discount_paise, active)
         VALUES ($1, 'flat', 5000, 19900, 5000, true)`, [c]
      );
      return c;
    };
    const myCoupon = await mkCoupon('ME');
    const friendCoupon = await mkCoupon('FR');
    await db.query('UPDATE users SET referred_by = $1 WHERE id = $2', [friend.rows[0].id, req.user.id]);
    await db.query('INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)',
      [friend.rows[0].id, '🎉 Your friend joined Mana Nellore!',
       `Thanks for spreading the word! Here's Rs 50 off your next order: ${friendCoupon}`]);
    res.json({ ok: true, coupon: myCoupon, message: 'Rs 50 off coupon added to your account!' });
  })
);

// ---- Student discount application ----
router.post(
  '/student-apply',
  ah(async (req, res) => {
    const { id_photo, college } = req.body;
    if (!id_photo) return res.status(400).json({ error: 'College ID photo is required' });
    const { rows } = await db.query(
      `INSERT INTO student_applications (user_id, id_photo, college)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, id_photo, college || null]
    );
    res.status(201).json({ application: rows[0] });
  })
);

module.exports = router;
module.exports = router;
