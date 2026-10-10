// Image upload — accepts base64-encoded images, saves to disk, serves via /img/.
// NOTE: Railway's filesystem is ephemeral; uploads are lost on redeploy.
// For production persistence, move to S3/cloud storage.
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ah, authenticate } = require('../middleware/auth');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const ALLOWED_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// POST /api/upload/image — { image: "data:image/jpeg;base64,...", folder: "restaurants" }
// Returns { url: "/img/<filename>" }. Requires auth (admin/owner).
router.post(
  '/image',
  authenticate,
  ah(async (req, res) => {
    const { image, folder } = req.body || {};
    if (!image || typeof image !== 'string') {
      return res.status(400).json({ error: 'Missing image data' });
    }

    const match = image.match(/^data:(image\/(jpeg|png|webp));base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Invalid image format. Use data:image/jpeg|png|webp;base64,...' });
    }

    const mime = match[1];
    const ext = ALLOWED_MIME[mime];
    const data = Buffer.from(match[3], 'base64');

    // 5MB max
    if (data.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 5MB)' });
    }
    if (data.length < 100) {
      return res.status(400).json({ error: 'Invalid image data' });
    }

    const safeFolder = String(folder || 'misc').replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || 'misc';
    const filename = `${safeFolder}-${crypto.randomBytes(16).toString('hex')}.${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);

    // Basic magic-byte check
    const header = data.slice(0, 4);
    const isJpeg = header[0] === 0xff && header[1] === 0xd8;
    const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
    const isWebp = data.slice(0, 4).toString() === 'RIFF' && data.slice(8, 12).toString() === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) {
      return res.status(400).json({ error: 'File is not a valid image' });
    }

    fs.writeFileSync(filepath, data);

    // Return absolute URL if we can determine the host, else relative
    const host = req.get('host');
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const url = host ? `${proto}://${host}/img/${filename}` : `/img/${filename}`;
    res.json({ url });
  })
);

module.exports = router;
