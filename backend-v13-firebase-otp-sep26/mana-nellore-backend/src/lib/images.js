// Image storage: photo bytes live ONCE in the images table and are served as
// immutable files at /img/<sha256>. API JSON only ever carries the short URL —
// never a base64 data-URL — so list/menu payloads stay tiny even with 1000+
// restaurants (a 250KB data-URL in the restaurant list was slowing every Home
// load before this existed).
const crypto = require('crypto');

const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
const HTTPS_RE = /^https:\/\/[^ "'<>]+$/;
const MAX_BYTES = 1500000; // ~1.5MB, matches the admin photo endpoint cap

// Standard stored photo size (2026-10-04): every uploaded image is normalized
// to fit within STD_MAX x STD_MAX px as JPEG. The apps display photos at
// ~156 CSS px, so 512px is retina-crisp (~3.3x) while keeping files small.
// Aspect ratio is preserved (fit-inside, never cropped, never upscaled) —
// safe for food photos of any shape. sharp is required lazily with fallback
// to the original bytes, so uploads never break if the native module is
// missing (same pattern as src/routes/img.js).
const STD_MAX = 512;
const STD_QUALITY = 82;

let _sharp = null, _sharpTried = false;
function getSharp() {
  if (!_sharpTried) {
    _sharpTried = true;
    try { _sharp = require('sharp'); } catch (e) { _sharp = null; }
  }
  return _sharp;
}

// Normalize an uploaded image buffer to the standard size. Returns
// { buffer, mime }. Falls back to the original buffer on any sharp failure.
async function normalizeImage(buffer, mime) {
  const sharp = getSharp();
  if (!sharp) return { buffer, mime };
  try {
    const out = await sharp(buffer)
      .resize({ width: STD_MAX, height: STD_MAX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: STD_QUALITY })
      .toBuffer();
    return { buffer: out, mime: 'image/jpeg' };
  } catch (e) {
    return { buffer, mime };
  }
}

// Absolute base for served images. Apps render image_url straight into <img
// src>, so a relative /img/... path would resolve against the wrong domain.
// Overridable via env; the fallback is the live Railway backend.
const PUBLIC_BASE = (process.env.PUBLIC_BACKEND_URL ||
  'https://mana-nellore-mana-nellore.up.railway.app').replace(/\/$/, '');

function imgUrl(hash) {
  return PUBLIC_BASE + '/img/' + hash;
}

function parseDataUrl(value) {
  const m = DATA_URL_RE.exec(String(value || '').trim());
  if (!m) return null;
  return { mime: 'image/' + m[1], buffer: Buffer.from(m[2], 'base64') };
}

// Store a data-URL (or pass through an https URL). Returns the value to put in
// image_url / chef_photo columns: '/img/<hash>' or the original https URL.
// The image is automatically resized/normalized to the standard size before
// storing (see normalizeImage), so every upload — restaurant app, admin app,
// dish photos, restaurant photos — ends up consistent. The hash is computed
// on the FINAL bytes, so content-addressing stays correct.
// Throws on anything else, so write endpoints can 400 with e.message.
async function storeImageUrl(db, value) {
  if (value == null || String(value).trim() === '') return null;
  const v = String(value).trim();
  const parsed = parseDataUrl(v);
  if (!parsed) {
    if (HTTPS_RE.test(v)) return v;
    throw new Error('image must be an image data-URL or an https URL');
  }
  if (parsed.buffer.length === 0) throw new Error('Image is empty');
  if (parsed.buffer.length > MAX_BYTES) throw new Error('Image is too large (max ~1.5MB)');
  const std = await normalizeImage(parsed.buffer, parsed.mime);
  const hash = crypto.createHash('sha256').update(std.buffer).digest('hex');
  await db.query(
    'INSERT INTO images (hash, data, mime) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING',
    [hash, std.buffer, std.mime]
  );
  return imgUrl(hash);
}

module.exports = { storeImageUrl, parseDataUrl, imgUrl, normalizeImage, STD_MAX, STD_QUALITY };
