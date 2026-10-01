// Image storage: photo bytes live ONCE in the images table and are served as
// immutable files at /img/<sha256>. API JSON only ever carries the short URL —
// never a base64 data-URL — so list/menu payloads stay tiny even with 1000+
// restaurants (a 250KB data-URL in the restaurant list was slowing every Home
// load before this existed).
const crypto = require('crypto');

const DATA_URL_RE = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
const HTTPS_RE = /^https:\/\/[^ "'<>]+$/;
const MAX_BYTES = 1500000; // ~1.5MB, matches the admin photo endpoint cap

function parseDataUrl(value) {
  const m = DATA_URL_RE.exec(String(value || '').trim());
  if (!m) return null;
  return { mime: 'image/' + m[1], buffer: Buffer.from(m[2], 'base64') };
}

// Store a data-URL (or pass through an https URL). Returns the value to put in
// image_url / chef_photo columns: '/img/<hash>' or the original https URL.
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
  const hash = crypto.createHash('sha256').update(parsed.buffer).digest('hex');
  await db.query(
    'INSERT INTO images (hash, data, mime) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING',
    [hash, parsed.buffer, parsed.mime]
  );
  return '/img/' + hash;
}

module.exports = { storeImageUrl, parseDataUrl };
