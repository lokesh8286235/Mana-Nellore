// Push device tokens. Any logged-in role registers its own device token;
// sending happens server-side via FCM (separate sender module).
const express = require('express');
const db = require('../db');
const { authenticate, ah } = require('../middleware/auth');
const { sendToUser } = require('../lib/fcm');

const router = express.Router();
router.use(authenticate);

router.post('/token', ah(async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  const platform = String((req.body && req.body.platform) || '').trim();
  if (!token || token.length > 500 || /\s/.test(token)) {
    return res.status(400).json({ error: 'Invalid token' });
  }
  if (!['android', 'ios', 'web'].includes(platform)) {
    return res.status(400).json({ error: 'Invalid platform' });
  }
  await db.query(
    `INSERT INTO push_tokens (user_id, role, token, platform, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, role = EXCLUDED.role, platform = EXCLUDED.platform, updated_at = now()`,
    [req.user.id, req.user.role, token, platform]
  );
  // Welcome push — once per customer, on their first-ever token registration
  // (first login on any device). Never on every launch: the flag is set once
  // FCM accepts the send (or the token proves dead); a transient FCM failure
  // leaves the flag unset so a later registration retries. Customers only:
  // riders/owners/admins get operational pushes, not a welcome. A token
  // refresh does NOT re-welcome: the flag is per user, not per token.
  let welcome = null;
  if (req.user.role === 'customer') {
    try {
      const w = (await db.query('SELECT welcome_push_sent_at FROM users WHERE id = $1', [req.user.id])).rows[0];
      if (w && !w.welcome_push_sent_at) {
        const r = await sendToUser(req.user.id, {
          title: 'Welcome to Floop 👋',
          body: 'Thanks for logging in! Your next favourite meal is a tap away.',
          data: { type: 'welcome' },
        });
        welcome = { sent: r.sent, failed: r.failed, tokens: r.tokens };
        // Permanent token errors (same set the sender treats as dead): the
        // token will never deliver, so retrying the welcome is pointless.
        const dead = (r.results || []).some((x) => x && x.error && /unregistered|INVALID_ARGUMENT|SENDER_ID_MISMATCH/i.test(x.error));
        if (r.sent > 0 || dead) {
          await db.query('UPDATE users SET welcome_push_sent_at = now() WHERE id = $1', [req.user.id]);
        }
      }
    } catch (e) { console.error('[push] welcome failed:', e.message); }
  }
  res.json({ ok: true, ...(welcome ? { welcome } : {}) });
}));

router.delete('/token', ah(async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  if (!token) return res.status(400).json({ error: 'Invalid token' });
  await db.query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [token, req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
