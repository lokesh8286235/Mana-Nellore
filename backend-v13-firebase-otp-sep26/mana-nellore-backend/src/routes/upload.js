// Image upload — uploads to Cloudinary for persistent storage.
// Photos survive Railway redeploys.
const express = require('express');
const crypto = require('crypto');
const { ah, authenticate } = require('../middleware/auth');

const router = express.Router();

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;

const ALLOWED_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

// Upload a base64 data URL to Cloudinary, return the secure URL
async function uploadToCloudinary(dataUrl, folder) {
  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    throw new Error('Cloudinary not configured');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const safeFolder = String(folder || 'misc').replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || 'misc';
  // Signature: sha1 of sorted params + api_secret
  const toSign = `folder=mana-nellore/${safeFolder}&timestamp=${timestamp}${API_SECRET}`;
  const signature = crypto.createHash('sha1').update(toSign).digest('hex');

  const form = new URLSearchParams();
  form.append('file', dataUrl);
  form.append('api_key', API_KEY);
  form.append('timestamp', String(timestamp));
  form.append('folder', `mana-nellore/${safeFolder}`);
  form.append('signature', signature);

  const resp = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
    method: 'POST',
    body: form,
  });
  const data = await resp.json();
  if (!resp.ok || !data.secure_url) {
    throw new Error(data.error?.message || 'Cloudinary upload failed');
  }
  return data.secure_url;
}

// POST /api/upload/image — { image: "data:image/jpeg;base64,...", folder: "restaurants" }
// Returns { url: "https://res.cloudinary.com/..." }. Requires auth (admin/owner).
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

    const data = Buffer.from(match[3], 'base64');

    // 5MB max
    if (data.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image too large (max 5MB)' });
    }
    if (data.length < 100) {
      return res.status(400).json({ error: 'Invalid image data' });
    }

    // Basic magic-byte check
    const header = data.slice(0, 4);
    const isJpeg = header[0] === 0xff && header[1] === 0xd8;
    const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
    const isWebp = data.slice(0, 4).toString() === 'RIFF' && data.slice(8, 12).toString() === 'WEBP';
    if (!isJpeg && !isPng && !isWebp) {
      return res.status(400).json({ error: 'File is not a valid image' });
    }

    const url = await uploadToCloudinary(image, folder);
    res.json({ url });
  })
);

// Export for reuse in admin routes
router.uploadToCloudinary = uploadToCloudinary;

module.exports = router;
