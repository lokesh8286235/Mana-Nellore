// Authentication: OTP login for customers/owners/riders, password login for admin,
// fingerprint (WebAuthn) login for riders.
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { signToken, authenticate, ah } = require('../middleware/auth');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const router = express.Router();

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  const ten =
    digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
  return /^\d{10}$/.test(ten) ? ten : null;
}

// Shared find-or-create used by OTP verification.
async function makeReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 5; attempt++) {
    let code = 'MN';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    const chk = await db.query('SELECT 1 FROM users WHERE referral_code = $1', [code]);
    if (!chk.rows[0]) return code;
  }
  return 'MN' + Date.now().toString(36).toUpperCase();
}

// One phone number gets a SEPARATE user profile per role (portal).
// Logging into a different portal creates (or reuses) that portal's profile
// and never changes an existing profile's role.
// INSERT-first with ON CONFLICT: two concurrent first-logins for the same
// phone+role collapse onto one row instead of 500ing on UNIQUE(phone, role).
async function findOrCreateUserByPhone(phone, role, name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.query(
        `INSERT INTO users (phone, name, role, referral_code) VALUES ($1, $2, $3, $4)
         ON CONFLICT (phone, role) DO NOTHING`,
        [phone, name || null, role, await makeReferralCode()]
      );
      break;
    } catch (e) {
      // Astronomically rare referral_code collision: retry with a fresh code.
      if (e.code !== '23505' || attempt === 2) throw e;
    }
  }
  const { rows } = await db.query(
    'SELECT * FROM users WHERE phone = $1 AND role = $2',
    [phone, role]
  );
  const user = rows[0];
  if (role === 'rider') {
    await db.query('INSERT INTO riders (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
  }
  return user;
}

// POST /api/auth/send-otp { phone }
// THE OTP API. With DEV_OTP=true the code is returned in the response for testing.
// Otherwise a real SMS provider must send the code — WIRE IT HERE (see OTP_SPEC.md):
// call the provider with `+91${phone}` and the 6-digit `code` right after the
// otp_codes INSERT below. If the provider call fails, delete the row / return 500
// so the user is never stuck with a code they did not receive.
//
// SECURITY: the dev code is returned ONLY for whitelisted test phones
// (DEV_OTP_PHONES, comma-separated, 10-digit). Returning it for any phone
// lets anyone mint a session for anyone else's number — full account
// takeover. Default (unset/empty): no phone gets a code back.
function devOtpAllowed(phone) {
  if (process.env.DEV_OTP !== 'true') return false;
  const list = String(process.env.DEV_OTP_PHONES || '')
    .split(',')
    .map((s) => s.replace(/\D/g, '').slice(-10))
    .filter(Boolean);
  return list.includes(phone);
}
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

    if (devOtpAllowed(phone)) {
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
    // Atomically consume the code: a concurrent replay of the same OTP loses
    // the race here and gets a 401 instead of minting a second session (and
    // the find-or-create below 500ing on the UNIQUE(phone, role) key).
    const consumed = await db.query(
      'UPDATE otp_codes SET used = true WHERE id = $1 AND used = false RETURNING id',
      [otp.id]
    );
    if (!consumed.rows[0]) {
      return res.status(401).json({ error: 'Invalid or expired OTP' });
    }

    const user = await findOrCreateUserByPhone(phone, role, name);
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

// ---------- Fingerprint (WebAuthn) login for riders ----------
// rpID is derived from the request origin so it stays correct on any domain.
function webAuthnRp(req) {
  let hostname = '';
  try {
    hostname = new URL(req.get('origin') || '').hostname;
  } catch (_) { /* ignore */ }
  if (!hostname) hostname = String(req.get('host') || '').split(':')[0];
  const rpID = process.env.WEBAUTHN_RPID || hostname || 'localhost';
  const origin = req.get('origin') || `https://${rpID}`;
  return { rpID, rpName: 'Mana Nellore Rider', origin };
}

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function bufToB64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function storeChallenge(challenge, userId, kind) {
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await db.query(
    `INSERT INTO webauthn_challenges (challenge, user_id, kind, expires_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (challenge) DO UPDATE SET expires_at = EXCLUDED.expires_at, user_id = EXCLUDED.user_id`,
    [challenge, userId, kind, expires]
  );
}

// POST /api/auth/fingerprint/enroll-start  (auth: rider enables fingerprint on this device)
router.post(
  '/fingerprint/enroll-start',
  authenticate,
  ah(async (req, res) => {
    const rp = webAuthnRp(req);
    const { rows: existing } = await db.query(
      'SELECT credential_id FROM webauthn_credentials WHERE user_id = $1',
      [req.user.id]
    );
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userID: Buffer.from(req.user.id, 'utf8'),
      userName: req.user.phone || req.user.id,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: ['internal'] })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
        authenticatorAttachment: 'platform',
      },
    });
    await storeChallenge(options.challenge, req.user.id, 'enroll');
    res.json(options);
  })
);

// POST /api/auth/fingerprint/enroll-finish { attestation }  (auth)
// The pending challenge is looked up by user (single-use: deleted on read).
router.post(
  '/fingerprint/enroll-finish',
  authenticate,
  ah(async (req, res) => {
    const rp = webAuthnRp(req);
    const attestation = req.body && req.body.attestation;
    if (!attestation) return res.status(400).json({ error: 'Missing attestation' });
    const { rows } = await db.query(
      `DELETE FROM webauthn_challenges
       WHERE user_id = $1 AND kind = 'enroll' AND expires_at > now()
       RETURNING challenge`,
      [req.user.id]
    );
    if (!rows.length) return res.status(400).json({ error: 'Enrollment session expired. Try again.' });
    // If several were pending, the newest options belong to the newest challenge.
    const expectedChallenge = rows[rows.length - 1].challenge;
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: attestation,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
      });
    } catch (e) {
      return res.status(400).json({ error: 'Fingerprint verification failed. Try again.' });
    }
    const { verified, registrationInfo } = verification;
    if (!verified || !registrationInfo) {
      return res.status(400).json({ error: 'Fingerprint verification failed. Try again.' });
    }
    await db.query(
      `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (credential_id) DO UPDATE
       SET public_key = EXCLUDED.public_key, counter = EXCLUDED.counter, user_id = EXCLUDED.user_id`,
      [
        req.user.id,
        registrationInfo.credentialID,
        bufToB64url(registrationInfo.credentialPublicKey),
        registrationInfo.counter || 0,
      ]
    );
    res.json({ ok: true });
  })
);

// POST /api/auth/fingerprint/enrolled { phone } -> { enrolled: true/false }
// Lets the login screen decide whether to offer fingerprint login.
router.post(
  '/fingerprint/enrolled',
  ah(async (req, res) => {
    const phone = normalizePhone(req.body.phone);
    const role = (req.body && req.body.role) || 'customer';
    if (!phone) return res.json({ enrolled: false });
    const { rows } = await db.query(
      `SELECT 1 FROM webauthn_credentials wc JOIN users u ON u.id = wc.user_id
       WHERE u.phone = $1 AND u.role = $2 LIMIT 1`,
      [phone, role]
    );
    res.json({ enrolled: rows.length > 0 });
  })
);

// POST /api/auth/fingerprint/login-start { phone }
router.post(
  '/fingerprint/login-start',
  ah(async (req, res) => {
    const rp = webAuthnRp(req);
    const phone = normalizePhone(req.body.phone);
    const role = (req.body && req.body.role) || 'customer';
    if (!phone) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number' });
    const { rows: users } = await db.query('SELECT id FROM users WHERE phone = $1 AND role = $2', [phone, role]);
    const user = users[0];
    if (!user) return res.status(404).json({ error: 'No account found for this number' });
    const { rows: creds } = await db.query(
      'SELECT credential_id FROM webauthn_credentials WHERE user_id = $1',
      [user.id]
    );
    if (!creds.length) return res.status(404).json({ error: 'Fingerprint not set up on this account' });
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: ['internal'] })),
      userVerification: 'required',
    });
    await storeChallenge(options.challenge, user.id, 'login');
    res.json(options);
  })
);

// POST /api/auth/fingerprint/login-finish { phone, assertion }
// Returns the same { token, user } shape as OTP login.
router.post(
  '/fingerprint/login-finish',
  ah(async (req, res) => {
    const rp = webAuthnRp(req);
    const phone = normalizePhone(req.body && req.body.phone);
    const assertion = req.body && req.body.assertion;
    if (!phone || !assertion) return res.status(400).json({ error: 'Missing login data' });
    const role = (req.body && req.body.role) || 'customer';
    const { rows: users } = await db.query('SELECT * FROM users WHERE phone = $1 AND role = $2', [phone, role]);
    const user = users[0];
    if (!user) return res.status(404).json({ error: 'No account found for this number' });
    const { rows: chalRows } = await db.query(
      `DELETE FROM webauthn_challenges
       WHERE user_id = $1 AND kind = 'login' AND expires_at > now()
       RETURNING challenge`,
      [user.id]
    );
    if (!chalRows.length) return res.status(400).json({ error: 'Login session expired. Try again.' });
    const expectedChallenge = chalRows[chalRows.length - 1].challenge;
    const credId = assertion.id;
    const { rows: credRows } = await db.query(
      'SELECT * FROM webauthn_credentials WHERE credential_id = $1 AND user_id = $2',
      [credId, user.id]
    );
    const cred = credRows[0];
    if (!cred) return res.status(400).json({ error: 'Unknown fingerprint credential' });
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: assertion,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        authenticator: {
          credentialID: cred.credential_id,
          credentialPublicKey: b64urlToBuf(cred.public_key),
          counter: Number(cred.counter) || 0,
        },
        requireUserVerification: true,
      });
    } catch (e) {
      return res.status(400).json({ error: 'Fingerprint verification failed. Try again.' });
    }
    if (!verification.verified) {
      return res.status(400).json({ error: 'Fingerprint verification failed. Try again.' });
    }
    const newCounter = verification.authenticationInfo
      ? verification.authenticationInfo.newCounter || 0
      : 0;
    await db.query('UPDATE webauthn_credentials SET counter = $1 WHERE credential_id = $2', [
      newCounter,
      cred.credential_id,
    ]);
    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, phone: user.phone, name: user.name, role: user.role },
    });
  })
);

// DELETE /api/auth/fingerprint  (auth) — remove this device's fingerprint login
router.delete(
  '/fingerprint',
  authenticate,
  ah(async (req, res) => {
    const credId = req.body && req.body.credential_id;
    if (credId) {
      await db.query('DELETE FROM webauthn_credentials WHERE credential_id = $1 AND user_id = $2', [
        credId,
        req.user.id,
      ]);
    } else {
      await db.query('DELETE FROM webauthn_credentials WHERE user_id = $1', [req.user.id]);
    }
    res.json({ ok: true });
  })
);

module.exports = router;
