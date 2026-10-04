// Public immutable image serving: GET /img/<sha256>[?w=<px>].
// Content-addressed, cached forever by browsers/CDN. Mounted OUTSIDE /api/ on
// purpose — these are static assets, not API calls, so they skip the API rate
// limiter (a menu page can fire 30 image requests in one burst).
//
// ?w= (added 2026-10-01, for 1GB-RAM phones): server-side downscale so budget
// phones download AND decode smaller bitmaps. A 1024px photo decoded into a
// bitmap costs ~4MB of tab memory; w=400 costs ~0.6MB. sharp is required
// lazily — if the native module is ever missing, the route falls back to the
// original bytes instead of breaking images. Resized variants are immutable
// (content-addressed), so a tiny in-memory LRU is safe and saves CPU.
const express = require('express');
const { ah } = require('../middleware/auth');
const db = require('../db');

const router = express.Router();
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_W = 1600;

let _sharp = null, _sharpTried = false;
function getSharp() {
  if (!_sharpTried) {
    _sharpTried = true;
    try { _sharp = require('sharp'); } catch (e) { _sharp = null; }
  }
  return _sharp;
}

/* tiny LRU for resized variants: hash + width -> { buf, mime } */
const RCAP = 60;
const rcache = new Map();
function rget(k) {
  const v = rcache.get(k);
  if (v) { rcache.delete(k); rcache.set(k, v); }
  return v;
}
function rset(k, v) {
  rcache.set(k, v);
  if (rcache.size > RCAP) rcache.delete(rcache.keys().next().value);
}

function sendImg(res, buf, mime) {
  res.set('Content-Type', mime);
  res.set('Content-Length', String(buf.length));
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  // Images are embedded on other origins (admin panel, customer app), so
  // override helmet's default CORP: same-origin — otherwise browsers refuse
  // to load them cross-origin and photos show broken.
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  res.send(buf);
}

router.get(
  '/:hash',
  ah(async (req, res) => {
    const hash = String(req.params.hash || '');
    if (!HASH_RE.test(hash)) return res.status(404).end();
    const w = Math.min(MAX_W, Math.max(0, parseInt(req.query.w, 10) || 0));
    const key = w ? hash + ':w' + w : null;
    if (key) {
      const hit = rget(key);
      if (hit) return sendImg(res, hit.buf, hit.mime);
    }
    const { rows } = await db.query('SELECT data, mime FROM images WHERE hash = $1', [hash]);
    if (!rows[0]) return res.status(404).end();
    let buf = rows[0].data, mime = rows[0].mime;
    const sharp = w ? getSharp() : null;
    if (sharp) {
      try {
        buf = await sharp(rows[0].data)
          .resize({ width: w, withoutEnlargement: true })
          .jpeg({ quality: 72 })
          .toBuffer();
        mime = 'image/jpeg';
        rset(key, { buf: buf, mime: mime });
      } catch (e) { /* fall back to the original bytes below */ }
    }
    sendImg(res, buf, mime);
  })
);

module.exports = router;
