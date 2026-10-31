// Push device tokens. Any logged-in role registers its own device token;
// sending happens server-side via FCM (separate sender module).
const express = require('express');
const db = require('../db');
const { authenticate, ah } = require('../middleware/auth');

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
  res.json({ ok: true });
}));

router.delete('/token', ah(async (req, res) => {
  const token = String((req.body && req.body.token) || '').trim();
  if (!token) return res.status(400).json({ error: 'Invalid token' });
  await db.query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [token, req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
