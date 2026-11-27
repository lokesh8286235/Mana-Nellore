// Mana Nellore — application-level encryption for confidential fields.
//
// DESIGN (approved 2026-11-27, user: "Yes, build it like this"):
// - Aadhar numbers (restaurants.aadhar, restaurant_applications.aadhar,
//   riders.aadhaar_no) and rider licence numbers (riders.licence_no) are
//   encrypted at rest with AES-256-GCM. FSSAI/GSTIN stay plain text (public
//   business numbers).
// - PREMISE CORRECTION (2026-11-27): rider bank columns DO exist
//   (bank_account, ifsc, upi_id, cancelled_cheque_photo) and the rider
//   registration endpoint writes them, despite the brief saying none exist.
//   They are encrypted with the same mechanism. PAN (pan_no) is encrypted
//   too — same sensitivity class as Aadhar.
// - BANK RULE (approved): bank details are NEVER stored as a system of
//   record. When payouts start, the payout provider holds account numbers;
//   we keep only a beneficiary reference ID. The legacy rider bank columns
//   are encrypted, not extended; no new bank columns are added.
//   REVERSAL (2026-11-27, user-directed, RESTAURANT OWNERS ONLY): restaurant
//   owners' bank details ARE now stored (restaurants + restaurant_applications
//   bank_account/ifsc/upi_id, encrypted with this same mechanism, plus plain
//   account_holder_name / bank_account_last4 / cancelled_cheque_photo and a
//   bank_verified flag) because settlements need the account on file. The
//   rider rule above is unchanged. See src/lib/bank.js.
// - MINIMIZE: Aadhar is verified once, then only the last 4 digits + a
//   verified flag are kept; the full number and the Aadhar photo are deleted
//   at approval time. Same for the licence photo (deleted after verification).
// - KEY: DATA_ENC_KEY env var — base64 (or hex) of 32 random bytes. The key
//   lives ONLY in Railway Variables and in ~/workspace/.secrets/data_enc_key.txt
//   on the operator VM. It is NEVER stored in the database or the repo.
//   Rotate only by re-encrypting every value first — old ciphertext cannot
//   be read with a new key.
// - DUAL-READ: if the key is absent, writes stay plain and reads return plain
//   values (with a warning) so a deploy can never break before the key is
//   set. Encrypted values are tagged `enc1.` so plain and encrypted values
//   coexist safely in the same column.
const crypto = require('crypto');

const PREFIX = 'enc1.';
const MASKED = '••••••••••••';

let keyCache = null;
let keyWarned = false;
let decryptWarned = false;

function getKey() {
  if (keyCache !== null) return keyCache;
  const raw = (process.env.DATA_ENC_KEY || '').trim();
  if (!raw) {
    if (!keyWarned) {
      keyWarned = true;
      console.warn('[secure] DATA_ENC_KEY is not set — confidential fields are stored in plain text. Set it in Railway Variables.');
    }
    keyCache = false;
    return null;
  }
  let buf = null;
  try {
    if (/^[0-9a-fA-F]{64}$/.test(raw)) buf = Buffer.from(raw, 'hex');
    else buf = Buffer.from(raw, 'base64');
  } catch (e) { buf = null; }
  if (!buf || buf.length !== 32) {
    if (!keyWarned) {
      keyWarned = true;
      console.warn('[secure] DATA_ENC_KEY is invalid (must be base64 or hex of 32 bytes) — treating as absent.');
    }
    keyCache = false;
    return null;
  }
  keyCache = buf;
  return buf;
}

function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

function encryptField(v) {
  if (v == null || v === '') return v;
  const s = String(v);
  if (isEncrypted(s)) return s; // idempotent — never double-encrypt
  const key = getKey();
  if (!key) return s; // dual-read: plain until the key is set
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64url') + '.' + tag.toString('base64url') + '.' + ct.toString('base64url');
}

function decryptField(v) {
  if (v == null || v === '') return v;
  const s = String(v);
  if (!isEncrypted(s)) return s; // plain legacy value — dual-read
  const key = getKey();
  if (!key) {
    if (!decryptWarned) {
      decryptWarned = true;
      console.warn('[secure] cannot decrypt an encrypted value — DATA_ENC_KEY is not set. Returning a masked placeholder.');
    }
    return MASKED;
  }
  try {
    const parts = s.slice(PREFIX.length).split('.');
    if (parts.length !== 3) return MASKED;
    const iv = Buffer.from(parts[0], 'base64url');
    const tag = Buffer.from(parts[1], 'base64url');
    const ct = Buffer.from(parts[2], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    console.warn('[secure] failed to decrypt a value (wrong key or corrupt ciphertext) — returning masked placeholder.');
    return MASKED;
  }
}

// Last 4 digits of an Aadhar value (plain or encrypted). Returns null when the
// value cannot be determined (encrypted without a key, or not 12 digits) —
// callers must then SKIP the scrub, never null the field blindly.
function aadharLast4(v) {
  if (v == null || v === '') return null;
  const plain = decryptField(v);
  if (!plain || plain === MASKED) return null;
  const digits = String(plain).replace(/\D/g, '');
  if (!/^\d{12}$/.test(digits)) return null;
  return digits.slice(-4);
}

// Decrypt the listed fields of a DB row for a response (admin / owner views).
// Returns a shallow copy; the stored row is never mutated. Only use for values
// that are displayed, never for values that will be written back.
function decryptRow(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) {
    if (out[f] != null) out[f] = decryptField(out[f]);
  }
  return out;
}

// ---- Backup payload encryption (whole-file) ----
// Magic header so decryptBuffer can tell ciphertext from a legacy plain gzip.
const BACKUP_MAGIC = Buffer.from('ENB1');

function encryptBuffer(buf) {
  const key = getKey();
  if (!key) {
    console.warn('[secure] DATA_ENC_KEY is not set — backup payload is NOT encrypted.');
    return buf;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([BACKUP_MAGIC, iv, cipher.getAuthTag(), ct]);
}

function decryptBuffer(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 4 || !buf.subarray(0, 4).equals(BACKUP_MAGIC)) return buf; // legacy plain gzip
  const key = getKey();
  if (!key) throw new Error('Backup is encrypted but DATA_ENC_KEY is not set.');
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const ct = buf.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

module.exports = { getKey, isEncrypted, encryptField, decryptField, aadharLast4, decryptRow, encryptBuffer, decryptBuffer, MASKED };
