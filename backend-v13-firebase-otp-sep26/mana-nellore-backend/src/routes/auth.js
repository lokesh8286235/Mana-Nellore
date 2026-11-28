// Authentication: OTP login for customers/owners/riders, password login for admin.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { signToken, authenticate, ah } = require('../middleware/auth');
const router = express.Router();

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  const ten =
    digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^\d{10}$/.test(ten) ? ten : null;
}

// Shared find-or-create used by OTP verification.
async function makeReferralCode() {
  const crypto = require('crypto');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = 'MN';
    for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
    const chk = await db.query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
    if (!chk.rows[0]) return code;
  }
  return 'MN' + Date.now().toString(36).toUpperCase();
}

// One phone number gets a SEPARATE user profile per role (portal).
// Logging into a different portal creates (or reuses) that portal's profile
// and never changes an existing profile's role.
async function findOrCreateUserByPhone(phone, role, name) {
  let userRes = await db.query(
    'SELECT * FROM users WHERE phone = $1 AND role = $2',
    [phone, role]
  );
  let user = userRes.rows[0];
  let isNew = false;
  if (!user) {
    isNew = true;
    const created = await db.query(
      'INSERT INTO users (phone, name, role, referral_code) VALUES ($1, $2, $3, $4) RETURNING *',
      [phone, name || null, role, await makeReferralCode()]
    );
    user = created.rows[0];
    if (role === 'rider') {
      await db.query('INSERT INTO riders (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
    }
  }
  user._isNew = isNew;
  return user;
}

// Same shape as findOrCreateUserByPhone, for Google sign-in: one email gets a
// SEPARATE user profile per role. Google users have no phone (phone stays
// NULL); the email is stored lowercase. Phone users keep email NULL.
async function findOrCreateUserByEmail(email, role, name) {
  const clean = String(email || '').trim().toLowerCase();
  let userRes = await db.query(
    'SELECT * FROM users WHERE email = $1 AND role = $2',
    [clean, role]
  );
  let user = userRes.rows[0];
  let isNew = false;
  if (!user) {
    isNew = true;
    const created = await db.query(
      'INSERT INTO users (phone, email, name, role, referral_code) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [null, clean, name || null, role, await makeReferralCode()]
    );
    user = created.rows[0];
    if (role === 'rider') {
      await db.query('INSERT INTO riders (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
    }
  }
  user._isNew = isNew;
  return user;
}

// POST /api/auth/send-otp { phone }
// THE OTP API. With DEV_OTP=true the code is returned in the response for testing.
// Otherwise a real SMS provider must send the code — WIRE IT HERE (see OTP_SPEC.md):
// call the provider with `+91${phone}` and the 6-digit `code` right after the
// otp_codes INSERT below. If the provider call fails, delete the row / return 500
// so the user is never stuck with a code they did not receive.
router.post(
  '/send-otp',
  ah(async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });

    const code = String(require('crypto').randomInt(100000, 1000000));
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

    const user = await findOrCreateUserByPhone(phone, role, name);
    const token = signToken(user);
    // For riders: tell the app if this is a brand-new registration so it can
    // show the "Register Now" full onboarding flow (2026-10-15).
    let isNewRider = false;
    if (role === 'rider' && user._isNew) {
      isNewRider = true;
    } else if (role === 'rider') {
      const { rows: rrows } = await db.query(
        'SELECT registration_completed FROM riders WHERE user_id = $1', [user.id]);
      isNewRider = rrows.length > 0 && !rrows[0].registration_completed;
    }
    res.json({
      token,
      user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
      is_new_rider: isNewRider
    });
  })
);

// ---------- Firebase Auth (Phone + Google sign-in, floop-d2ffa) ----------
// Restored 2026-10-29 (was removed 2026-09-27, see OTP_SPEC.md). Rider +
// customer login ONLY (user scope 2026-10-28); restaurant/admin do not use it.
// Flow: app signs in with Firebase Phone Auth (SMS) or Google sign-in ->
// POSTs the Firebase ID token here -> backend verifies it against Google's
// certs and issues the app JWT. No firebase-admin dependency: RS256 is
// verified manually, same as the original implementation. Project comes from
// FIREBASE_PROJECT_ID (default floop-d2ffa); the Firebase web config itself
// lives in the apps, not here.
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'floop-d2ffa';

function b64urlDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function fetchGoogleCerts() {
  return new Promise((resolve, reject) => {
    require('https').get('https://www.googleapis.com/oauth2/v3/certs', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('Bad cert response')); }
      });
    }).on('error', reject);
  });
}

// Returns the decoded claims, or throws. Checks signature, audience, issuer,
// expiry, and that the token carries a phone number (Phone Auth) or an email
// (Google sign-in). At least one of the two must be present.
async function verifyFirebaseIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerB64, payloadB64, signatureB64] = parts;
  const header = JSON.parse(b64urlDecode(headerB64).toString('utf8'));
  const claims = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  const certs = await fetchGoogleCerts();
  const cert = certs[header.kid];
  if (!cert) throw new Error('Unknown signing key');
  const ok = require('crypto').createVerify('RSA-SHA256')
    .update(headerB64 + '.' + payloadB64)
    .verify(cert, b64urlDecode(signatureB64));
  if (!ok) throw new Error('Bad signature');
  if (claims.aud !== FIREBASE_PROJECT_ID) throw new Error('Wrong project');
  if (claims.iss !== 'https://securetoken.google.com/' + FIREBASE_PROJECT_ID) throw new Error('Wrong issuer');
  if (!claims.exp || claims.exp * 1000 <= Date.now()) throw new Error('Token expired');
  if (!claims.phone_number && !claims.email) throw new Error('No phone number or email in token');
  return claims;
}

// POST /api/auth/firebase { idToken, name?, role? }
// role: customer | rider only. Creates the user on first login, same as verify-otp.
// Phone Auth tokens carry phone_number; Google sign-in tokens carry email.
// Either is accepted (verifyFirebaseIdToken enforces at least one).
router.post(
  '/firebase',
  ah(async (req, res) => {
    const { idToken, name } = req.body;
    let role = req.body.role || 'customer';
    if (!['customer', 'rider'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    let claims;
    try {
      claims = await verifyFirebaseIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid Firebase token' });
    }
    // Phone path: EXACT existing flow (unchanged).
    // Google path: find/create by email; phone stays NULL for Google users.
    let user;
    if (claims.phone_number) {
      const phone = normalizePhone(claims.phone_number);
      if (!phone) return res.status(400).json({ error: 'Invalid phone number in token' });
      user = await findOrCreateUserByPhone(phone, role, name);
    } else {
      const email = String(claims.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email in token' });
      user = await findOrCreateUserByEmail(email, role, name || claims.name || null);
    }
    const token = signToken(user);
    let isNewRider = false;
    if (role === 'rider' && user._isNew) {
      isNewRider = true;
    } else if (role === 'rider') {
      const { rows: rrows } = await db.query(
        'SELECT registration_completed FROM riders WHERE user_id = $1', [user.id]);
      isNewRider = rrows.length > 0 && !rrows[0].registration_completed;
    }
    res.json({
      token,
      user: { id: user.id, phone: user.phone || null, name: user.name, role: user.role },
      is_new_rider: isNewRider
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
