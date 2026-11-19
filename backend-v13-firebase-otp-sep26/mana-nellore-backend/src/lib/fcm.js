// FCM push sender (HTTP v1) — no firebase-admin, no new dependencies.
//
// Auth: the service-account JSON is read from FIREBASE_SERVICE_ACCOUNT
// (set in Railway by the user). An OAuth access token is minted with a
// manually-signed RS256 JWT (same no-dependency approach as the Firebase
// ID-token verification in src/routes/auth.js) and cached until shortly
// before expiry.
//
// Behaviour without a key: every send is a silent no-op. The sender NEVER
// throws into a request path — trigger sites call pushToUser() without
// awaiting it, and the module swallows/logs all errors internally.
// On FCM UNREGISTERED the dead token is deleted from push_tokens so we
// stop trying it. No credential value is ever logged or returned.
const crypto = require('crypto');
const db = require('../db');

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'floop-d2ffa';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FETCH_TIMEOUT_MS = 10000; // never hang a request on Google

function b64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---- service-account config (parsed once, cached on SUCCESS only) ----
// { email, privateKey, keyId, projectId } | { error: string }
// A failed parse is NOT cached: if FIREBASE_SERVICE_ACCOUNT is fixed without
// a process restart, the next send re-reads it and pushes resume. A good
// parse is cached forever (the key itself never changes under a process).
let saCache = null;
let warnedFor = null;

function loadServiceAccount() {
  if (saCache && !saCache.error) return saCache;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  let parsed_sa;
  if (!raw || !String(raw).trim()) {
    parsed_sa = { error: 'FIREBASE_SERVICE_ACCOUNT is not set' };
  } else {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error('service account is missing client_email or private_key');
      }
      parsed_sa = {
        email: parsed.client_email,
        privateKey: parsed.private_key,
        keyId: parsed.private_key_id || null,
        projectId: parsed.project_id || FIREBASE_PROJECT_ID,
      };
    } catch (e) {
      parsed_sa = { error: 'FIREBASE_SERVICE_ACCOUNT is not valid JSON: ' + e.message };
    }
  }
  if (!parsed_sa.error) {
    saCache = parsed_sa;
    warnedFor = null;
    return saCache;
  }
  // Error path: warn once per distinct error, but never cache the failure.
  if (warnedFor !== parsed_sa.error) {
    warnedFor = parsed_sa.error;
    // One line per distinct error. Never log the credential itself.
    console.warn('[fcm] Sender not configured: ' + parsed_sa.error + ' — pushes will be skipped.');
  }
  return parsed_sa;
}

function isConfigured() {
  return !loadServiceAccount().error;
}

function configError() {
  const sa = loadServiceAccount();
  return sa.error || null;
}

function fcmSendUrl() {
  const sa = loadServiceAccount();
  const projectId = (sa && sa.projectId) || FIREBASE_PROJECT_ID;
  return `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
}

// ---- HTTP with a hard timeout ----
async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- OAuth access token (cached until 60s before expiry) ----
let accessToken = null; // { token, expiresAtMs }

async function getAccessToken() {
  const sa = loadServiceAccount();
  if (sa.error) return null;
  const now = Date.now();
  if (accessToken && accessToken.expiresAtMs > now + 60000) return accessToken.token;

  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({
    alg: 'RS256', typ: 'JWT', ...(sa.keyId ? { kid: sa.keyId } : {}),
  }));
  const claims = b64url(JSON.stringify({
    iss: sa.email,
    sub: sa.email,
    aud: TOKEN_URL,
    scope: FCM_SCOPE,
    iat,
    exp: iat + 3600,
  }));
  const signingInput = header + '.' + claims;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(sa.privateKey);
  const jwt = signingInput + '.' + b64url(signature);

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  }, FETCH_TIMEOUT_MS);
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error('OAuth token exchange failed (' + res.status + '): ' + text.slice(0, 200));
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Bad OAuth token response'); }
  if (!data.access_token) throw new Error('OAuth token response had no access_token');
  accessToken = { token: data.access_token, expiresAtMs: now + (Number(data.expires_in) || 3600) * 1000 };
  return accessToken.token;
}

// ---- single-token send (awaited; returns a plain result, never throws) ----
// data values must be strings for FCM; coerce defensively.
async function sendToToken(token, { title, body, data }) {
  const sa = loadServiceAccount();
  if (sa.error) return { ok: false, skipped: true, reason: sa.error };
  let access;
  try {
    access = await getAccessToken();
  } catch (e) {
    console.error('[fcm] access token failed:', e.message);
    return { ok: false, error: e.message };
  }
  if (!access) return { ok: false, skipped: true, reason: 'no access token' };

  const cleanData = {};
  for (const [k, v] of Object.entries(data || {})) cleanData[String(k)] = String(v == null ? '' : v);

  let res;
  try {
    res = await fetchWithTimeout(fcmSendUrl(), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: { token, notification: { title, body }, data: cleanData },
      }),
    }, FETCH_TIMEOUT_MS);
  } catch (e) {
    console.error('[fcm] send failed:', e.message);
    return { ok: false, error: e.message };
  }
  if (res.ok) return { ok: true };
  const errText = await res.text().catch(() => '');
  let detail = errText.slice(0, 300);
  let fcmStatus = null;
  try {
    const j = JSON.parse(errText);
    detail = JSON.stringify(j.error || j).slice(0, 300);
    fcmStatus = (j.error && j.error.status) || null;
  } catch (_) { /* keep raw text */ }
  // Permanent token errors: the token will never deliver again. Delete it
  // so we stop retrying it forever. Anything else (quota, 5xx, auth) is
  // transient or config-level and the token is kept.
  const permanent = ['UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH'];
  if (permanent.includes(fcmStatus) || /UNREGISTERED/.test(errText)) {
    try {
      await db.query('DELETE FROM push_tokens WHERE token = $1', [token]);
    } catch (e) { console.error('[fcm] dead-token cleanup failed:', e.message); }
    return { ok: false, unregistered: fcmStatus === 'UNREGISTERED' || /UNREGISTERED/.test(errText), error: detail };
  }
  console.error('[fcm] send error:', res.status, detail);
  return { ok: false, error: detail };
}

// ---- send to all of one user's tokens (awaited) ----
async function sendToUser(userId, payload) {
  const sa = loadServiceAccount();
  if (sa.error) {
    return { configured: false, reason: sa.error, tokens: 0, sent: 0, failed: 0, results: [] };
  }
  let rows;
  try {
    rows = (await db.query('SELECT token FROM push_tokens WHERE user_id = $1', [userId])).rows;
  } catch (e) {
    console.error('[fcm] token lookup failed:', e.message);
    return { configured: true, tokens: 0, sent: 0, failed: 0, error: e.message, results: [] };
  }
  let sent = 0;
  let failed = 0;
  const results = [];
  for (const r of rows) {
    const res = await sendToToken(r.token, payload);
    if (res.ok) sent++;
    else {
      failed++;
      results.push({ error: res.unregistered ? 'unregistered (token removed)' : (res.error || 'send failed') });
    }
  }
  return { configured: true, tokens: rows.length, sent, failed, results };
}

// ---- fire-and-forget entry point for trigger sites ----
// Never throws, never rejects: safe to call without await in a request path.
function pushToUser(userId, payload) {
  if (!userId) return;
  sendToUser(userId, payload).catch((e) => console.error('[fcm] push failed:', e.message));
}

module.exports = { isConfigured, configError, sendToToken, sendToUser, pushToUser };
