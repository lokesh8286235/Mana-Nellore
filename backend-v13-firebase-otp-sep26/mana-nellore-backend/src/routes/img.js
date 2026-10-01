// Public immutable image serving: GET /img/<sha256>.
// Content-addressed, cached forever by browsers/CDN. Mounted OUTSIDE /api/ on
// purpose — these are static assets, not API calls, so they skip the API rate
// limiter (a menu page can fire 30 image requests in one burst).
const express = require('express');
const { ah } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();
const HASH_RE = /^[0-9a-f]{64}$/;

router.get(
  '/:hash',
  ah(async (req, res) => {
    const hash = String(req.params.hash || '');
    if (!HASH_RE.test(hash)) return res.status(404).end();
    const { rows } = await db.query('SELECT data, mime FROM images WHERE hash = $1', [hash]);
    if (!rows[0]) return res.status(404).end();
    res.set('Content-Type', rows[0].mime);
    res.set('Content-Length', String(rows[0].data.length));
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(rows[0].data);
  })
);

module.exports = router;
