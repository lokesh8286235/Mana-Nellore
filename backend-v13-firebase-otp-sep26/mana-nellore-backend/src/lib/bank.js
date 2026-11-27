// Restaurant-owner bank details (2026-11-27, user-directed).
//
// REVERSAL: the Nov 27 "never store bank details" rule is reversed FOR
// RESTAURANT OWNERS ONLY — settlements need the account on file. Riders are
// unchanged (their legacy bank columns stay encrypted, never extended).
//
// Storage rules (mirror the rider bank handling in routes/rider.js):
// - bank_account / ifsc / upi_id are encrypted with AES-256-GCM via
//   src/lib/secure.js (dual-read: plain until DATA_ENC_KEY lands).
// - bank_account is digits-only (spaces stripped); ifsc is uppercased with
//   spaces stripped; account_holder_name is stored PLAIN (names are never
//   encrypted in this codebase); cancelled_cheque_photo is stored PLAIN
//   (a Cloudinary URL, validated like the rider checkPhoto).
// - bank_account_last4 is set at write time from the digits.
// - The full account number is NEVER returned to the owner app — the owner
//   shape masks it to last-4 only. Admins see the decrypted value.
const secure = require('./secure');

const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

function cleanBankAccount(v) {
  if (v == null || v === '') return null;
  return String(v).replace(/\D/g, '');
}

function cleanIfsc(v) {
  if (v == null || v === '') return null;
  return String(v).replace(/\s/g, '').toUpperCase();
}

// Validate the bank fields present in a request body. Returns an error
// string, or null when everything present is valid. Absent fields are fine
// (bank details are optional everywhere except where the caller requires them).
function validateBankFields(b) {
  const acct = cleanBankAccount(b.bank_account);
  if (b.bank_account != null && b.bank_account !== '' && !/^\d{9,18}$/.test(acct || '')) {
    return 'Bank account number must be 9-18 digits';
  }
  const ifsc = cleanIfsc(b.ifsc);
  if (b.ifsc != null && b.ifsc !== '' && !IFSC_RE.test(ifsc || '')) {
    return 'Enter a valid IFSC (e.g. SBIN0123456)';
  }
  if (b.upi_id != null && b.upi_id !== '' && !String(b.upi_id).includes('@')) {
    return 'Enter a valid UPI ID (e.g. name@okhdfcbank)';
  }
  return null;
}

// Photo validation — same rule as the rider registration checkPhoto:
// a data:image/* URL or an https URL, under ~1.5MB. Throws a 400 error.
function checkChequePhoto(p) {
  if (p == null || p === '') return null;
  const s = String(p);
  const okPrefix = s.startsWith('data:image/') || s.startsWith('http');
  if (!okPrefix || s.length > 1500000) {
    const err = new Error('Cancelled cheque photo must be an image under ~1.5MB.');
    err.status = 400;
    throw err;
  }
  return s;
}

// Encrypted write values for an INSERT/UPDATE. Null = field absent (callers
// use COALESCE so absent fields leave the stored value alone).
function bankWriteValues(b) {
  const acct = cleanBankAccount(b.bank_account);
  const ifsc = cleanIfsc(b.ifsc);
  const upi = (b.upi_id == null || b.upi_id === '') ? null : String(b.upi_id).trim().slice(0, 60);
  return {
    account_holder_name: (b.account_holder_name == null || b.account_holder_name === '')
      ? null : String(b.account_holder_name).trim().slice(0, 100),
    bank_account: acct ? secure.encryptField(acct) : null,
    bank_account_last4: acct ? acct.slice(-4) : null,
    ifsc: ifsc ? secure.encryptField(ifsc) : null,
    upi_id: upi ? secure.encryptField(upi) : null,
    cancelled_cheque_photo: (b.cancelled_cheque_photo == null || b.cancelled_cheque_photo === '')
      ? null : checkChequePhoto(b.cancelled_cheque_photo),
  };
}

const OWNER_BANK_SECRET_FIELDS = ['bank_account', 'ifsc', 'upi_id'];

// Owner-facing shape: decrypt the bank fields, then MASK the account number
// to last-4 only ("••••1234"). Never returns the full decrypted number.
// bank_account_last4 stays as stored (plain). aadhar is left exactly as
// stored — the owner view never decrypts it.
function shapeOwnerRestaurant(row) {
  if (!row) return row;
  const out = secure.decryptRow(row, OWNER_BANK_SECRET_FIELDS);
  const last4 = out.bank_account_last4
    || (out.bank_account ? String(out.bank_account).replace(/\D/g, '').slice(-4) : null);
  out.bank_account = last4 ? '••••' + last4 : (out.bank_account ? secure.MASKED : null);
  return out;
}

module.exports = {
  IFSC_RE,
  cleanBankAccount,
  cleanIfsc,
  validateBankFields,
  checkChequePhoto,
  bankWriteValues,
  shapeOwnerRestaurant,
  OWNER_BANK_SECRET_FIELDS,
};
