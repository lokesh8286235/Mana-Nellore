// Authentication: OTP login for customers/owners/riders, password login for admin.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { signToken, ah } = require('../middleware/auth');

const router = express.Router();

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  const ten =
    digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^\d{10}$/.test(ten) ? ten : null;
}

// POST /api/auth/send-otp { phone }
// With DEV_OTP=true the code is returned in the response for testing;
// otherwise it is only logged server-side (wire an SMS provider here).
router.post(
  '/send-otp',
  ah(async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = await bcrypt.hash(code, 8);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await db.query('UPDATE otp_codes SET used = true WHERE phone = $1 AND used = false', [phone]);
    await db.query(
      'INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1, $2, $3)',
      [phone, codeHash, expiresAt.toISOString()]
    );

    if (process.env.DEV_OTP === 'true') {
      const { rows } = await db.query('SELECT name FROM users WHERE phone = $1', [phone]);
      return res.json({ ok: true, dev_code: code, existing_name: rows[0]?.name || null });
    }
    console.log(`[OTP] ${phone}: ${code}`);
    const { rows } = await db.query('SELECT name FROM users WHERE phone = $1', [phone]);
    res.json({ ok: true, message: 'OTP sent', existing_name: rows[0]?.name || null });
  })
);

// POST /api/auth/verify-otp { phone, code, name?, role? }
// Creates the user on first login. role: customer | restaurant_owner | rider.
router.post(
  '/verify-otp',
  ah(async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    const { code, name } = req.body;
    let role = req.body.role || 'customer';
    if (!['customer', 'restaurant_owner', 'rider'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    if (!phone || !code) {
      return res.status(400).json({ error: 'Phone and code are required' });
    }

    const { rows } = await db.query(
      `SELECT * FROM otp_codes
       WHERE phone = $1 AND used = false AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    const otp = rows[0];
    if (!otp || !(await bcrypt.compare(String(code), otp.code_hash))) {
      return res.status(401).json({ error: 'Invalid or expired OTP' });
    }
    await db.query('UPDATE otp_codes SET used = true WHERE id = $1', [otp.id]);

    let userRes = await db.query('SELECT * FROM users WHERE phone = $1', [phone]);
    let user = userRes.rows[0];
    if (!user) {
      const created = await db.query(
        'INSERT INTO users (phone, name, role) VALUES ($1, $2, $3) RETURNING *',
        [phone, name || null, role]
      );
      user = created.rows[0];
      if (role === 'rider') {
        await db.query('INSERT INTO riders (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
      }
    } else if (role && user.role !== role) {
      // User is logging in as a different role — switch their active role.
      // (Same phone can act as customer, rider, or restaurant owner.)
      await db.query('UPDATE users SET role = $1 WHERE id = $2', [role, user.id]);
      user.role = role;
      if (role === 'rider') {
        await db.query('INSERT INTO riders (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
      }
    }

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, phone: user.phone, name: user.name, role: user.role }
    });
  })
);

// POST /api/auth/admin-login { phone, password }
router.post(
  '/admin-login',
  ah(async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    const { password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ error: 'Phone and password are required' });
    }
    const { rows } = await db.query(
      "SELECT * FROM users WHERE phone = $1 AND role = 'admin'",
      [phone]
    );
    const admin = rows[0];
    if (!admin || !(await bcrypt.compare(password, admin.password_hash || ''))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = signToken(admin);
    res.json({
      token,
      user: { id: admin.id, phone: admin.phone, name: admin.name, role: admin.role }
    });
  })
);

module.exports = router;
