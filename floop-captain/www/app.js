/* Floop Captain — static frontend, talks to live backend via fetch.
   Only /api/rider/... endpoints are used: a rider can only ever see their own data. */
'use strict';

const API = 'https://mana-nellore-mana-nellore.up.railway.app';
const TOKEN_KEY = 'mana_rider_token';

/* ================= GOOGLE MAPS (ported 20261017) =================
   Maps API key: fetched once from backend /api/config at boot (never hardcoded).
   Rotating the key in Railway env vars takes effect on next app load, no redeploy. */
let MAPS_KEY = '';
let _configPromise = null;
function fetchBackendConfig() {
  if (!_configPromise) {
    _configPromise = fetch(API + '/api/config', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : {})
      .then(cfg => {
        if (cfg && cfg.maps_key) MAPS_KEY = cfg.maps_key;
        return cfg || {};
      })
      .catch(() => ({})); // backend unreachable: map features degrade, rest of app works
  }
  return _configPromise;
}
// Warm the Maps API key cache at boot so the Maps tab is fast
try { fetchBackendConfig(); } catch (e) {}

/* Build stamp — checked against version.txt by checkAppVersion() so a stale
   cached app.js self-reloads to the live build (same mechanism as the
   customer app). Bump this + version.txt + the ?v= queries in index.html
   on every rider build. */
const APP_V = '20261017r69';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  rider: null,
  online: false,
  available: [],
  active: [], // full delivery detail — written ONLY by loadActive()
  activeCount: 0, // lightweight count from the summary endpoint (badges, slot guard)
  earnings: null,
  timers: [],
  lastLocAt: null,
  pickupPhotos: {}, // deliveryId -> dataURL (temp, per session)
  deliveryPhotos: {}, // deliveryId -> dataURL (optional proof at completion)
  onboardPhotos: {}, // { aadhaar, profile } dataURLs for first-time KYC
  currentPos: null, // rider's latest GPS fix {lat, lng} — used by Maps tab
};

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/* ---------------- formatting ---------------- */
function fmtRs(paise) {
  const n = Number(paise || 0);
  return '₹' + (n / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 1GB-RAM phones: request a downscaled variant of backend /img/ photos
   (backend ?w=, src/routes/img.js). Smaller download AND a smaller decoded
   bitmap. Local files and https passthroughs pass through untouched. */
function simg(url, w) {
  url = url || '';
  if (w > 0 && url.indexOf('/img/') >= 0 && url.indexOf('?') < 0) return url + '?w=' + w;
  return url;
}
/* Mono eyebrow label (signature element of the design language). */
function eyebrow(t, center) {
  return '<div class="eyebrow' + (center ? ' center' : '') + '">' + esc(t) + '</div>';
}
/* Skeleton placeholder: shimmering block roughly matching the content being loaded. */
function skel(h) {
  return '<div class="skel" style="height:' + (h || 120) + 'px;margin-bottom:12px" aria-hidden="true"></div>';
}
function relTime(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hr ago';
  return new Date(ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function fmtDate(d) {
  try { return new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return String(d || ''); }
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function monthStartISO() { const d = new Date(); d.setDate(1); return d.toISOString().slice(0, 10); }

/* ---------------- toast ---------------- */
function toast(msg, type) {
  const root = $('#toast-root');
  const t = document.createElement('div');
  t.className = 'toast' + (type ? ' ' + type : '');
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 350); }, 3200);
}

/* ---------------- API ---------------- */
async function api(path, opts) {
  opts = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  let res;
  try {
    res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new Error('Network error. Check your internet connection.');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
  if (res.status === 401) {
    // Prefer the backend's specific message (e.g. "Invalid or expired OTP").
    const msg = (data && (data.error || data.message)) || 'Session expired. Please log in again.';
    // Only bounce to login when the backend says the TOKEN itself is bad.
    // A 401 for any other reason (e.g. a wrong delivery OTP) must not kill
    // the rider's session — the error is shown as a toast instead.
    const sessionDead = /token|session/i.test(msg);
    if (sessionDead && state.token) { logout(); }
    throw new Error(msg);
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || ('Request failed (' + res.status + ')');
    throw new Error(msg);
  }
  return data || {};
}

/* ---------------- timers ---------------- */
function clearTimers() {
  state.timers.forEach(clearInterval);
  state.timers = [];
}
function every(ms, fn) {
  const id = setInterval(fn, ms);
  state.timers.push(id);
  return id;
}

/* Photos captured for pickup/delivery proof live in memory AND in
   sessionStorage. iOS Safari often kills the background tab when the camera
   opens — without the sessionStorage copy the rider would return to a
   reloaded page with the photo gone and have to retake it. */
const PHOTO_PREFIX = { pickup: 'mn_pickup_', delphoto: 'mn_delphoto_' };
function persistPhoto(kind, id, url) {
  try { sessionStorage.setItem(PHOTO_PREFIX[kind] + id, url); } catch (e) { /* quota/privacy — memory copy still works */ }
}
function restorePhotos() {
  try {
    Object.keys(PHOTO_PREFIX).forEach(kind => {
      const pfx = PHOTO_PREFIX[kind];
      const store = kind === 'pickup' ? state.pickupPhotos : state.deliveryPhotos;
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && k.indexOf(pfx) === 0) store[k.slice(pfx.length)] = sessionStorage.getItem(k);
      }
    });
  } catch (e) { /* private mode — memory copy still works */ }
}
function clearPersistedPhoto(kind, id) {
  try { sessionStorage.removeItem(PHOTO_PREFIX[kind] + id); } catch (e) {}
}
function clearAllPersistedPhotos() {
  try {
    Object.keys(PHOTO_PREFIX).forEach(kind => {
      const pfx = PHOTO_PREFIX[kind];
      for (let i = sessionStorage.length - 1; i >= 0; i--) {
        const k = sessionStorage.key(i);
        if (k && k.indexOf(pfx) === 0) sessionStorage.removeItem(k);
      }
    });
  } catch (e) {}
}

/* ---------------- icons (inline SVG, no emojis) ---------------- */
const I = {
  bike: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M12 17.5V14l-3-3 4-3 2 3 2-3"/><path d="M9 6h4l2 5"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 7h12v9H1z"/><path d="M13 10h5l3 3v3h-8"/><circle cx="6" cy="18.5" r="1.8"/><circle cx="17" cy="18.5" r="1.8"/></svg>',
  wallet: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M2 10h20"/><circle cx="17" cy="15" r="1.4" fill="currentColor"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.13.96.36 1.9.7 2.8a2 2 0 0 1-.45 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.25a2 2 0 0 1 2.1-.45c.9.34 1.84.57 2.8.7A2 2 0 0 1 22 16.9z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>',
  out: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M20.5 15a9 9 0 1 1-1.4-8.4L23 10"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22V4c4-2 8 2 12 0v9c-4 2-8-2-12 0"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  finger: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11a2 2 0 0 1 2 2c0 2.5-.5 4.5-1.5 6.5"/><path d="M8.5 13.5c0 3-1 5-2 6.5"/><path d="M15.5 13.5c.2 2.8-.3 5-1.3 6.8"/><path d="M12 7.5A4.5 4.5 0 0 1 16.5 12c0 1.8-.1 3.2-.4 4.6"/><path d="M7.5 12A4.5 4.5 0 0 1 12 7.5"/><path d="M4.6 10.5A8 8 0 0 1 12 4a8 8 0 0 1 7.4 6.5c.3 1.8.4 3.6.2 5.4-.2 1.9-.7 3.6-1.4 5"/></svg>',
};

/* ---------------- auth / session ---------------- */
function logout() {
  stopBgTracking(); /* native background GPS must die first */
  stopLiveTracking(); /* GPS watchPosition must die first — never PUT location after logout */
  stopOfferPoll(); /* offer polling must not outlive the session */
  state.token = null;
  state.rider = null;
  state.online = false;
  state.available = [];
  state.active = [];
  state.activeCount = 0;
  state.pickupPhotos = {};
  state.deliveryPhotos = {};
  clearAllPersistedPhotos();
  clearTimers();
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
  if (location.hash !== '#/login') location.hash = '#/login';
  else route();
}

async function loadProfile() {
  const data = await api('/api/rider/profile');
  const rider = data.rider || data;
  // Backend nests the user's name/phone under rider.user — normalize for the UI.
  if (rider.user) {
    if (!rider.name) rider.name = rider.user.name;
    if (!rider.phone) rider.phone = rider.user.phone;
  }
  state.rider = rider;
  // Sync online status from the backend (e.g. app was closed while online).
  state.online = !!rider.online;
  if (state.online) { startBgTracking().then(function(ok) { if (!ok) startLiveTracking(); }); }
  if (state.online) startOfferPoll(); /* restore cross-tab offer polling after a reload while online */
  return state.rider;
}

/* ---------------- routing ---------------- */
const routes = ['#/login', '#/register', '#/approval', '#/home', '#/orders', '#/available', '#/active', '#/earnings', '#/profile'];
window.addEventListener('hashchange', route);

// Camera-kill detection: tapping a photo label is the last thing we know
// before iOS may kill the tab for the camera. If the page survives, choosing
// a photo (change) or cancelling (focus returns) clears the flag. If the tab
// died, boot() sees the flag and explains what happened.
document.addEventListener('click', e => {
  const lab = e.target && e.target.closest ? e.target.closest('label.photopick-label') : null;
  if (lab) { try { sessionStorage.setItem('mn_capture_pending', lab.getAttribute('for') || 'photo'); } catch (_) {} }
}, true);
window.addEventListener('focus', clearCapturePending);
function clearCapturePending() { try { sessionStorage.removeItem('mn_capture_pending'); } catch (_) {} }
function checkCameraKill() {
  let pending = null;
  try { pending = sessionStorage.getItem('mn_capture_pending'); } catch (_) {}
  clearCapturePending();
  if (pending) setTimeout(() => toast('The camera closed the page before the photo was saved — please take the photo once more.'), 800);
}

async function boot() {
  if (!state.token) { location.hash = '#/login'; route(); return; }
  checkCameraKill(); // the camera may have killed the tab before a photo was chosen
  restorePhotos(); // the camera may have gotten the tab killed — keep captured photos
  try {
    const rider = await loadProfile();
    if (profileIncomplete(rider)) { location.hash = '#/onboarding'; }
    else if (rider.status === 'pending') { location.hash = '#/approval'; }
    // Keep the rider on their tab across a reload (e.g. iOS Safari killing the
    // tab while the camera was open) instead of always dumping them on Home.
    else if (['#/home', '#/orders', '#/available', '#/active', '#/earnings', '#/profile'].indexOf(location.hash) < 0) {
      location.hash = '#/home';
    }
  } catch (e) {
    // Only log out if the session is truly invalid (401 on the profile check).
    if (String(e.message || '').toLowerCase().indexOf('session expired') >= 0) { logout(); return; }
    renderBootError(e);
    return;
  }
  route();
}

function renderBootError(e) {
  clearTimers();
  $('#app').innerHTML = `
  <div class="authwrap">
    <div class="logo">${I.bike}</div>
    <h1>Connection trouble</h1>
    <p class="tag">${esc((e && e.message) || 'Could not reach the server.')}</p>
    <div class="errbox">Check your internet connection and try again. Your login is saved.</div>
    <button class="btn" id="btn-retry">Retry</button>
    <div style="height:10px"></div>
    <button class="btn ghost" id="btn-logout2">Log out</button>
  </div>`;
  $('#btn-retry').onclick = boot;
  $('#btn-logout2').onclick = logout;
}

function route() {
  clearTimers();
  closeTakeover(); /* any navigation dismisses the offer alert */
  const h = location.hash || '#/login';
  if (!state.token && h !== '#/login' && h !== '#/register') { location.hash = '#/login'; return; }
  if (h === '#/login') return renderLogin();
  if (h === '#/register') return renderRegistration();
  if (h === '#/onboarding') return renderOnboarding();
  if (h === '#/approval') return renderApproval();
  // Approval gate: only approved riders may enter the app. Pending (or
  // rejected/suspended) riders stay on onboarding/approval no matter what
  // hash they type.
  if (state.rider && state.rider.status !== 'approved') {
    if (profileIncomplete(state.rider)) { location.hash = '#/onboarding'; }
    else { location.hash = '#/approval'; }
    return;
  }
  if (h === '#/home') return renderHome();
  if (h === '#/maps') return renderMaps();
  if (h === '#/orders') return renderOrders();
  if (h === '#/earnings') return renderEarnings();
  if (h === '#/available') { location.hash = '#/orders'; return; }
  if (h === '#/active') { location.hash = '#/orders'; return; }
  if (h === '#/earnings') { location.hash = '#/profile'; return; }
  if (h === '#/profile') return renderProfile();
  // Unknown route: authenticated riders go home, guests go to login
  location.hash = state.token ? '#/home' : '#/login';
}

function shell(content, activeTab) {
  const availN = state.available.length;
  const actN = activeCount();
  const ordersN = availN + actN;
  return `
  <div class="page">${content}</div>
  <button class="sos-fab" id="btn-sos" aria-label="Emergency SOS — alert the Floop team">SOS</button>
  <nav class="bottomtabs">
    <a class="tab ${activeTab === 'home' ? 'active' : ''}" href="#/home"><span class="tic">${I.home}</span><span>Home</span></a>
    <a class="tab ${activeTab === 'maps' ? 'active' : ''}" href="#/maps"><span class="tic">${I.pin || I.home}</span><span>Maps</span></a>
    <a class="tab ${activeTab === 'orders' ? 'active' : ''}" href="#/orders" data-count="orders"><span class="tic">${I.box}${ordersN ? `<span class="badge">${ordersN}</span>` : ''}</span><span>Orders</span></a>
    <a class="tab ${activeTab === 'profile' ? 'active' : ''}" href="#/profile"><span class="tic">${I.user}</span><span>Profile</span></a>
  </nav>
  <div id="takeover-root"></div>`;
}

function bindShell() {
  const s = $('#btn-sos');
  if (s) s.onclick = () => confirmSOS();
}

/* ================= SOS EMERGENCY =================
   One-tap emergency alert: confirm -> capture GPS -> POST /api/rider/sos.
   Backend writes sos_alerts and pushes an admin notification. */
function getGPS() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve({ lat: null, lng: null });
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve({ lat: null, lng: null }), /* denied/unavailable: send anyway, backend accepts null */
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

function confirmSOS() {
  const back = document.createElement('div');
  back.className = 'modalback';
  back.innerHTML = `
    <div class="modal" role="alertdialog" aria-label="Confirm emergency SOS">
      <div class="sos-confirm">
        <div class="sos-icon">🆘</div>
        <h2>Emergency?</h2>
        <p>This sends an SOS alert with your live location to the Floop team immediately. Only use this in a real emergency.</p>
        <div class="btnrow">
          <button class="btn ghost" id="sos-cancel">Cancel</button>
          <button class="btn danger" id="sos-send">Send SOS</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener('click', e => { if (e.target === back) close(); });
  back.querySelector('#sos-cancel').onclick = close;
  back.querySelector('#sos-send').onclick = async () => {
    const btn = back.querySelector('#sos-send');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      toast('Getting your location…');
      const { lat, lng } = await getGPS();
      await api('/api/rider/sos', { method: 'POST', body: { lat, lng } });
      close();
      toast('SOS sent. The Floop team has been alerted.', 'ok');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Send SOS';
      toast(e.message || 'Could not send SOS. Try again.', 'err');
    }
  };
}

/* Tab switches swap only the page content — the header/tab bar is built once
   and never destroyed, so tapping tabs feels instant instead of reloading
   the whole screen. Active tab, online pill and badges are updated in place. */
function setPage(content, activeTab) {
  const app = $('#app');
  if (!app.querySelector('.topbar')) {
    app.innerHTML = shell(content, activeTab);
    bindShell();
    updateBadges();
    return;
  }
  const page = app.querySelector('.page');
  if (page) { page.innerHTML = content; page.classList.remove('flush'); }
  const tb = app.querySelector('.topbar');
  if (tb) tb.style.display = activeTab === 'maps' ? 'none' : '';
  app.querySelectorAll('.bottomtabs .tab').forEach(t => {
    t.classList.toggle('active', (t.getAttribute('href') || '') === '#/' + activeTab);
  });
  const pill = app.querySelector('.topbar .pill');
  if (pill) {
    const on = !!state.online;
    pill.classList.toggle('on', on);
    pill.classList.toggle('off', !on);
    /* Guard: don't destroy/recreate the dot node on every tab switch — the
       pill content only changes when online state flips. */
    if (pill.dataset.on !== String(on)) {
      pill.dataset.on = String(on);
      pill.innerHTML = '<span class="dot"></span>' + (on ? 'Online' : 'Offline');
    }
  }
  updateBadges();
}

/* ================= FINGERPRINT LOGIN (WebAuthn) =================
   Additive feature: platform authenticator (fingerprint / face) as a
   second login method alongside OTP. Nothing below alters existing flows. */
const FP_PHONE_KEY = 'mn_rider_phone';
function fpSkipKey(phone) { return 'mn_fp_skip_' + phone; }
function fpSkipped(phone) {
  try { return localStorage.getItem(fpSkipKey(phone)) === '1'; } catch (e) { return false; }
}
function b64urlToBuf(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function fpAvailable() {
  try {
    if (!window.PublicKeyCredential) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(() => false);
  } catch (e) { return false; }
}
async function fpEnrolledCheck(phone) {
  try {
    const st = await api('/api/auth/fingerprint/enrolled', { method: 'POST', body: { phone, role: 'rider' } });
    return !!(st && st.enrolled);
  } catch (e) { return false; }
}

/* Fingerprint login from the login screen. Mirrors OTP success handling. */
async function fpLogin(phone) {
  const btn = $('#btn-fp');
  const orig = btn ? btn.innerHTML : '';
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Waiting for fingerprint…'; }
    const opts = await api('/api/auth/fingerprint/login-start', { method: 'POST', body: { phone, role: 'rider' } });
    opts.challenge = b64urlToBuf(opts.challenge);
    (opts.allowCredentials || []).forEach(c => { c.id = b64urlToBuf(c.id); });
    const cred = await navigator.credentials.get({ publicKey: opts });
    const assertion = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        authenticatorData: bufToB64url(cred.response.authenticatorData),
        signature: bufToB64url(cred.response.signature),
        userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
      },
    };
    const data = await api('/api/auth/fingerprint/login-finish', { method: 'POST', body: { phone, assertion, role: 'rider' } });
    state.token = data.token;
    try { localStorage.setItem(TOKEN_KEY, data.token); } catch (e) {}
    try { localStorage.setItem(FP_PHONE_KEY, phone); } catch (e) {}
    toast('Welcome back, ' + ((data.user && data.user.name) || 'rider') + '!', 'ok');
    boot();
  } catch (e) {
    const nm = String((e && e.name) || '');
    const cancelled = /NotAllowedError|AbortError/i.test(nm);
    toast(cancelled ? 'Fingerprint login cancelled. You can use OTP instead.' : ('Fingerprint login failed: ' + (e.message || 'try OTP instead.')), true);
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

/* Enrollment: called from the one-time prompt card on home. */
async function fpEnrollNow(phone, cardEl) {
  try {
    const opts = await api('/api/auth/fingerprint/enroll-start', { method: 'POST' });
    opts.challenge = b64urlToBuf(opts.challenge);
    opts.user.id = b64urlToBuf(opts.user.id);
    (opts.excludeCredentials || []).forEach(c => { c.id = b64urlToBuf(c.id); });
    const cred = await navigator.credentials.create({ publicKey: opts });
    const attestation = {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        attestationObject: bufToB64url(cred.response.attestationObject),
      },
    };
    await api('/api/auth/fingerprint/enroll-finish', { method: 'POST', body: { attestation } });
    try { localStorage.setItem(FP_PHONE_KEY, phone); } catch (e) {}
    toast('Fingerprint login enabled', 'ok');
    if (cardEl) cardEl.remove();
  } catch (e) {
    const nm = String((e && e.name) || '');
    const cancelled = /NotAllowedError|AbortError/i.test(nm);
    toast(cancelled ? 'Fingerprint setup cancelled.' : ('Could not enable fingerprint: ' + (e.message || 'try again later.')), true);
  }
}

/* One-time enrollment prompt, injected at the top of home after an OTP login. */
async function armFingerprintPrompt() {
  const phone = state._fpPromptArmed;
  state._fpPromptArmed = null; // one-shot per login
  if (!phone || fpSkipped(phone)) return;
  try {
    if (!(await fpAvailable())) return;
    if (await fpEnrolledCheck(phone)) return;
    const page = $('#app .page');
    if (!page || $('#fp-enroll-card')) return;
    const div = document.createElement('div');
    div.className = 'card fp-card';
    div.id = 'fp-enroll-card';
    div.innerHTML =
      '<h2>' + I.finger + ' Enable fingerprint login?</h2>' +
      '<p class="muted" style="margin:0 0 4px">Next time, one touch to log in — no OTP needed.</p>' +
      '<div class="btnrow" style="margin-top:12px">' +
      '<button class="btn sm" id="fp-enable">' + I.finger + ' Enable</button>' +
      '<button class="btn ghost sm" id="fp-skip">Skip</button>' +
      '</div>';
    page.insertBefore(div, page.firstChild);
    $('#fp-enable').onclick = async () => {
      const b = $('#fp-enable');
      b.disabled = true; b.textContent = 'Waiting for fingerprint…';
      await fpEnrollNow(phone, div);
      if (document.body.contains(b)) { b.disabled = false; b.innerHTML = I.finger + ' Enable'; }
    };
    $('#fp-skip').onclick = () => {
      try { localStorage.setItem(fpSkipKey(phone), '1'); } catch (e) {}
      div.remove();
    };
  } catch (e) { /* never break home */ }
}

/* Small "remove fingerprint login" affordance on home, shown only if enrolled. */
async function maybeShowFingerprintRemove() {
  try {
    const phone = (state.rider && state.rider.phone) || localStorage.getItem(FP_PHONE_KEY);
    if (!phone || $('#btn-fp-remove')) return;
    if (!(await fpAvailable())) return;
    if (!(await fpEnrolledCheck(phone))) return;
    const editBtn = $('#btn-edit');
    if (!editBtn) return;
    const b = document.createElement('button');
    b.className = 'btn ghost sm';
    b.id = 'btn-fp-remove';
    b.style.marginTop = '8px';
    b.textContent = 'Remove fingerprint login';
    editBtn.insertAdjacentElement('afterend', b);
    b.onclick = async () => {
      if (!window.confirm('Remove fingerprint login from this device?')) return;
      try {
        await api('/api/auth/fingerprint', { method: 'DELETE' });
        try { localStorage.removeItem(fpSkipKey(phone)); } catch (e) {}
        toast('Fingerprint login removed', 'ok');
        b.remove();
      } catch (e) { toast(e.message || 'Could not remove fingerprint login.', true); }
    };
  } catch (e) { /* never break home */ }
}

/* ================= LOGIN ================= */
/* Backend OTP login: the server sends the code (see OTP_SPEC.md). */

function renderLogin() {
  $('#app').innerHTML = `
  <div class="authwrap">
    ${eyebrow('Rider app', true)}
    <div class="logo">${I.bike}</div>
    <h1>Floop Captain</h1>
    <p class="tag">Deliver food. Earn money.</p>
    <div id="login-err"></div>
    <div id="step-phone">
      <div class="field"><label for="phone">Mobile number</label>
        <div class="phonewrap"><span class="cc">+91</span>
        <input class="input" id="phone" inputmode="numeric" pattern="[0-9]*" maxlength="10" placeholder="98765 43210" autocomplete="tel" oninput="this.value=this.value.replace(/\D/g,'')"></div>
      </div>
      <button class="btn" id="btn-send">Send OTP</button>
    </div>
    <div id="step-otp" style="display:none">
      <div class="field"><label for="rname">Your name</label>
        <input class="input" id="rname" placeholder="Full name" autocomplete="name"></div>
      <div class="field"><label for="otp">Enter OTP</label>
        <input class="input otp" id="otp" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="••••••" autocomplete="one-time-code" oninput="this.value=this.value.replace(/\D/g,'')">
        <div class="hint" id="dev-code-hint" style="display:none;color:var(--green);font-weight:700"></div></div>
      <button class="btn" id="btn-verify">Verify &amp; Log in</button>
      <div style="height:10px"></div>
      <button class="btn ghost sm" id="btn-back">Change number</button>
    </div>
  </div>`;
  let phone = '';

  $('#btn-send').onclick = async () => {
    phone = $('#phone').value.replace(/\D/g, '');
    // Indian mobile numbers: 10 digits, starting with 6-9
    if (!/^[6-9]\d{9}$/.test(phone)) { $('#login-err').innerHTML = '<div class="errbox" role="alert">Enter a valid 10-digit mobile number.</div>'; return; }
    const btn = $('#btn-send');
    btn.disabled = true; btn.textContent = 'Sending…';
    $('#login-err').innerHTML = '';
    try {
      const d = await api('/api/auth/send-otp', { method: 'POST', body: { phone } });
      $('#step-phone').style.display = 'none';
      $('#step-otp').style.display = 'block';
      if (d && d.dev_code) {
        const hint = $('#dev-code-hint');
        hint.textContent = 'Test code: ' + d.dev_code;
        hint.style.display = 'block';
      }
      toast('OTP sent to +91 ' + phone, 'ok');
      $('#otp').focus();
    } catch (e) {
      $('#login-err').innerHTML = '<div class="errbox">' + esc(e.message) + '</div>';
    } finally { btn.disabled = false; btn.textContent = 'Send OTP'; }
  };

  $('#btn-back').onclick = () => {
    $('#step-otp').style.display = 'none';
    $('#step-phone').style.display = 'block';
  };

  $('#btn-verify').onclick = async () => {
    const code = $('#otp').value.replace(/\D/g, '');
    const name = $('#rname').value.trim();
    if (!name) { $('#login-err').innerHTML = '<div class="errbox">Please enter your name.</div>'; return; }
    if (!code) { $('#login-err').innerHTML = '<div class="errbox">Please enter the OTP.</div>'; return; }
    const btn = $('#btn-verify');
    btn.disabled = true; btn.textContent = 'Verifying…';
    $('#login-err').innerHTML = '';
    try {
      const data = await api('/api/auth/verify-otp', { method: 'POST', body: { phone, code, name, role: 'rider' } });
      state.token = data.token;
      try { localStorage.setItem(TOKEN_KEY, data.token); } catch (e) {}
      try { localStorage.setItem(FP_PHONE_KEY, phone); } catch (e) {}
      state._fpPromptArmed = phone; // one-time fingerprint enrollment prompt (shown on home)
      // New riders go to full registration (Swiggy/Zomato-style, 2026-10-15)
      if (data.is_new_rider) {
        location.hash = '#/register';
        route();
        return;
      }
      toast('Welcome, ' + name + '!', 'ok');
      boot();
    } catch (e) {
      $('#login-err').innerHTML = '<div class="errbox">' + esc(e.message) + '</div>';
      btn.disabled = false; btn.textContent = 'Verify & Log in';
    }
  };

  // Fingerprint login: show only if this device supports it, we know the
  // last-used phone, and that phone has a fingerprint credential enrolled.
  (async () => {
    try {
      let lastPhone = null;
      try { lastPhone = localStorage.getItem(FP_PHONE_KEY); } catch (e) {}
      if (!lastPhone || !/^[6-9]\d{9}$/.test(lastPhone)) return;
      if (!(await fpAvailable())) return;
      if (!(await fpEnrolledCheck(lastPhone))) return;
      const slot = $('#step-phone');
      if (!slot || $('#btn-fp')) return;
      const b = document.createElement('button');
      b.className = 'btn fp-btn';
      b.id = 'btn-fp';
      b.type = 'button';
      b.innerHTML = I.finger + ' Login with fingerprint';
      slot.appendChild(b);
      // Prefill the phone field for convenience.
      const pf = $('#phone');
      if (pf && !pf.value) pf.value = lastPhone;
      b.onclick = () => fpLogin(lastPhone);
    } catch (e) { /* OTP remains the fallback — never break login */ }
  })();
}

/* ================= APPROVAL GATE ================= */
function renderApproval() {
  clearTimers();
  $('#app').innerHTML = `
  <div class="authwrap">
    ${eyebrow('Approval', true)}
    <div class="logo">${I.flag}</div>
    <h1>Almost there!</h1>
    <p class="tag">Your rider application is waiting for approval.<br>This page checks automatically.</p>
    <div class="spinner" role="status" aria-label="Waiting for approval"></div>
    <p class="tag" id="appr-sub">Checking approval status…</p>
    <div id="appr-actions"></div>
    <button class="btn ghost" id="btn-out2">Log out</button>
  </div>`;
  $('#btn-out2').onclick = () => logout();

  const check = async () => {
    try {
      const rider = await loadProfile();
      if (rider.status === 'approved') {
        toast('Approved! Welcome aboard.', 'ok');
        location.hash = '#/home';
      } else if (rider.status !== 'pending') {
        $('#appr-sub').textContent = 'Status: ' + rider.status + '. Please review the reason below or re-submit your documents.';
        clearTimers();
        const box = $('#appr-actions');
        if (box) {
          box.innerHTML = `<button class="btn" id="btn-reapply">${I.refresh} Re-submit documents</button>`;
          $('#btn-reapply').onclick = () => { location.hash = '#/onboarding'; };
        }
      }
    } catch (e) { /* keep polling on transient errors */ }
  };
  every(15000, check);
}

/* ================= FIRST-TIME ONBOARDING (KYC) ================= */
function profileIncomplete(r) {
  return !r || !r.vehicle_number;
}

function downscalePhoto(file, cb) {
  resizePhoto(file, 1024, 0.7, cb);
}

/* Reusable client-side photo resizer: reads an image file, downscales so the
   longest side is <= maxDim, returns a JPEG data URL via cb. Guards the
   backend's ~1.5MB image limit. */
function resizePhoto(file, maxDim, quality, cb) {
  if (!file) return;
  if (!file.type || file.type.indexOf('image/') !== 0) { toast('Please choose an image file.', 'err'); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = maxDim || 1024;
      let w = img.width, h = img.height;
      if (Math.max(w, h) > max) {
        const k = max / Math.max(w, h);
        w = Math.round(w * k); h = Math.round(h * k);
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      const url = c.toDataURL('image/jpeg', quality || 0.72);
      if (url.length > 1500000) { toast('Photo is too large. Try a smaller one.', 'err'); return; }
      cb(url);
    };
    img.onerror = () => toast('Could not read that photo.', 'err');
    img.src = reader.result;
  };
  reader.onerror = () => toast('Could not read that photo.', 'err');
  reader.readAsDataURL(file);
}

/* Build a single DOM element from an HTML string (used by diff updates). */
function htmlToEl(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function renderOnboarding() {
  clearTimers();
  const r = state.rider || {};
  const photos = state.onboardPhotos;
  const draft = {
    vtype: r.vehicle_type || 'bike',
    vno: r.vehicle_number || '',
    lic: r.licence_no || '',
    aadhaar: r.aadhaar_no || '',
  };
  let step = 1;

  function readStep1() {
    draft.vtype = ($('#ob-vtype') || {}).value || draft.vtype;
    draft.vno = (($('#ob-vno') || {}).value || '').trim();
    draft.lic = (($('#ob-lic') || {}).value || '').trim();
  }
  function readStep2() {
    draft.aadhaar = (($('#ob-aadhaar') || {}).value || '').replace(/\D/g, '');
  }

  function paint() {
    const steps = `
      <div class="stepbar" aria-hidden="true">
        <span class="step ${step >= 1 ? 'done' : ''}"></span>
        <span class="step ${step >= 2 ? 'done' : ''}"></span>
      </div>`;
    let body = '';
    if (step === 1) {
      body = `
      <h1>Your vehicle</h1>
      <p class="tag">Tell us what you'll deliver on. You can change this later from Home.</p>
      <div class="field"><label for="ob-vtype">Vehicle type</label>
        <select class="input" id="ob-vtype">
          ${['bike', 'scooter', 'bicycle', 'ev'].map(v => `<option value="${v}" ${draft.vtype === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}
        </select></div>
      <div class="field"><label for="ob-vno">Vehicle number</label>
        <input class="input" id="ob-vno" value="${esc(draft.vno)}" placeholder="e.g. AP39 AB 1234" autocomplete="off"></div>
      <div class="field"><label for="ob-lic">Driving licence number</label>
        <input class="input" id="ob-lic" value="${esc(draft.lic)}" placeholder="Licence number" autocomplete="off"></div>
      <button class="btn" id="ob-next">Continue</button>`;
    } else {
      body = `
      <h1>Identity documents</h1>
      <p class="tag">We need these once to verify you. They stay private.</p>
      <div class="field"><label for="ob-aadhaar">Aadhaar number</label>
        <input class="input" id="ob-aadhaar" value="${esc(draft.aadhaar)}" inputmode="numeric" maxlength="12" placeholder="12-digit Aadhaar number" autocomplete="off"></div>
      <div class="field"><label>Aadhaar card photo</label>
        <label class="photopick-label" for="ob-aadhaar-photo">${I.camera} ${photos.aadhaar ? 'Retake Aadhaar photo' : 'Take Aadhaar card photo'}</label>
        <input type="file" class="photopick" id="ob-aadhaar-photo" accept="image/*" capture="camera">
        ${photos.aadhaar ? `<img class="photo-preview" src="${photos.aadhaar}" alt="Aadhaar card preview">` : ''}</div>
      <div class="field"><label>Your photo</label>
        <label class="photopick-label" for="ob-profile-photo">${I.camera} ${photos.profile ? 'Retake your photo' : 'Take your photo'}</label>
        <input type="file" class="photopick" id="ob-profile-photo" accept="image/*" capture="camera">
        ${photos.profile ? `<img class="photo-preview" src="${photos.profile}" alt="Your photo preview">` : ''}</div>
      <div class="btnrow">
        <button class="btn ghost" id="ob-back">Back</button>
        <button class="btn green" id="ob-submit">Submit for approval</button>
      </div>`;
    }
    $('#app').innerHTML = `
    <div class="authwrap">
      ${eyebrow('Get started', true)}
      <div class="logo">${I.bike}</div>
      ${steps}
      ${body}
      <div style="height:14px"></div>
      <button class="btn ghost" id="ob-out">Log out</button>
    </div>`;
    $('#ob-out').onclick = () => logout();

    const nx = $('#ob-next');
    if (nx) nx.onclick = async () => {
      readStep1();
      if (!draft.vno) { toast('Please enter your vehicle number.', 'err'); return; }
      if (!draft.lic) { toast('Please enter your driving licence number.', 'err'); return; }
      // Save vehicle details incrementally so progress survives reload
      try {
        await api('/api/rider/profile', {
          method: 'PUT',
          body: { vehicle_type: draft.vtype, vehicle_number: draft.vno, licence_no: draft.lic },
        });
      } catch (e) { toast(e.message, 'err'); return; }
      step = 2; paint();
    };
    const bk = $('#ob-back');
    if (bk) bk.onclick = () => { readStep2(); step = 1; paint(); };

    const pa = $('#ob-aadhaar-photo');
    if (pa) pa.onchange = () => {
      readStep2();
      downscalePhoto(pa.files && pa.files[0], (url) => {
        photos.aadhaar = url;
        toast('Aadhaar photo attached', 'ok');
        paint();
      });
    };
    const pp = $('#ob-profile-photo');
    if (pp) pp.onchange = () => {
      readStep2();
      downscalePhoto(pp.files && pp.files[0], (url) => {
        photos.profile = url;
        toast('Photo attached', 'ok');
        paint();
      });
    };

    const sub = $('#ob-submit');
    if (sub) sub.onclick = async () => {
      readStep2();
      if (!/^\d{12}$/.test(draft.aadhaar)) { toast('Enter your 12-digit Aadhaar number.', 'err'); return; }
      if (!photos.aadhaar) { toast('Please attach your Aadhaar card photo.', 'err'); return; }
      if (!photos.profile) { toast('Please attach your photo.', 'err'); return; }
      sub.disabled = true; sub.textContent = 'Submitting…';
      try {
        await api('/api/rider/profile', {
          method: 'PUT',
          body: {
            vehicle_type: draft.vtype,
            vehicle_number: draft.vno,
            licence_no: draft.lic,
            aadhaar_no: draft.aadhaar,
            aadhaar_photo: photos.aadhaar,
            profile_photo: photos.profile,
          },
        });
        state.onboardPhotos = {};
        toast('Details submitted! Waiting for approval.', 'ok');
        boot();
      } catch (e) {
        toast(e.message, 'err');
        sub.disabled = false; sub.textContent = 'Submit for approval';
      }
    };
  }
  paint();
}

/* Upload the rider's own photo (≤800px JPEG) straight to their profile. */
function uploadAvatarPhoto() {
  const inp = $('#avatar-file');
  const file = inp && inp.files && inp.files[0];
  if (!file) return;
  resizePhoto(file, 800, 0.75, async (url) => {
    try {
      toast('Uploading your photo…');
      const data = await api('/api/rider/profile', { method: 'PUT', body: { profile_photo: url } });
      const rd = (data && data.rider) || {};
      state.rider.profile_photo = rd.profile_photo || url;
      const old = $('#rider-avatar');
      if (old) {
        const img = document.createElement('img');
        img.id = 'rider-avatar';
        img.alt = 'Your photo';
        img.src = state.rider.profile_photo;
        old.replaceWith(img);
      }
      toast('Photo updated', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      if (inp) inp.value = '';
    }
  });
}


/* Quest cards with live progress bars on home. */
async function loadQuests() {
  const wrap = $('#quest-wrap');
  if (!wrap) return;
  try {
    const data = await api('/api/rider/quests');
    const qs = data.quests || [];
    if (!qs.length) { if (wrap.dataset.q !== 'empty') { wrap.dataset.q = 'empty'; wrap.innerHTML = ''; } return; }
    /* Guard: the 60s refresh must not rebuild the quest cards when nothing changed. */
    const key = qs.map(q => [q.id || q.name, q.completed, q.target_deliveries, q.bonus_earned, q.bonus_paise, q.ends_at].join(':')).join('|');
    if (wrap.dataset.q === key) return;
    wrap.dataset.q = key;
    wrap.innerHTML = eyebrow('Quests & bonuses') + qs.map(q => {
      const target = Number(q.target_deliveries || 0);
      const done = target > 0 ? Math.min(Number(q.completed || 0), target) : 0;
      const pct = target > 0 ? Math.round((done / target) * 100) : 0;
      return `
      <div class="card quest">
        <div class="row">
          <div class="grow"><h2 style="margin:0">${esc(q.name || 'Quest')}</h2></div>
          ${q.bonus_earned
            ? '<span class="qdone">Bonus earned</span>'
            : `<span class="qbonus">+${fmtRs(q.bonus_paise)} bonus</span>`}
        </div>
        <div class="qbar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div class="qfill" style="width:${pct}%"></div></div>
        <div class="muted small">${done} of ${target} deliveries · ends ${fmtDate(q.ends_at)}</div>
      </div>`;
    }).join('');
  } catch (e) { /* quests are optional — never break home */ }
}

/* ================= HOME ================= */
async function refreshActiveCount() {
  // Count-only refresh: the summary endpoint returns NO timeline, so its rows
  // must never replace state.active — doing so reset every Active card to
  // step 0 ("Reached restaurant") until the detail fetch repainted it.
  try {
    const data = await api('/api/rider/deliveries?status=active');
    state.activeCount = (data.deliveries || []).length;
  } catch (e) { /* non-fatal */ }
}

// Single source for "how many active deliveries": the count endpoint when we
// have it, otherwise the detail list length.
function activeCount() {
  return state.activeCount != null ? state.activeCount : (state.active || []).length;
}


// Streaks: consecutive days online (user 2026-10-18: best rider app)
function updateStreak() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const last = localStorage.getItem('rider_streak_last');
    let streak = parseInt(localStorage.getItem('rider_streak') || '0', 10);
    if (last === today) return streak; // already counted today
    const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
    streak = (last === yesterday) ? streak + 1 : 1;
    localStorage.setItem('rider_streak', String(streak));
    localStorage.setItem('rider_streak_last', today);
    const el = document.getElementById('rh-streak');
    if (el && streak >= 2) el.textContent = '🔥' + streak;
    return streak;
  } catch (e) { return 0; }
}
function paintStreak() {
  try {
    const streak = parseInt(localStorage.getItem('rider_streak') || '0', 10);
    const el = document.getElementById('rh-streak');
    if (el && streak >= 2) el.textContent = '🔥' + streak;
  } catch (e) {}
}


// Leaderboard + hotspots (user 2026-10-18: best rider app)
async function loadHomeExtras() {
  try {
    const pk = await api('/api/rider/peak-hours');
    const pel = document.getElementById('rh-peak');
    if (pel && pk.peak_hours && pk.peak_hours.length) {
      const fmt = h => { const ap = h >= 12 ? 'pm' : 'am'; const hh = h % 12 || 12; return hh + ap; };
      const hrs = pk.peak_hours.map(fmt).join(', ');
      pel.innerHTML = pk.is_peak_now
        ? `<div class="rh-peak-now">🔥 Peak hours right now — stay online!</div>`
        : `<div class="rh-peak-soon">⏰ Peak hours: ${hrs}</div>`;
    }
  } catch (e) {}
  try {
    const lb = await api('/api/rider/leaderboard');
    const bel = document.getElementById('rh-board');
    if (bel && lb.board && lb.board.length) {
      bel.innerHTML = `<div class="rh-sec-t">🏆 Top riders this week</div>` +
        lb.board.slice(0, 5).map(x =>
          `<div class="rh-lb-row ${x.is_me ? 'me' : ''}"><span class="rh-lb-rank">${x.rank}</span><span class="rh-lb-name">${esc(x.name)}</span><span class="rh-lb-earn">₹${x.earned}</span></div>`
        ).join('');
    }
  } catch (e) {}
  try {
    const hs = await api('/api/rider/hotspots');
    const hel = document.getElementById('rh-hotspots');
    if (hel && hs.hotspots && hs.hotspots.length) {
      hel.innerHTML = `<div class="rh-sec-t">🔥 Hot right now</div>` +
        hs.hotspots.map(h =>
          `<div class="rh-hs-row"><span>📍 ${esc(h.area)}</span><b>${h.orders} order${h.orders > 1 ? 's' : ''}</b></div>`
        ).join('');
    }
  } catch (e) {}
}

function renderHome() {
  clearTimers();
  const r = state.rider || {};
  const nActive = (state.active && state.active.length) || 0;
  const online = !!state.online;
  const firstName = (r.name || 'Rider').split(' ')[0];
  setPage(`
    <div class="rh">
      <div class="rh-head">
        <div class="rh-greet">
          <div class="rh-hi">Hi, ${firstName} 👋 <span class="rh-streak" id="rh-streak"></span></div>
          <div class="rh-sub">${online ? "You're earning — stay ready" : "Go online to start earning"}</div>
        </div>
        <button class="rh-switch ${online ? 'on' : ''}" id="btn-go" aria-label="${online ? 'Go offline' : 'Go online'}">
          <span class="rh-knob"></span>
        </button>
      </div>
      <div class="rh-hero" id="b-earn">
        <div class="rh-hero-top">
          <span class="rh-hero-lbl">Today's earnings</span>
          <span class="rh-hero-chev">›</span>
        </div>
        <div class="rh-hero-val" id="b-earn-val">₹0</div>
        <div class="rh-hero-sub" id="b-earn-sub"></div>
        <div class="rh-goal" id="rh-goal">
          <div class="rh-goal-bar"><div class="rh-goal-fill" id="rh-goal-fill"></div></div>
          <div class="rh-goal-txt" id="rh-goal-txt"></div>
        </div>
        <div class="rh-stats" id="rh-stats"></div>
      </div>
      <div class="rh-mapwrap" id="b-mapwrap">
        <div id="home-mini-map" class="rh-map"></div>
        <div class="rh-live"><span class="rh-pulse"></span><b id="b-loc-name">Locating…</b></div>
      </div>
      <div class="rh-extra" id="rh-peak"></div>
      <div class="rh-extra" id="rh-hotspots"></div>
      <div class="rh-extra" id="rh-board"></div>
      <div class="rh-status" id="b-orders">
        ${nActive > 0 ? `
          <div class="rh-active">
            <div class="rh-active-n">${nActive}</div>
            <div class="rh-active-t">active order${nActive > 1 ? 's' : ''}</div>
            <div class="rh-active-s">Your route is ready — let's deliver.</div>
            <button class="rh-cta" id="b-go-orders">View Orders →</button>
          </div>
        ` : online ? `
          <div class="rh-wait">
            <div class="rh-wait-dot"><span></span></div>
            <div class="rh-wait-t">You're in the zone</div>
            <div class="rh-wait-s">New orders will pop up here.<br>Stay close, stay ready.</div>
          </div>
        ` : `
          <div class="rh-wait">
            <div class="rh-wait-t">You're offline</div>
            <div class="rh-wait-s">Flip the switch above<br>to start receiving orders.</div>
          </div>
        `}
      </div>
    </div>
  `, 'home');
  const page = $('#app .page');
  if (page) page.classList.add('flush');

  // Go online/offline
  const goBtn = $('#btn-go');
  if (goBtn) goBtn.onclick = async () => {
    const want = !state.online;
    goBtn.disabled = true;
    try {
      if (!want) {
        await refreshActiveCount();
        const n = activeCount();
        if (n > 0) {
          toast('You have ' + n + ' active deliver' + (n === 1 ? 'y' : 'ies') + ' — finish ' + (n === 1 ? 'it' : 'them') + ' before going offline.', 'err');
          goBtn.disabled = false;
          return;
        }
      }
      const res = await api('/api/rider/online', { method: 'PUT', body: { online: want } });
      state.online = !!res.online;
      if (want) updateStreak();
      toast(want ? 'You are online. Deliveries incoming!' : 'You are offline.', want ? 'ok' : undefined);
      if (want) { await sendLocation(true); await pollAvailable(); startOfferPoll(); const bgOk = await startBgTracking(); if (!bgOk) startLiveTracking(); startAutoArrive(); }
      else { stopOfferPoll(); stopBgTracking(); stopLiveTracking(); stopAutoArrive(); state.available = []; }
      const h = location.hash || '';
      if (h === '#/home' || h === '') renderHome(); else route();
    } catch (e) {
      toast(e.message, 'err');
      goBtn.disabled = false;
    }
  };

  // View orders button
  const goOrders = $('#b-go-orders');
  if (goOrders) goOrders.onclick = () => { location.hash = '#/orders'; };

  // Earnings card tap -> profile
  const earn = $('#b-earn');
  if (earn) earn.onclick = () => { location.hash = '#/profile'; };

  // Auto-load the live map
  try { initHomeMiniMapBlack(); } catch (e) {}
  updateHomeEarnings();
  paintStreak();
  loadHomeExtras();
}

function updateHomeEarnings() {
  try {
    const t = state.todayEarnings;
    const v = $('#b-earn-val');
    if (v && t != null) v.textContent = '₹' + (t.today || 0);
    const s = $('#b-earn-sub');
    const trips = (t && t.trips) || 0;
    const week = (t && t.week) || 0;
    if (s) s.textContent = trips + ' trips · ₹' + week + ' this week';
    const stats = $('#rh-stats');
    if (stats) {
      const r = state.rider || {};
      const rating = r.rating ? Number(r.rating).toFixed(1) + '★' : '—';
      stats.innerHTML =
        '<div class="rh-stat"><b>' + trips + '</b><span>trips</span></div>' +
        '<div class="rh-stat"><b>₹' + week + '</b><span>this week</span></div>' +
        '<div class="rh-stat"><b>' + rating + '</b><span>rating</span></div>';
    }
    // Daily goal bar
    try {
      const goal = parseInt(localStorage.getItem('rider_daily_goal') || '500', 10);
      const earned = (t && t.today) || 0;
      const pct = Math.min(100, Math.round(earned / goal * 100));
      const fill = $('#rh-goal-fill');
      const txt = $('#rh-goal-txt');
      if (fill) fill.style.width = pct + '%';
      if (txt) txt.textContent = pct >= 100 ? '🎉 Goal smashed!' : '₹' + earned + ' of ₹' + goal + ' goal';
    } catch (e) {}
  } catch (e) {}
}

function initHomeMiniMapBlack() {
  if (!window.google) { initMap(); setTimeout(initHomeMiniMapBlack, 300); return; }
  const el = document.getElementById('home-mini-map');
  if (!el || el.dataset.ready) return;
  const cp = state.currentPos;
  const hasPos = cp && cp.lat != null;
  const center = hasPos ? { lat: +cp.lat, lng: +cp.lng } : { lat: 14.4426, lng: 79.9865 };
  const mm = new google.maps.Map(el, {
    center: center,
    zoom: 15,
    disableDefaultUI: true,
    gestureHandling: 'greedy',
    styles: currentMapStyle()
  });
  el.dataset.ready = '1';
  window._homeMap = mm;
  // Force resize after layout settles (fixes map not filling container)
  setTimeout(() => {
    try {
      if (window.google && mm) google.maps.event.trigger(mm, 'resize');
    } catch (e) {}
  }, 500);
  // Rider marker
  const mk = new google.maps.Marker({
    position: center,
    map: mm,
  });
  el._bikeMarker = mk;
  // Update location name
  const nameEl = document.getElementById('b-loc-name');
  if (nameEl && hasPos) {
    // Reverse geocode would go here; for now show coords
    nameEl.textContent = 'Current location';
  }
  // GPS updates
  if (navigator.geolocation) {
    const updatePos = (pos) => {
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.currentPos = p;
      try {
        mk.setPosition(p);
        mm.panTo(p);
        mm.setZoom(15);
        if (nameEl) nameEl.textContent = 'Current location';
      } catch (e) {}
    };
    // Fast first: low accuracy (WiFi/cell, ~2 sec)
    navigator.geolocation.getCurrentPosition(updatePos, () => {
      // Fallback: try high accuracy if fast fails
      navigator.geolocation.getCurrentPosition(updatePos, () => {}, 
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
    }, { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 });
  }
}

/* Wire the Home mini-map after renderHome paints (lazy init) */
function wireHomeMiniMap() {
  if (!window.google) { initMap(); return; } // triggers script load; initGoogleMap calls initHomeMiniMap
  initHomeMiniMap();
}
function openProfileModal() {
  const r = state.rider || {};
  const back = document.createElement('div');
  back.className = 'modalback';
  back.innerHTML = `
    <div class="modal" role="dialog" aria-label="Edit profile">
      <h2>Edit profile</h2>
      <div class="field"><label for="m-name">Your name</label>
        <input class="input" id="m-name" value="${esc(r.name || '')}" placeholder="Full name" maxlength="60"></div>
      <div class="kv"><span class="k">Phone</span><span class="v">+91 ${esc(r.phone || '')}</span></div>
      <div style="height:10px"></div>
      <div class="field"><label for="m-vehicle">Vehicle type</label>
        <select class="input" id="m-vehicle">
          ${['bike', 'scooter', 'bicycle', 'ev'].map(v => `<option value="${v}" ${r.vehicle_type === v ? 'selected' : ''}>${v === 'ev' ? 'EV' : v[0].toUpperCase() + v.slice(1)}</option>`).join('')}
        </select></div>
      <div class="field"><label for="m-vehno">Vehicle number</label>
        <input class="input" id="m-vehno" value="${esc(r.vehicle_number || '')}" placeholder="e.g. AP39 AB 1234"></div>
      <div class="field"><label for="m-lic">Driving licence no.</label>
        <input class="input" id="m-lic" value="${esc(r.licence_no || '')}" placeholder="Licence number"></div>
      <div class="btnrow">
        <button class="btn ghost" id="m-cancel">Cancel</button>
        <button class="btn" id="m-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.addEventListener('click', e => { if (e.target === back) close(); });
  $('#m-cancel', back).onclick = close;
  $('#m-save', back).onclick = async () => {
    const btn = $('#m-save', back);
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const data = await api('/api/rider/profile', {
        method: 'PUT',
        body: {
          name: $('#m-name', back).value.trim(),
          vehicle_type: $('#m-vehicle', back).value,
          vehicle_number: $('#m-vehno', back).value.trim(),
          licence_no: $('#m-lic', back).value.trim(),
        },
      });
      const rider = data.rider || data;
      // Preserve name/phone from current state — the PUT response only has rider fields
      if (state.rider) {
        if (!rider.name) rider.name = state.rider.name;
        if (!rider.phone) rider.phone = state.rider.phone;
      }
      if (rider.user) {
        if (!rider.name) rider.name = rider.user.name;
        if (!rider.phone) rider.phone = rider.user.phone;
      }
      state.rider = rider;
      toast('Profile updated', 'ok');
      close();
      route(); /* re-render the current tab (profile) — not Home */
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false; btn.textContent = 'Save';
    }
  };
}

function sendLocation(manual) {
  return new Promise(resolve => {
    if (!navigator.geolocation) {
      if (manual) toast('Geolocation is not supported on this device.', 'err');
      return resolve();
    }
    if (manual) toast('Getting your location…');
    navigator.geolocation.getCurrentPosition(async pos => {
      try {
        await api('/api/rider/location', {
          method: 'PUT',
          body: { lat: pos.coords.latitude, lng: pos.coords.longitude },
        });
        state.lastLocAt = Date.now();
        const line = $('#loc-line');
        if (line) line.textContent = 'Last updated: just now';
        if (manual) toast('Location updated', 'ok');
      } catch (e) {
        if (manual) toast(e.message, 'err');
      }
      resolve();
    }, err => {
      if (manual) toast('Could not get location: ' + (err.message || 'permission denied'), 'err');
      resolve();
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}

/* ================= AVAILABLE ================= */
let watchId = null;
function startLiveTracking() {
  stopLiveTracking();
  if (!navigator.geolocation || !state.online) return;
  // Continuous GPS while online — updates backend as rider moves (Zomato-style)
  watchId = navigator.geolocation.watchPosition(async pos => {
    try {
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.currentPos = p;
      // Animate runner: running when moving (>1.5 m/s), standing when stopped
      try {
        const speed = pos.coords.speed;
        const moving = speed != null && speed > 1.5;
        updateRunnerState(moving);
        // Move marker AND pan map to follow rider
        const el = document.getElementById('home-mini-map');
        if (el && el._bikeMarker && window._homeMap) {
          el._bikeMarker.setPosition(p);
          try { window._homeMap.panTo(p); } catch (e) {}
        }
      } catch (e) {}
      await api('/api/rider/location', {
        method: 'PUT',
        body: { lat: p.lat, lng: p.lng },
      });
      state.lastLocAt = Date.now();
      const line = $('#loc-line');
      if (line) line.textContent = 'Live tracking on';
    } catch (e) { /* silent — retry on next update */ }
  }, () => {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 });
}
function stopLiveTracking() {
  if (watchId != null && navigator.geolocation) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}

/* ============ NATIVE BACKGROUND GPS (Capacitor) ============
   Floop Captain Android build: keeps reporting the rider's location
   with the screen off, but ONLY while the rider is online. On the web
   build window.BackgroundGeolocation is undefined and everything falls
   back to navigator.geolocation.watchPosition — web behavior unchanged. */
function bgGeo() {
  try { return window.BackgroundGeolocation || null; } catch (e) { return null; }
}
let bgGeoReady = false;
let bgGeoOn = false;
async function startBgTracking() {
  const BG = bgGeo();
  if (!BG || !BG.ready) return false;
  try {
    if (!bgGeoReady) {
      await BG.ready({
        desiredAccuracy: BG.DESIRED_ACCURACY_HIGH,
        distanceFilter: 10,
        stopTimeout: 5,
        debug: false,
        logLevel: BG.LOG_LEVEL_OFF,
        startOnBoot: false,
        stopOnTerminate: true,
        foregroundService: true,
        notification: { title: 'Floop Captain', text: 'Sharing location while you are online' },
        url: API + '/api/rider/location',
        method: 'PUT',
        autoSync: true,
        batchSync: false,
        headers: { 'Authorization': 'Bearer ' + (state.token || '') },
        params: {},
        locationTemplate: '{"lat":<%= latitude %>,"lng":<%= longitude %>}',
      }, function(state) {
        // ready callback — plugin state
      });
      BG.onLocation(function(loc) {
        try {
          const p = { lat: loc.coords.latitude, lng: loc.coords.longitude };
          state.currentPos = p;
          state.lastLocAt = Date.now();
          const el = document.getElementById('home-mini-map');
          if (el && el._bikeMarker && window._homeMap) {
            el._bikeMarker.setPosition(p);
            try { window._homeMap.panTo(p); } catch (e) {}
          }
          const line = document.getElementById('loc-line');
          if (line) line.textContent = 'Live tracking on';
        } catch (e) {}
      });
      bgGeoReady = true;
    } else {
      try { await BG.setConfig({ headers: { 'Authorization': 'Bearer ' + (state.token || '') } }); } catch (e) {}
    }
    await BG.start();
    bgGeoOn = true;
    return true;
  } catch (e) { return false; }
}
async function stopBgTracking() {
  const BG = bgGeo();
  if (!BG || !BG.stop) return;
  try { await BG.stop(); } catch (e) {}
  bgGeoOn = false;
}
// One shared AudioContext, unlocked on the first user tap. Mobile browsers
// start audio suspended until the user interacts — without this unlock the
// offer chime would never play on phones.
let audioCtx = null;
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) { /* audio not supported */ }
  return audioCtx;
}
window.addEventListener('pointerdown', ensureAudio, { passive: true });

// Urgent two-tone alarm when a new delivery lands — three bursts that cut
// through a noisy kitchen, plus vibration on Android. Sound plays only once
// audio is actually running (user has tapped); vibration fires regardless.
// iOS: keep the ringer switch ON or the alarm is silenced by the OS.
function playNewDeliverySound() {
  const ctx = ensureAudio();
  if (ctx && ctx.state === 'running') {
    try {
      const seq = [880, 659.25, 880, 659.25, 880, 659.25]; // A5, E5 alternating
      seq.forEach(function (freq, i) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.frequency.value = freq; osc.type = 'triangle';
        const t = ctx.currentTime + i * 0.22;
        gain.gain.setValueAtTime(0.001, t);
        gain.gain.exponentialRampToValueAtTime(0.7, t + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        osc.start(t); osc.stop(t + 0.22);
      });
    } catch (e) { /* audio not supported */ }
  }
  try { if (navigator.vibrate) navigator.vibrate([250, 120, 250, 120, 400]); } catch (e) { /* not supported */ }
}
var availPollInitialized = false;
async function pollAvailable() {
  try {
    const data = await api('/api/rider/deliveries/available');
    const prevIds = (state.available || []).map(function (d) { return d.id; });
    state.available = data.deliveries || [];
    // Sound + full-screen alert for newly arrived deliveries — including the very first one after the initial poll
    var hasNew = state.available.some(function (d) { return prevIds.indexOf(d.id) < 0; });
    if (hasNew && availPollInitialized) { playNewDeliverySound(); maybeShowTakeover(prevIds); }
    availPollInitialized = true;
    if ((location.hash || '') === '#/available') paintAvailableList();
    updateBadges();
  } catch (e) { /* transient; keep old list */ }
}

/* Global offer poll: offers must surface on EVERY tab, not just Home/
   Available. route() calls clearTimers() on every navigation, which killed
   the old per-tab polls; this raw setInterval deliberately bypasses
   every()/state.timers so tab switches can never stop it. Started when the
   rider goes online (toggle, boot restore), stopped on offline/logout. */
function startOfferPoll() {
  if (state.offerPollId) return; /* already running - never stack intervals */
  const tick = () => {
    if (!state.online || document.hidden) return;
    pollAvailable().then(() => {
      try {
        const h = location.hash || '';
        if (h === '#/available') paintAvailCount();
        else if ((h === '#/home' || h === '') && typeof hmOfferPainter === 'function') hmOfferPainter();
      } catch (e) {}
    });
  };
  tick(); /* immediate first poll, like the old per-tab loaders */
  state.offerPollId = setInterval(tick, 2500);
}
function stopOfferPoll() {
  if (state.offerPollId) { clearInterval(state.offerPollId); state.offerPollId = null; }
}
/* Latest Home offer-box painter, installed by renderHome() so the global
   poll can refresh it. Null-safe: the painter no-ops when #hs-offers is
   absent (rider is on another tab). */
let hmOfferPainter = null;
/* Available-tab count pill - extracted from renderAvailable's old paintCount
   closure so the global poll can refresh it while that tab is open. */
function paintAvailCount() {
  const box = $('#avail-count'), sub = $('#avail-sub');
  if (!box) return;
  const n = state.online ? (state.available || []).length : 0;
  /* Guard: this runs on every 2.5s poll - skip the DOM writes when the
     count/online state hasn't changed. */
  const key = (state.online ? 'on' : 'off') + ':' + n;
  if (box.dataset.k === key) return;
  box.dataset.k = key;
  box.style.display = n ? '' : 'none';
  box.querySelector('b').textContent = n;
  box.querySelector('span').textContent = n === 1 ? 'offer' : 'offers';
  if (sub && state.online) sub.textContent = n ? 'Tap an offer to accept it - first come, first served.' : 'You are online. New offers land here with a chime.';
}

function availCardHash(d) {
  /* Distances jitter between polls (GPS/backend recompute) — hash them at the
     same 0.1 km precision the card displays, so float noise never flaps the
     hash and the whole card is not destroyed/rebuilt every 2.5s. */
  const r1 = v => v == null ? '' : (Math.round(Number(v) * 10) / 10).toFixed(1);
  return [d.id, d.payout_paise, r1(d.distance_km), r1(d.pickup_km), d.total_paise,
          d.payment_method, d.restaurant_name, d.rest_address, d.address, d.placed_at].join('|');
}

/* ================= OFFER TAKEOVER =================
   When a new delivery lands while the rider waits on Home, the whole screen
   becomes the offer — payout hero, route, Decline pill, big Accept with a
   live countdown — like the DoorDash Dasher screen the user asked for.
   The countdown is honest: it's the alert window, not a fake reservation.
   When it runs out the alert closes and the offer stays in Available.
   No fake map (Maps isn't configured): a stylized schematic route graphic. */
const takeoverSeen = new Set();
function closeTakeover() {
  const root = $('#takeover-root');
  if (!root) return;
  if (root._tkTimer) { clearInterval(root._tkTimer); root._tkTimer = null; }
  if (root.firstChild) root.innerHTML = '';
}
function maybeShowTakeover(prevIds) {
  /* Offers surface on EVERY tab - a rider mid-delivery must see new offers
     too, not just on Home. #takeover-root lives in the common shell, the
     alert auto-dismisses in 35s, and the offer stays in the Available list. */
  if (!state.online) return;
  if (activeCount() >= 3) return; /* slots full — nothing to accept */
  const root = $('#takeover-root');
  if (!root || root.firstChild) return; /* one alert at a time */
  const fresh = (state.available || []).filter(d =>
    prevIds.indexOf(d.id) < 0 && !takeoverSeen.has(String(d.id)));
  if (!fresh.length) return;
  fresh.sort((a, b) => String(b.placed_at || '').localeCompare(String(a.placed_at || '')));
  showOfferTakeover(fresh[0]);
}
/* Trip payout breakdown modal (user 2026-10-15): tappable payout shows the calculation */
function showBreakdownModal(title, lines) {
  const back = document.createElement('div');
  back.className = 'modalback';
  back.innerHTML = `
    <div class="modal" role="dialog" aria-label="${esc(title)}">
      <h2>${esc(title)}</h2>
      <div style="margin:12px 0">
        ${lines.map(l => `<div class="kv"><span class="v" style="text-align:left">${esc(l)}</span></div>`).join('')}
      </div>
      <button class="btn" id="bd-close" style="width:100%">Close</button>
    </div>`;
  document.body.appendChild(back);
  const close = () => back.remove();
  back.querySelector('#bd-close').onclick = close;
  back.onclick = (e) => { if (e.target === back) close(); };
}


// Bottom sheet offer for when rider is already riding - doesn't block the map
function showOfferBottomSheet(d) {
  const root = $('#takeover-root');
  if (!root || root.firstChild) return;
  const tripPayout = d.trip_payout_paise != null ? Number(d.trip_payout_paise) : (d.payout_paise != null ? Number(d.payout_paise) : null);
  const earn = tripPayout != null ? fmtRs(tripPayout) : '';
  const tripKm = d.trip_distance_km != null ? Number(d.trip_distance_km) : null;
  const pickKm = d.pickup_km != null ? Number(d.pickup_km) : null;
  root.innerHTML = `
  <div class="offer-sheet" role="alertdialog" aria-label="New delivery offer">
    <div class="os-card" data-delivery-id="${esc(d.id)}">
      <div class="os-eyebrow">New Offer</div>
      <div class="os-rest">${esc(d.restaurant_name || 'Restaurant')}</div>
      <div class="os-meta">${pickKm != null ? pickKm.toFixed(1) + ' km away' : ''}${pickKm != null && tripKm != null ? ' · ' : ''}${tripKm != null ? tripKm.toFixed(1) + ' km trip' : ''}</div>
      ${earn ? `<div class="os-pay">You'll earn <b>${earn}</b></div>` : ''}
      <div class="os-btns">
        <button class="btn accept os-accept" id="os-accept">Accept</button>
        <button class="btn ghost os-decline" id="os-decline">Decline</button>
      </div>
    </div>
  </div>`;
  $('#os-decline').onclick = () => closeTakeover();
  $('#os-accept').onclick = (e) => acceptDelivery(d.id, e.target);
}

function showOfferTakeover(d) {
  const root = $('#takeover-root');
  if (!root || root.firstChild) return;
  takeoverSeen.add(String(d.id));
  // If rider is already on a delivery (riding), use bottom sheet instead of full takeover
  const isRiding = state.active && state.active.length > 0;
  if (isRiding) {
    showOfferBottomSheet(d);
    return;
  }
  // Trip-based payout (user 2026-10-15): use trip_payout_paise, fall back to payout_paise for old orders
  const tripPayout = d.trip_payout_paise != null ? Number(d.trip_payout_paise) : (d.payout_paise != null ? Number(d.payout_paise) : null);
  const earn = tripPayout != null ? fmtRs(tripPayout) : '';
  const tripKm = d.trip_distance_km != null ? Number(d.trip_distance_km) : (d.distance_km != null ? Number(d.distance_km) : null);
  const tripStops = d.trip_intermediate_stops != null ? Number(d.trip_intermediate_stops) : 0;
  const breakdown = d.trip_payout_breakdown ? (typeof d.trip_payout_breakdown === 'string' ? JSON.parse(d.trip_payout_breakdown) : d.trip_payout_breakdown) : null;
  const pickKm = d.pickup_km != null ? Number(d.pickup_km) : null;
  const isCod = String(d.payment_method || '').toLowerCase() === 'cod';
  const legs = [];
  if (pickKm != null) legs.push(pickKm.toFixed(1) + ' km to pickup');
  if (tripKm != null) legs.push(tripKm.toFixed(1) + ' km trip');
  legs.push(isCod ? '💵 Cash on delivery' : '✓ Prepaid');
  const secs = 35;
  root.innerHTML = `
  <div class="takeover" role="alertdialog" aria-label="New delivery offer">
    <div class="tk-card" data-delivery-id="${esc(d.id)}">
      <button class="tk-decline" id="tk-decline">Decline</button>
      <div class="tk-eyebrow">New delivery offer</div>
      <div class="tk-route" aria-hidden="true">
        <svg viewBox="0 0 300 96" width="100%" height="96" preserveAspectRatio="xMidYMid meet">
          <path d="M36 66 C 100 66, 110 30, 170 30 S 240 58, 264 44" fill="none" stroke="#c98a1e" stroke-width="3" stroke-dasharray="1 9" stroke-linecap="round"/>
          <circle cx="36" cy="66" r="7" fill="#c98a1e"/>
          <circle cx="36" cy="66" r="12" fill="none" stroke="#c98a1e" stroke-width="2" opacity=".45"/>
          <circle cx="264" cy="44" r="7" fill="#1c7a45"/>
          <circle cx="264" cy="44" r="12" fill="none" stroke="#1c7a45" stroke-width="2" opacity=".45"/>
        </svg>
        <div class="tk-route-labels"><span>Pickup</span><span>Drop</span></div>
      </div>
      ${earn ? `<div class="tk-pay" data-trip-breakdown='${esc(JSON.stringify(breakdown || {}))}' style="cursor:pointer" title="Tap for breakdown">
        <div class="tk-value">${earn}</div>
        <div class="tk-cap">You'll get ${earn} for this trip${tripKm != null ? ' · ' + tripKm.toFixed(1) + ' km' : ''}${tripStops > 0 ? ' · ' + tripStops + ' stop' + (tripStops > 1 ? 's' : '') : ''}</div>
        <div class="tk-hint" style="font-size:11px;opacity:0.7;margin-top:2px">Tap for breakdown</div>
      </div>` : ''}
      <div class="tk-meta">${esc(legs.join('  ·  '))}</div>
      <div class="tk-stops">
        <div class="tk-stop"><span class="rt-dot pick"></span>
          <div class="rt-tx"><div class="rt-k">Pickup — ${esc(d.restaurant_name || 'Restaurant')}</div>
          ${d.rest_address ? `<div class="rt-a">${esc(d.rest_address)}</div>` : ''}</div>
        </div>
        ${d.address ? `<div class="tk-stop"><span class="rt-dot drop"></span>
          <div class="rt-tx"><div class="rt-k">Drop</div><div class="rt-a">${esc(d.address)}</div></div>
        </div>` : ''}
      </div>
      <button class="btn accept tk-accept" id="tk-accept">${I.check} <span id="tk-accept-t">Accept · 0:${secs}</span></button>
      <div class="tk-timer" aria-hidden="true"><div class="tk-fill" id="tk-fill"></div></div>
      <div class="tk-note">Alert closes in <span id="tk-secs">${secs}</span>s — the offer stays in your Available list.</div>
    </div>
  </div>`;
  $('#tk-decline').onclick = () => closeTakeover();
  // Tappable payout breakdown (user 2026-10-15)
  const payEl = root.querySelector('[data-trip-breakdown]');
  if (payEl) {
    payEl.onclick = () => {
      try {
        const bd = JSON.parse(payEl.getAttribute('data-trip-breakdown') || '{}');
        if (!bd.base_paise && bd.base_paise !== 0) { toast('Breakdown not available for this trip.'); return; }
        const lines = [
          'Base (first ' + bd.base_km + ' km): ' + fmtRs(bd.base_paise),
          'Distance (' + bd.extra_km + ' km × ₹' + (bd.per_km_paise/100) + '): ' + fmtRs(bd.distance_paise),
        ];
        if (bd.intermediate_stops > 0) {
          lines.push('Stops (' + bd.intermediate_stops + ' × ₹' + (bd.per_stop_paise/100) + '): ' + fmtRs(bd.stops_paise));
        }
        lines.push('Total: ' + fmtRs(bd.base_paise + bd.distance_paise + bd.stops_paise));
        showBreakdownModal('Trip payout breakdown', lines);
      } catch(e) { toast('Breakdown not available.'); }
    };
  }
  const btn = $('#tk-accept');
  btn.onclick = () => {
    if (root._tkTimer) { clearInterval(root._tkTimer); root._tkTimer = null; } /* stop countdown — the button now shows accept progress */
    acceptDelivery(d.id, btn);
  };
  let left = secs;
  const iv = setInterval(() => {
    if (!document.body.contains(btn)) { clearInterval(iv); return; }
    left -= 1;
    if (left <= 0) {
      clearInterval(iv);
      closeTakeover();
      toast('Offer moved to your Available list.');
      return;
    }
    /* Countdown tick: textContent on the label node only (never rebuild the
       button's HTML — re-parsing the SVG icon every second drops frames),
       and the timer bar shrinks via scaleX (compositor-only) instead of width
       (layout) — identical look, zero layout work per tick. */
    const t = $('#tk-accept-t');
    if (t) t.textContent = 'Accept · 0:' + String(left).padStart(2, '0');
    const fill = $('#tk-fill');
    if (fill) fill.style.transform = 'scaleX(' + (left / secs) + ')';
    const s = $('#tk-secs');
    if (s) s.textContent = left;
  }, 1000);
  root._tkTimer = iv;
}

/* The offer card is the rider's accept decision, nothing else:
   what they earn (hero), the route, the rate per km, cash-or-not, one big button. */
function offerScore(d) {
  // Green: great deal, Yellow: decent, Red: poor — based on Rs per km
  const earn = d.trip_payout_paise != null ? Number(d.trip_payout_paise) : (d.payout_paise != null ? Number(d.payout_paise) : null);
  const km = d.trip_distance_km != null ? Number(d.trip_distance_km) : (d.distance_km != null ? Number(d.distance_km) : null);
  if (earn == null || !km) return null;
  const perKm = (earn / 100) / km;
  if (perKm >= 15) return 'good';
  if (perKm >= 10) return 'ok';
  return 'poor';
}
function availCard(d) {
  const rest = d.restaurant_name || 'Restaurant';
  const score = offerScore(d);
  const scoreDot = score ? `<span class="oe-score ${score}" title="${score === 'good' ? 'Great offer' : score === 'ok' ? 'Decent offer' : 'Low paying'}"></span>` : '';
  // Trip-based payout (user 2026-10-15): use trip_payout_paise, fall back to payout_paise
  const earn = d.trip_payout_paise != null ? Number(d.trip_payout_paise) : (d.payout_paise != null ? Number(d.payout_paise) : null);
  const isCod = String(d.payment_method || '').toLowerCase() === 'cod';
  const tripKm = d.trip_distance_km != null ? Number(d.trip_distance_km) : (d.distance_km != null ? Number(d.distance_km) : null);
  const tripStops = d.trip_intermediate_stops != null ? Number(d.trip_intermediate_stops) : 0;
  const breakdown = d.trip_payout_breakdown ? (typeof d.trip_payout_breakdown === 'string' ? JSON.parse(d.trip_payout_breakdown) : d.trip_payout_breakdown) : null;
  const perKm = (earn != null && tripKm) ? Math.round(earn / 100 / tripKm) : null;
  const legs = [];
  if (d.pickup_km != null) legs.push(Number(d.pickup_km).toFixed(1) + ' km to pickup');
  if (tripKm != null) legs.push(tripKm.toFixed(1) + ' km total');
  const metaBits = [...legs, isCod ? '💵 COD' : '✓ Prepaid'];
  return `
  <div class="dcard offer" data-delivery-id="${esc(d.id)}" data-hash="${esc(availCardHash(d))}">
    <div class="oe-top">
      <div>
        <div class="oe-rest">${scoreDot}${esc(rest)}</div>
        <div class="oe-meta">${esc(metaBits.join(' · '))}</div>
      </div>
      ${earn != null ? `<div class="oe-pay" data-trip-breakdown='${esc(JSON.stringify(breakdown || {}))}' style="cursor:pointer" title="Tap for breakdown">
        <div class="oe-value">${fmtRs(earn)}</div>
        <div class="oe-cap">You'll get ${fmtRs(earn)}${tripKm != null ? ' · ' + tripKm.toFixed(1) + ' km' : ''}${perKm != null ? ' · ₹' + perKm + '/km' : ''}${tripStops > 0 ? ' · ' + tripStops + ' stop' + (tripStops > 1 ? 's' : '') : ''}</div>
      </div>` : ''}
    </div>
    <div class="route">
      <div class="rt-stop">
        <span class="rt-dot pick"></span>
        <div class="rt-tx"><div class="rt-k">Pickup</div>
        ${d.rest_address ? `<div class="rt-a">${esc(d.rest_address)}</div>` : ''}</div>
      </div>
      <div class="rt-stop">
        <span class="rt-dot drop"></span>
        <div class="rt-tx"><div class="rt-k">Drop — Customer</div><div class="rt-a">${d.address ? esc(d.address) : 'Address shared on accept'}</div></div>
      </div>
    </div>
    <button class="btn accept" data-accept="${esc(d.id)}">${I.check} Accept delivery</button>
  </div>`;
}

function bindAvailCard(el) {
  const btn = el.querySelector('[data-accept]');
  if (btn) btn.onclick = () => acceptDelivery(btn.getAttribute('data-accept'), btn);
  // Tappable payout breakdown (user 2026-10-15)
  const payEl = el.querySelector('[data-trip-breakdown]');
  if (payEl) {
    payEl.onclick = (e) => {
      e.stopPropagation();
      try {
        const bd = JSON.parse(payEl.getAttribute('data-trip-breakdown') || '{}');
        if (!bd.base_paise && bd.base_paise !== 0) { toast('Breakdown not available for this trip.'); return; }
        const lines = [
          'Base (first ' + bd.base_km + ' km): ' + fmtRs(bd.base_paise),
          'Distance (' + bd.extra_km + ' km × ₹' + (bd.per_km_paise/100) + '): ' + fmtRs(bd.distance_paise),
        ];
        if (bd.intermediate_stops > 0) {
          lines.push('Stops (' + bd.intermediate_stops + ' × ₹' + (bd.per_stop_paise/100) + '): ' + fmtRs(bd.stops_paise));
        }
        lines.push('Total: ' + fmtRs(bd.base_paise + bd.distance_paise + bd.stops_paise));
        showBreakdownModal('Trip payout breakdown', lines);
      } catch(err) { toast('Breakdown not available.'); }
    };
  }
}

/* Diff-based list paint: only cards that were added, removed, reordered or
   whose data changed are touched. Unchanged cards are left alone, so the
   2.5s poll never flickers or moves the rider's scroll position. */
function paintAvailableList() {
  const list = $('#avail-list');
  if (!list) return;
  if (!state.online) {
    if (list.dataset.mode !== 'offline') {
      list.dataset.mode = 'offline';
      list.innerHTML = `<div class="empty dark">${I.truck}<p><b>You are offline.</b></p><p>Go online from Home to see deliveries.</p><a class="btn sm" href="#/home" style="text-decoration:none">Go to Home</a></div>`;
    }
    return;
  }
  if (!state.available.length) {
    if (list.dataset.mode !== 'empty') {
      list.dataset.mode = 'empty';
      /* The rider stares at this screen while waiting — it should feel alive,
         like the next offer is worth waiting for, not like nothing is happening. */
      list.innerHTML = `
        <div class="waiting-hero">
          <div class="radar" aria-hidden="true"><span></span><span></span>${I.bike}</div>
          <div class="eyebrow">Live &amp; listening</div>
          <h3>Waiting for deliveries</h3>
          <p>You are online and in the game. New offers pop in here the moment they are ready — with a chime. Keep this screen open.</p>
          <div class="reward-loop"><span>Accept</span><i>→</i><span>Deliver</span><i>→</i><span>Get paid</span></div>
        </div>`;
    }
    paintCapacityBar(); /* slot usage stays visible while waiting */
    return;
  }
  const cameFromWaiting = list.dataset.mode === 'empty';
  if (list.dataset.mode !== 'list') {
    list.innerHTML = '';
    list.dataset.mode = 'list';
  }
  const byId = new Map();
  list.querySelectorAll(':scope > .dcard[data-delivery-id]').forEach(el => byId.set(String(el.dataset.deliveryId), el));
  // Drop cards that vanished from the pool.
  const want = new Set(state.available.map(d => String(d.id)));
  byId.forEach((el, id) => { if (!want.has(id)) { el.remove(); byId.delete(id); } });
    // Offers landing while the rider stared at the waiting hero are genuinely
  // new — they get the arrival fanfare, not a silent first paint.
  const firstPaint = !cameFromWaiting && list.querySelectorAll(':scope > .dcard').length === 0 && byId.size === 0;
  // Add / update / reorder to match the backend's nearest-first order.
  let anchor = null;
  state.available.forEach(d => {
    const id = String(d.id);
    let el = byId.get(id);
    const hash = availCardHash(d);
    if (el) {
      if (String(el.dataset.hash) !== hash) {
        const fresh = htmlToEl(availCard(d));
        bindAvailCard(fresh);
        el.replaceWith(fresh);
        el = fresh;
        byId.set(id, el);
      }
    } else {
      el = htmlToEl(availCard(d));
      if (!firstPaint) el.classList.add('arrive'); /* the offerin fanfare */
      bindAvailCard(el);
      byId.set(id, el);
    }
    const ref = anchor ? anchor.nextSibling : list.firstChild;
    if (el !== ref) list.insertBefore(el, ref);
    anchor = el;
  });
  paintCapacityBar();
}

async function acceptDelivery(id, btn) {
  btn.disabled = true;
  btn.classList.add('accepting');
  const old = btn.innerHTML;
  btn.innerHTML = 'Accepting…';
  try {
    const data = await api('/api/rider/deliveries/' + encodeURIComponent(id) + '/accept', { method: 'POST' });
    // Satisfying confirmation beat: the button pops green before we move on.
    btn.classList.remove('accepting');
    btn.classList.add('accepted');
    btn.innerHTML = '✓ Accepted!';
    const earn = data && data.payout_paise != null ? ' You earn ' + fmtRs(data.payout_paise) + '.' : '';
    toast('Delivery accepted!' + earn + ' Head to the restaurant.', 'ok');
    closeTakeover(); /* dismiss the offer alert if it was accepted from there */
    await refreshActiveCount();
    await pollAvailable();
    // Auto-navigation: go to Maps and start navigating to the restaurant
    setTimeout(() => {
      location.hash = '#/maps';
      // Wait for map to initialize, then start navigation
      setTimeout(() => {
        try { startNavigation(); } catch (e) {}
      }, 1500);
    }, 800);
  } catch (e) {
    const gone = /no longer available/i.test(e.message || '');
    if (gone) {
      // Another rider grabbed this order first — drop its card immediately
      // instead of waiting for the next poll, so it never lingers on screen.
      const card = btn.closest('[data-delivery-id]');
      if (card) card.remove();
      closeTakeover(); /* the alert's offer is gone too */
      toast('Another rider took this order — removed from your list.', 'err');
      pollAvailable();
    } else {
      toast(e.message, 'err');
      btn.disabled = false;
      btn.classList.remove('accepting');
      btn.innerHTML = old;
    }
  }
}

/* ================= ORDERS (merged Available + Active) =================
   Single tab showing active deliveries first, then available offers.
   Reuses paintActiveList()/paintAvailableList() via the same element IDs. */

function renderEarnings() {
  clearTimers();
  const t = state.todayEarnings || {};
  setPage(`
    <div class="page">
      <h1>Earnings</h1>
      <div class="b-earn" style="margin-bottom:16px">
        <div class="b-earn-lbl">TODAY'S EARNINGS</div>
        <div class="b-earn-row"><span class="b-earn-val">₹${t.today || 0}</span></div>
        <div class="b-earn-sub">${t.trips || 0} trips · ₹${t.week || 0} this week</div>
      </div>
      <p class="sub">Detailed breakdown coming soon.</p>
    </div>
  `, 'earnings');
}

function renderOrders() {
  clearTimers();
  setPage(`
    <div id="orders-active-wrap">
      <div class="eyebrow">In progress</div>
      <h1>Active deliveries</h1>
      <p class="sub">Follow the steps for each order.</p>
      <div id="active-err"></div>
      <div id="active-list">${state.active.length ? '' : skel(210) + skel(210)}</div>
    </div>
    <div id="orders-avail-wrap" style="margin-top:28px">
      <div class="avail-head">
        <div><h1>Available <span class="live-dot" aria-hidden="true"></span></h1>
        <p class="sub" id="avail-sub">New orders near you appear here. First to accept gets it.</p></div>
        <div class="avail-count" id="avail-count" style="display:none"><b>0</b><span>offers</span></div>
      </div>
      <div id="cap-bar"></div>
      <div id="avail-err"></div>
      <div id="avail-list">${state.available.length ? '' : skel(176) + skel(176)}</div>
    </div>
  `, 'orders');
  paintActiveList(); // cached deliveries paint instantly
  paintAvailableList(); // cached offers paint instantly
  paintAvailCount();

  const load = async () => {
    // Load active deliveries
    try {
      await loadActive();
      paintActiveList();
    } catch (e) {
      const box = $('#active-err');
      if (box) box.innerHTML = '<div class="errbox">' + esc(e.message) + '</div>';
      const list = $('#active-list');
      if (list && !state.active.length) list.innerHTML = `<div class="empty">${I.truck}<p>Could not load deliveries.</p></div>`;
    }
    // Load available offers
    if (state.online) {
      try { await pollAvailable(); await refreshActiveCount(); }
      catch (e) {
        const box = $('#avail-err');
        if (box) box.innerHTML = '<div class="errbox">' + esc(e.message) + ' <a href="#/orders">Retry</a></div>';
      }
    }
    paintAvailableList();
    paintAvailCount();
    updateBadges();
  };
  load();
  every(60000, () => { if (state.online) sendLocation(false); });
}

function renderAvailable() {
  clearTimers();
  setPage(`
    <div class="avail-head">
      <div><h1>Available <span class="live-dot" aria-hidden="true"></span></h1>
      <p class="sub" id="avail-sub">New orders near you appear here. First to accept gets it.</p></div>
      <div class="avail-count" id="avail-count" style="display:none"><b>0</b><span>offers</span></div>
    </div>
    <div id="cap-bar"></div>
    <div id="avail-err"></div>
    <div id="avail-list">${state.available.length ? '' : skel(176) + skel(176)}</div>
  `, 'available');
  paintAvailableList(); // cached offers paint instantly — no skeleton flash on revisit
  paintAvailCount();

  const load = async () => {
    if (!state.online) { paintAvailableList(); paintAvailCount(); return; }
    try { await pollAvailable(); await refreshActiveCount(); }
    catch (e) {
      const box = $('#avail-err');
      if (box) box.innerHTML = '<div class="errbox">' + esc(e.message) + ' <a href="#/orders">Retry</a></div>';
    }
    paintAvailableList();
    paintAvailCount();
  };
  load();
  every(60000, () => { if (state.online) sendLocation(false); });
}

/* ================= ACTIVE ================= */
async function loadActive() {
  const data = await api('/api/rider/deliveries?status=active');
  const list = data.deliveries || [];
  // Fetch full detail per delivery (customer address, items, phone numbers, timeline)
  const detailed = await Promise.all(list.map(async d => {
    try {
      const dd = await api('/api/rider/deliveries/' + encodeURIComponent(d.id));
      return dd.delivery || d;
    } catch (e) { return d; }
  }));
  state.active = detailed;
  state.activeCount = detailed.length; // keep badges/slot guard in sync
  return state.active;
}

// Real order statuses: ready -> picked_up -> on_way -> delivered.
// After "Reached restaurant" the status stays 'ready' — the timeline tells the steps apart.
function hasTimelineEvent(d, event) {
  const tl = Array.isArray(d.timeline) ? d.timeline : [];
  return tl.some(t => String(t.status || t.event || '').toLowerCase() === event);
}
function stepIndex(d) {
  const s = String(d.status || '').toLowerCase();
  if (s === 'on_way') return 3;
  if (s === 'picked_up') return 2;
  if (s === 'ready') return hasTimelineEvent(d, 'arrived_restaurant') ? 1 : 0;
  return 0;
}

// Step endpoints and their HTTP methods (per the backend contract).
const STEPS = {
  'arrived-restaurant': { method: 'PUT', suffix: '/arrived-restaurant' },
  'picked-up': { method: 'PUT', suffix: '/picked-up' },
  'arrived-customer': { method: 'PUT', suffix: '/arrived-customer' },
  'complete': { method: 'POST', suffix: '/complete' },
};

// Group active deliveries by trip_id for trip UI
function groupByTrip(deliveries) {
  const trips = [];
  const singles = [];
  const byTrip = {};
  for (const d of deliveries) {
    if (d.trip_id) {
      if (!byTrip[d.trip_id]) {
        byTrip[d.trip_id] = [];
        trips.push(byTrip[d.trip_id]);
      }
      byTrip[d.trip_id].push(d);
    } else {
      singles.push(d);
    }
  }
  return { trips, singles };
}

// Premium trip timeline: Restaurant 1 → Restaurant 2 → Customer
// Designed for "On the Way" — clean, minimal, world-class
function tripCard(orders) {
  if (!orders.length) return '';
  const tripId = orders[0].trip_id;
  // Sort by pickup order (farthest first, per backend)
  const sorted = [...orders].sort((a, b) => {
    const sa = String(a.status).toLowerCase();
    const sb = String(b.status).toLowerCase();
    const doneA = ['picked_up', 'on_way', 'delivered'].includes(sa) ? 1 : 0;
    const doneB = ['picked_up', 'on_way', 'delivered'].includes(sb) ? 1 : 0;
    return doneA - doneB;
  });
  const pickedUp = sorted.filter(o => ['picked_up', 'on_way', 'delivered'].includes(String(o.status).toLowerCase())).length;
  const total = sorted.length;
  const allPickedUp = pickedUp === total;
  const customer = sorted[0].customer_name || 'Customer';
  const addr = [sorted[0].addr_label, sorted[0].line1, sorted[0].city].filter(Boolean).join(', ');
  const payout = sorted.reduce((s, o) => s + (Number(o.rider_payout_paise) || 0), 0);

  // Timeline stops: each restaurant + final customer
  const stops = sorted.map((o, i) => {
    const st = String(o.status).toLowerCase();
    const done = ['picked_up', 'on_way', 'delivered'].includes(st);
    const isNext = !done && sorted.slice(0, i).every(x => ['picked_up', 'on_way', 'delivered'].includes(String(x.status).toLowerCase()));
    const rname = o.restaurant_name || 'Restaurant';
    const raddr = [o.restaurant_address].filter(Boolean).join('');
    return `<div class="tl-stop ${done ? 'done' : ''} ${isNext ? 'next' : ''}">
      <div class="tl-dot">${done ? '✓' : ''}</div>
      <div class="tl-body">
        <div class="tl-name">${esc(rname)}</div>
        ${raddr ? `<div class="tl-addr">${esc(raddr)}</div>` : ''}
        ${isNext ? '<div class="tl-action">Head here now · ask staff for pickup OTP</div>' : ''}
      </div>
    </div>${i < sorted.length - 1 ? '<div class="tl-line"></div>' : ''}`;
  }).join('');

  // Customer stop (final)
  const custStop = `<div class="tl-line"></div>
    <div class="tl-stop customer ${allPickedUp ? 'next' : ''}">
      <div class="tl-dot">${allPickedUp ? '' : ''}</div>
      <div class="tl-body">
        <div class="tl-name">${esc(customer)}</div>
        <div class="tl-addr">${esc(addr)}</div>
        ${allPickedUp ? '<div class="tl-action">Deliver here</div>' : '<div class="tl-addr">Waiting for pickups…</div>'}
      </div>
    </div>`;

  return `<div class="trip-timeline" data-trip="${esc(tripId)}">
    <div class="tt-head">
      <span class="tt-title">On the way · ${total} stops</span>
      ${payout ? `<span class="tt-payout">₹${(payout/100).toFixed(0)}</span>` : ''}
    </div>
    <div class="tt-progress"><div class="tt-bar" style="width:${total ? Math.round(pickedUp/total*100) : 0}%"></div></div>
    <div class="tl">${stops}${custStop}</div>
  </div>`;
}

function activeCard(d) {
  const id = d.id;
  const step = stepIndex(d);
  const rest = d.restaurant_name || 'Restaurant';
  const cust = d.customer_name || 'Customer';
  const cphone = d.customer_phone || '';
  const rphone = d.restaurant_phone || '';
  const addr = [d.addr_label, d.line1, d.line2, d.city].filter(Boolean).join(', ');
  const restAddr = d.rest_address || '';
  const earn = d.trip_payout_paise != null ? Number(d.trip_payout_paise) : (d.payout_paise != null ? Number(d.payout_paise) : null);

  // 4-step progress: Reached → Picked up → On the way → Delivered
  const steps = ['Reached', 'Picked up', 'On the way', 'Delivered'];
  const progressHtml = steps.map((s, i) => {
    const cls = i < step ? 'done' : (i === step ? 'current' : 'upcoming');
    const dot = i < step ? '✓' : (i === step ? '●' : '○');
    return `<div class="ap-step ${cls}"><span class="ap-dot">${dot}</span><span class="ap-label">${s}</span></div>${i < 3 ? '<div class="ap-line"></div>' : ''}`;
  }).join('');

  const missionHeads = [
    { t: 'Head to ' + rest, s: 'Go to the restaurant and mark when you arrive.' },
    { t: 'Pick up the order', s: 'Collect the food from ' + rest + '.' },
    { t: 'Head to ' + cust, s: 'Deliver the order to the customer.' },
    { t: 'Complete the delivery', s: 'Ask for the OTP and finish the trip.' },
  ];
  const mh = missionHeads[step] || missionHeads[0];

  let action = '';
  if (step === 0) {
    action = `<button class="btn accept ap-nav" data-reached="${esc(id)}">Navigate to Restaurant</button>`;
  } else if (step === 1) {
    const photo = state.pickupPhotos[id];
    action = `
      <div class="field"><label for="pickup-otp-${esc(id)}">Pickup OTP (ask the restaurant)</label>
      <input class="input otp" id="pickup-otp-${esc(id)}" inputmode="numeric" maxlength="4" placeholder="••••" autocomplete="off"></div>
      <label class="photopick-label" for="photo-${esc(id)}">${I.camera} ${photo ? 'Retake pickup photo (required)' : 'Take pickup photo (required)'}</label>
      <input type="file" class="photopick" id="photo-${esc(id)}" accept="image/*" capture="camera" data-photo="${esc(id)}">
      ${photo ? `<img class="photo-preview" src="${photo}" alt="Pickup photo preview">` : ''}
      <button class="btn accept ap-nav" data-picked="${esc(id)}">${I.check} Picked up — head to customer</button>`;
  } else if (step === 2) {
    action = `<button class="btn accept ap-nav" data-arrived-cust="${esc(id)}">Navigate to Customer</button>`;
  } else {
    const isCod = String(d.payment_method || '').toLowerCase() === 'cod' && String(d.payment_status || '') === 'pending';
    action = `
      ${isCod ? `
      <div class="cod-hero">
        <div class="ch-label">💵 Collect cash from customer</div>
        <div class="ch-value">${fmtRs(d.total_paise)}</div>
        <div class="ch-sub">Count it, then tick the box below.</div>
      </div>
      <div class="codbox">
        <label class="cashcheck"><input type="checkbox" id="cash-${esc(id)}"> I have collected the cash</label>
      </div>` : ''}
      <div class="field"><label for="otp-${esc(id)}">Delivery OTP (ask the customer)</label>
      <input class="input otp" id="otp-${esc(id)}" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off"></div>
      <button class="btn accept ap-nav" data-done="${esc(id)}">${I.check} Delivered</button>`;
  }

  return `
  <div class="dcard active-premium">
    <div class="ap-top">
      <div class="ap-status"><span class="ap-pulse"></span><span class="ap-active">ACTIVE</span><span class="ap-order">#${esc(String(id).slice(-4))}</span></div>
      ${earn != null ? `<div class="ap-payout">${fmtRs(earn)}</div>` : ''}
    </div>
    <div class="ap-rest">${esc(rest)}</div>
    <div class="ap-mission">${esc(mh.t)}</div>
    <div class="ap-progress">${progressHtml}</div>
    <div class="ap-route">
      <div class="ap-stop">
        <span class="rt-dot pick"></span>
        <div class="rt-tx"><div class="rt-k">Pickup</div><div class="rt-v">${esc(rest)}</div>${restAddr ? `<div class="rt-a">${esc(restAddr)}</div>` : ''}</div>
      </div>
      <div class="ap-stop">
        <span class="rt-dot drop"></span>
        <div class="rt-tx"><div class="rt-k">Drop</div><div class="rt-v">${esc(cust)}</div>${addr ? `<div class="rt-a">${esc(addr)}</div>` : ''}</div>
      </div>
    </div>
    <div class="callrow">
      ${cphone ? `<a class="callbtn" href="tel:${esc(String(cphone).replace(/\D/g, ''))}">${I.phone} Call customer</a>` : ''}
      ${rphone ? `<a class="callbtn" href="tel:${esc(String(rphone).replace(/\D/g, ''))}">${I.phone} Call restaurant</a>` : ''}
    </div>
    <div class="quickrow" data-oid="${esc(d.id)}">
      <button class="qreply" data-msg="I'm outside">I'm outside</button>
      <button class="qreply" data-msg="On my way">On my way</button>
      <button class="qreply" data-msg="5 mins away">5 mins away</button>
    </div>
    <div class="step-action">${action}</div>
  </div>`;
}

function activeListHash() {
  return (state.active || []).map(d => [
    d.id, d.status, d.restaurant_name, d.customer_name, d.customer_phone,
    d.restaurant_phone, d.addr_label, d.line1, d.line2, d.city,
    d.payout_paise, d.payment_method,
    JSON.stringify((d.items || []).map(it => [it.qty, it.name_snapshot])),
    JSON.stringify(d.timeline || [])
  ].join(':')).join('|');
}

function paintActiveList() {
  const list = $('#active-list');
  if (!list) return;
  const key = activeListHash();
  if (list.dataset.k === key) return;
  list.dataset.k = key;
  if (!state.active.length) {
    list.innerHTML = `<div class="empty">${I.truck}<p><b>No active deliveries.</b></p><p>Accepted orders will show up here with step-by-step actions.</p><a class="btn ghost sm" href="#/orders" style="text-decoration:none">Find deliveries</a></div>`;
    return;
  }
  // Group trips: summary card per trip + individual actionable cards
  const { trips, singles } = groupByTrip(state.active);
  const tripHtml = trips.map(tripCard).join('');
  // For trip orders, show individual cards too (for actions), but mark them as part of trip
  const tripOrderIds = new Set();
  trips.forEach(t => t.forEach(o => tripOrderIds.add(o.id)));
  const tripOrdersHtml = state.active.filter(d => tripOrderIds.has(d.id)).map(activeCard).join('');
  const singleHtml = singles.map(activeCard).join('');
  list.innerHTML = tripHtml + tripOrdersHtml + singleHtml;

  $$('#active-list [data-reached]').forEach(btn => {
    btn.onclick = () => stepAction(btn.getAttribute('data-reached'), 'arrived-restaurant', undefined, btn, 'Marking reached…');
  });
  $$('#active-list .qreply').forEach(btn => {
    btn.onclick = async () => {
      const oid = btn.closest('.quickrow').dataset.oid;
      const msg = btn.dataset.msg;
      btn.disabled = true;
      try {
        await api('/api/rider/quick-msg', { method: 'POST', body: { order_id: oid, msg } });
        toast('✓ Sent: "' + msg + '"');
      } catch (e) { toast('Failed to send', 'err'); }
      btn.disabled = false;
    };
  });
  $$('#active-list [data-picked]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-picked');
      // Pickup photo is required: block confirm until one is attached.
      if (!state.pickupPhotos[id]) {
        toast('Please take a pickup photo first — it is required.', 'err');
        const inp = $('#photo-' + CSS.escape(id));
        if (inp) inp.focus();
        return;
      }
      const otpInput = document.getElementById('pickup-otp-' + id);
      const otp = otpInput ? otpInput.value.trim() : '';
      stepAction(id, 'picked-up', { photo: state.pickupPhotos[id], pickup_otp: otp }, btn, 'Confirming pickup…');
    };
  });
  $$('#active-list [data-arrived-cust]').forEach(btn => {
    btn.onclick = () => stepAction(btn.getAttribute('data-arrived-cust'), 'arrived-customer', undefined, btn, 'Marking reached…');
  });
  $$('#active-list [id^="cash-"]').forEach(chk => {
    // Satisfying confirm: the cash ticket glows green once the rider ticks it.
    chk.onchange = () => {
      const box = chk.closest('.codbox');
      if (box) box.classList.toggle('collected', chk.checked);
    };
  });
  $$('#active-list [data-done]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-done');
      const otp = ($('#otp-' + CSS.escape(id)) || {}).value || '';
      if (!String(otp).trim()) { toast('Enter the delivery OTP from the customer.', 'err'); return; }
      const d = (state.active || []).find(x => String(x.id) === String(id)) || {};
      const isCod = String(d.payment_method || '').toLowerCase() === 'cod' && String(d.payment_status || '') === 'pending';
      const body = { otp: String(otp).trim() };
      if (state.deliveryPhotos[id]) body.delivery_photo = state.deliveryPhotos[id];
      if (isCod) {
        const chk = $('#cash-' + CSS.escape(id));
        if (!chk || !chk.checked) {
          toast('Please confirm you collected ' + fmtRs(d.total_paise) + ' in cash.', 'err');
          return;
        }
        body.cash_confirmed = true;
        body.cash_amount_paise = Number(d.total_paise || 0);
      }
      stepAction(id, 'complete', body, btn, 'Completing…');
    };
  });
  $$('#active-list [data-delphoto]').forEach(inp => {
    inp.onchange = () => {
      clearCapturePending(); // a photo was actually chosen — the tab survived
      const did = inp.getAttribute('data-delphoto');
      resizePhoto(inp.files && inp.files[0], 900, 0.72, (url) => {
        state.deliveryPhotos[did] = url;
        persistPhoto('delphoto', did, url);
        // Show the preview in place — no full list re-render, so the typed OTP survives.
        const prev = $('#delphoto-prev-' + CSS.escape(did));
        if (prev) prev.innerHTML = `<img class="photo-preview" src="${esc(url)}" alt="Delivery photo preview">`;
        toast('Delivery photo attached', 'ok');
      });
    };
  });
  $$('#active-list [data-photo]').forEach(inp => {
    inp.onchange = () => handlePhoto(inp.getAttribute('data-photo'), inp.files && inp.files[0]);
  });
}

async function stepAction(id, step, body, btn, busyText) {
  btn.disabled = true;
  const old = btn.innerHTML;
  btn.innerHTML = esc(busyText || 'Working…');
  const cfg = STEPS[step] || { method: 'POST', suffix: '/' + step };
  try {
    const data = await api('/api/rider/deliveries/' + encodeURIComponent(id) + cfg.suffix, { method: cfg.method, body });
    const msgs = {
      'arrived-restaurant': 'Marked reached. Pick up the order!',
      'picked-up': 'Picked up. Head to the customer!',
      'arrived-customer': 'Reached customer. Ask for the delivery OTP!',
      'complete': 'Delivered! Payout added to your earnings.',
    };
    let msg = msgs[step] || 'Done';
    if (step === 'complete' && data && data.payout_paise != null) {
      msg = 'Delivered! You earned ' + fmtRs(data.payout_paise) + '.';
    }
    toast(msg, 'ok');
    delete state.pickupPhotos[id];
    delete state.deliveryPhotos[id];
    clearPersistedPhoto('pickup', id);
    clearPersistedPhoto('delphoto', id);
    await loadActive();
    paintActiveList();
    updateBadges();
    // Auto-navigate to next stop after pickup/arrived (user: never tap manually)
    if (step === 'picked-up' || step === 'arrived-restaurant') {
      const curHash = location.hash || '';
      if (curHash.indexOf('#/maps') === 0) {
        // Already on Maps: refresh navigation to next stop
        try { startNavigation(); } catch (e) {}
      } else {
        // Go to Maps and navigate
        location.hash = '#/maps';
        setTimeout(() => { try { startNavigation(); } catch (e) {} }, 1500);
      }
    }
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

function handlePhoto(id, file) {
  if (!file) return;
  clearCapturePending(); // a photo was actually chosen — the tab survived
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      // downscale so the upload stays small
      const max = 1024;
      let w = img.width, h = img.height;
      if (Math.max(w, h) > max) {
        const k = max / Math.max(w, h);
        w = Math.round(w * k); h = Math.round(h * k);
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      const url = c.toDataURL('image/jpeg', 0.7);
      state.pickupPhotos[id] = url;
      persistPhoto('pickup', id, url);
      // Update the preview in place — no full list re-render, so a delivery
      // OTP typed into any card survives attaching the photo.
      try {
        const selId = CSS.escape(id);
        const input = document.querySelector('#active-list #photo-' + selId);
        const action = input ? input.closest('.step-action') : null;
        if (action) {
          const label = action.querySelector('label.photopick-label');
          if (label) label.innerHTML = I.camera + ' Retake pickup photo (required)';
          let prev = action.querySelector('.photo-preview');
          if (!prev) {
            prev = document.createElement('img');
            prev.className = 'photo-preview';
            prev.alt = 'Pickup photo preview';
            input.after(prev);
          }
          prev.src = url;
        } else {
          paintActiveList(); /* card not on screen — fallback to rebuild */
        }
      } catch (e) { paintActiveList(); }
      toast('Photo attached', 'ok');
    };
    img.onerror = () => toast('Could not read that photo.', 'err');
    img.src = reader.result;
  };
  reader.onerror = () => toast('Could not read that photo.', 'err');
  reader.readAsDataURL(file);
}

/* Badges must be idempotent: polls run every few seconds, so the DOM is
   only touched when the count actually changes — otherwise the tab bar
   visibly flickers on every poll. */
function updateBadges() {
  const tabs = $$('.bottomtabs .tab');
  tabs.forEach(tab => {
    const tic = tab.querySelector('.tic');
    if (!tic) return;
    const which = tab.getAttribute('data-count');
    const n = which === 'orders' ? state.available.length + activeCount() : which === 'available' ? state.available.length : which === 'active' ? activeCount() : 0;
    const old = tic.querySelector('.badge');
    if (n > 0) {
      if (old) { if (old.textContent !== String(n)) old.textContent = n; }
      else {
        const b = document.createElement('span');
        b.className = 'badge';
        b.textContent = n;
        tic.appendChild(b);
      }
    } else if (old) {
      old.remove();
    }
  });
}

function renderActive() {
  clearTimers();
  setPage(eyebrow('In progress') + `
    <h1>Active deliveries</h1>
    <p class="sub">Follow the steps for each order.</p>
    <div id="active-err"></div>
    <div id="active-list">${state.active.length ? '' : skel(210) + skel(210)}</div>
  `, 'active');
  paintActiveList(); // cached deliveries paint instantly — no skeleton flash on revisit
  const load = async () => {
    try {
      await loadActive();
      paintActiveList();
      updateBadges();
    } catch (e) {
      const box = $('#active-err');
      if (box) box.innerHTML = '<div class="errbox">' + esc(e.message) + '</div>';
      const list = $('#active-list');
      if (list && !state.active.length) list.innerHTML = `<div class="empty">${I.truck}<p>Could not load deliveries.</p></div>`;
    }
  };
  load();
  every(60000, () => { if (state.online) sendLocation(false); });
}

/* ================= MAPS TAB (ported 20261017r01) =================
   Full Google Maps with optimized route drawing.
   [GUARD] Every map operation is null-guarded — the tab never crashes,
   even with no active deliveries, no GPS, or no API key. */
function renderMaps() {
  clearTimers();
  setPage(`
    <div class="rmaps" id="maps-wrap">
      <div class="rmaps-turn" id="nav-header" style="display:none">
        <span id="nav-turn-icon" class="rmaps-turn-icon">⬆️</span>
        <div class="rmaps-turn-text">
          <div id="nav-dist" class="rmaps-turn-dist"></div>
          <div id="nav-instr" class="rmaps-turn-instr"></div>
        </div>
        <div class="rmaps-turn-eta">
          <div id="nav-eta-text" class="rmaps-eta-t"></div>
          <div id="nav-eta-sub" class="rmaps-eta-s"></div>
        </div>
      </div>
      <div class="rmaps-mapwrap">
        <div id="maps-map" class="rmaps-map"></div>
        <div class="rmaps-stops" id="rmaps-stops"></div>
        <div class="rmaps-edge">
          <button class="rmaps-ebtn" id="maps-voice" title="Voice navigation on/off">🔊</button>
          <button class="rmaps-ebtn" id="maps-recenter" title="Center on my location">◎</button>
          <button class="rmaps-ebtn primary" id="maps-nav" title="Start navigation">▶</button>
          <button class="rmaps-ebtn" id="maps-stopnav" title="Stop navigation" style="display:none">⏹</button>
        </div>
        <div id="maps-status" class="maps-status"></div>
      </div>
      <div class="rmaps-order" id="rmaps-order"></div>
    </div>
  `, 'maps');
  const mpage = $('#app .page');
  if (mpage) mpage.classList.add('flush');
  // Wire controls (guarded — elements may not exist)
  const rc = document.getElementById('maps-recenter');
  if (rc) rc.onclick = () => {
    const cp = state.currentPos;
    if (map && cp && cp.lat != null) {
      try { map.panTo({ lat: +cp.lat, lng: +cp.lng }); map.setZoom(15); } catch (e) {}
    } else toast('Waiting for GPS…', 'err');
  };
  const vv = document.getElementById('maps-voice');
  if (vv) {
    vv.textContent = window._voiceNav === false ? '🔇' : '🔊';
    vv.onclick = () => {
      window._voiceNav = !(window._voiceNav !== false);
      vv.textContent = window._voiceNav ? '🔊' : '🔇';
      if (!window._voiceNav) try { window.speechSynthesis.cancel(); } catch (e) {}
      toast(window._voiceNav ? 'Voice navigation on' : 'Voice navigation off');
    };
  }
  const nv = document.getElementById('maps-nav');
  if (nv) nv.onclick = () => {
    startNavigation();
    const sn = document.getElementById('maps-stopnav');
    if (sn) sn.style.display = '';
    nv.style.display = 'none';
  };
  const sn = document.getElementById('maps-stopnav');
  if (sn) sn.onclick = () => {
    exitNavigation();
    sn.style.display = 'none';
    if (nv) nv.style.display = '';
  };
  // Reset stale map (attached to destroyed DOM from previous visit)
  if (map) {
    try {
      const mapEl = map.getDiv();
      if (!mapEl || !document.contains(mapEl)) {
        map = null;
        riderMarker = null;
      }
    } catch (e) {
      map = null;
      riderMarker = null;
    }
  }
  // Lazy-load Google Maps on first visit
  initMap();
  // If map already loaded (revisit), repaint
  if (map && window.google) {
    try {
      google.maps.event.trigger(map, 'resize');
      renderMapStops();
      drawOptimizedRouteLine();
    } catch (e) {}
  }
  // Populate right-side stops panel + bottom order card
  const updateMapsPanels = () => {
    try {
      const stops = getOrderedStops();
      const next = getNextStop();
      const curIdx = next ? stops.findIndex(s => s.orderId === (next.order && next.order.id) && s.type === next.type) : -1;
      // Right-side stops list
      const sp = document.getElementById('rmaps-stops');
      if (sp) {
        if (stops.length > 0) {
          sp.innerHTML = stops.map((s, i) => {
            const done = curIdx >= 0 && i < curIdx;
            const cur = i === curIdx;
            const label = s.type === 'pickup' ? 'Pickup' : 'Drop';
            return `<div class="rmaps-stop ${cur ? 'cur' : ''} ${done ? 'done' : ''}">` +
              `<span class="rmaps-stop-n">${done ? '✓' : (i + 1)}</span>` +
              `<span class="rmaps-stop-l">${label}</span></div>`;
          }).join('');
          sp.style.display = '';
        } else sp.style.display = 'none';
      }
      // Bottom order card: restaurant + customer details
      const oc = document.getElementById('rmaps-order');
      if (oc) {
        if (next && next.order) {
          const o = next.order;
          const rName = o.restaurant_name || o.restaurant || 'Restaurant';
          const rAddr = o.restaurant_address || o.pickup_address || '';
          const cAddr = o.customer_address || o.drop_address || o.address || '';
          const isPickup = next.type === 'pickup';
          oc.innerHTML =
            `<div class="rmaps-ord-row ${isPickup ? 'hl' : ''}">` +
              `<span class="rmaps-ord-ico">📦</span>` +
              `<div><div class="rmaps-ord-lbl">Pickup · ${rName}</div>` +
              (rAddr ? `<div class="rmaps-ord-addr">${rAddr}</div>` : '') + `</div></div>` +
            `<div class="rmaps-ord-row ${!isPickup ? 'hl' : ''}">` +
              `<span class="rmaps-ord-ico">🏠</span>` +
              `<div><div class="rmaps-ord-lbl">Drop-off</div>` +
              (cAddr ? `<div class="rmaps-ord-addr">${cAddr}</div>` : '') + `</div></div>`;
          oc.style.display = '';
        } else oc.style.display = 'none';
      }
      // Show turn bar when navigating
      const th = document.getElementById('nav-header');
      if (th) th.style.display = (window._navActive ? '' : 'none');
    } catch (e) {}
  };
  // Initial update
  setTimeout(updateMapsPanels, 1000);
  every(30000, async () => {
    try {
      await fetchOptimizedRoute();
      renderMapStops();
      drawOptimizedRouteLine();
      updateMapsPanels();
      updateStopCounter();
    } catch (e) {}
  });
  // Keep GPS fresh while on Maps tab
  every(15000, () => { if (state.online && navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        state.currentPos = p;
        if (riderMarker) {
          glideMarkerTo(riderMarker, p, 900);
          riderMarker.setVisible(true);
          paintRiderHeading(riderMarker, pos.coords.heading, pos.coords.speed);
        }
        if (map && !navActive) { try { map.panTo(p); } catch (e) {} }
      },
      () => {}, { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
  }});
}

/* ================= PROFILE ================= */

// Weekly report (user 2026-10-18: best rider app)
function paintWeeklyReport(data) {
  try {
    const payouts = (data && data.payouts) || [];
    if (!payouts.length) return '';
    const total = payouts.reduce((s, p) => s + (p.amount_paise || 0), 0) / 100;
    const trips = payouts.length;
    const avg = trips ? Math.round(total / trips) : 0;
    // Best day
    const byDay = {};
    payouts.forEach(p => {
      const d = (p.paid_at || '').slice(0, 10);
      byDay[d] = (byDay[d] || 0) + (p.amount_paise || 0);
    });
    let bestDay = '', bestAmt = 0;
    Object.entries(byDay).forEach(([d, a]) => { if (a > bestAmt) { bestAmt = a; bestDay = d; } });
    const dayName = bestDay ? new Date(bestDay + 'T12:00').toLocaleDateString('en-IN', { weekday: 'long' }) : '';
    return `<div class="rh-sec-t">📈 This week</div>
      <div class="rh-wr-grid">
        <div class="rh-wr-cell"><b>₹${Math.round(total)}</b><span>earned</span></div>
        <div class="rh-wr-cell"><b>${trips}</b><span>trips</span></div>
        <div class="rh-wr-cell"><b>₹${avg}</b><span>avg/trip</span></div>
        <div class="rh-wr-cell"><b>${dayName || '—'}</b><span>best day</span></div>
      </div>`;
  } catch (e) { return ''; }
}

function renderProfile() {
  clearTimers();
  const r = state.rider || {};
  setPage(`
    <div class="prof-top">
      <div class="avatar-wrap" id="avatar-wrap">
        ${r.profile_photo ? `<img id="rider-avatar" src="${esc(simg(r.profile_photo, 160))}" alt="Your photo">` : `<div class="avatar-ph" id="rider-avatar">${I.user}</div>`}
        <button class="avatar-cam" id="btn-avatar" title="Upload your photo" aria-label="Upload profile photo">${I.camera}</button>
        <input type="file" id="avatar-file" class="photopick" accept="image/*" capture="camera">
      </div>
      <div class="grow">
        <div class="profname">${esc(r.name || 'Rider')}</div>
        <div class="muted small">+91 ${esc(r.phone || '')}</div>
        <div class="prof-rating">${r.rating_avg != null ? '★ ' + Number(r.rating_avg).toFixed(1) : '★ New rider'}</div>
      </div>
      <button class="btn ghost sm" id="btn-edit">Edit</button>
    </div>
    <div class="stat-strip" id="stat-strip"${state.earnData ? '' : ' style="display:none"'}>${state.earnData ? paintStatStrip(state.earnData) : ''}</div>

    <div id="earn-body">${state.earnData ? paintWealth(state.earnData) : (skel(120) + skel(64) + skel(64))}</div>
    <div class="rh-extra" id="weekly-report"></div>

    <div id="cod-card">${state.codData ? paintCodBalance(state.codData) : '<div class="muted small">Loading cash balance…</div>'}</div>

    <div id="quest-nudge"></div>
    <div id="quest-wrap"></div>
  `, 'profile');

  $('#btn-edit').onclick = openProfileModal;
  $('#btn-avatar').onclick = () => $('#avatar-file').click();
  $('#avatar-file').onchange = uploadAvatarPhoto;
  // Cached-first: earnings & COD paint instantly from the last fetch; the
  // refreshers below only touch the DOM when the data actually changed.
  if (state.earnData) {
    state.earnKey = earnKey(state.earnData);
    const eb = $('#earn-body');
    if (eb) bindDayRows(eb);
  }
  if (state.codData) state.codKey = codKey(state.codData);
  loadQuestNudge();
  loadQuests();
  every(60000, loadQuests);
  refreshCodBalance();
  refreshEarnings();

  every(60000, () => { if (state.online) sendLocation(false); });
}

function earnKey(d) { return JSON.stringify((d && d.payouts) || []); }
function codKey(b) { return [b.cash_in_hand_paise, b.pending_earnings_paise, b.owes_company_paise].join('|'); }

function paintCodBalance(b) {
  const cash = Number(b.cash_in_hand_paise || 0);
  const earn = Number(b.pending_earnings_paise || 0);
  const owes = Number(b.owes_company_paise || 0);
  return eyebrow('Cash & settlement') + `
    <div class="sumgrid">
      <div class="sumbox"><div class="v">${fmtRs(cash)}</div><div class="l">Cash in hand</div></div>
      <div class="sumbox"><div class="v">${fmtRs(earn)}</div><div class="l">Pending earnings</div></div>
    </div>
    ${owes > 0
      ? `<div class="errbox" style="margin:0">You owe Floop <b>${fmtRs(owes)}</b> — please settle with the team.</div>`
      : `<div class="okbox" style="margin:0">All settled up — nothing owed.</div>`}`;
}

function paintStatStrip(data) {
  const list = Array.isArray(data.payouts) ? data.payouts : [];
  let km = 0, tot = 0;
  list.forEach(p => { km += Number(p.distance_km || 0); tot += Number(p.amount_paise || 0); });
  const avg = list.length ? Math.round(tot / list.length) : 0;
  return `<div class="stat"><b>${list.length}</b><span>trips · 30d</span></div>` +
    `<div class="stat"><b>${km.toFixed(0)}</b><span>km ridden</span></div>` +
    `<div class="stat"><b>${fmtRs(avg)}</b><span>avg / trip</span></div>`;
}

function bindDayRows(body) {
  body.querySelectorAll('.dayrow').forEach(r => r.addEventListener('click', () => {
    const open = r.getAttribute('aria-expanded') === 'true';
    r.setAttribute('aria-expanded', String(!open));
    const det = document.getElementById('dd-' + r.dataset.day);
    if (det) det.hidden = open;
  }));
}

// COD cash balance: cash in hand vs pending earnings vs amount owed.
async function refreshCodBalance() {
  try {
    const b = await api('/api/rider/cod-balance');
    state.codData = b;
    const key = codKey(b);
    if (state.codKey === key) return; // already showing this — no rebuild, no flash
    state.codKey = key;
    const el = $('#cod-card');
    if (el) el.innerHTML = paintCodBalance(b);
  } catch (e) {
    const el = $('#cod-card');
    if (el && !state.codData) el.innerHTML = '';
  }
}

// One request for the last 30 days; bucket client-side for chart + totals.
async function refreshEarnings() {
  const body0 = $('#earn-body');
  try {
    const from = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
    const to = todayISO();
    const data = await api('/api/rider/earnings?from=' + from + '&to=' + to);
    state.earnData = data;
    const key = earnKey(data);
    // Unhide strip BEFORE the early-return — otherwise a render-time display:none sticks forever
    const strip0 = $('#stat-strip');
    if (strip0 && !strip0.innerHTML.trim()) { strip0.style.display = ''; strip0.innerHTML = paintStatStrip(data); }
    else if (strip0) strip0.style.display = '';
    if (state.earnKey === key) return; // already showing this — no rebuild, no flash
    state.earnKey = key;
    const body = $('#earn-body');
    if (body) { body.innerHTML = paintWealth(data); bindDayRows(body); }
    // stat strip: trips · km · avg per trip, all from the same real payouts
    const strip = $('#stat-strip');
    if (strip) { strip.innerHTML = paintStatStrip(data); }
    const wr = $('#weekly-report');
    if (wr) wr.innerHTML = paintWeeklyReport(data);
  } catch (e) {
    if (body0 && !state.earnData) body0.innerHTML = '<div class="errbox">' + esc(e.message) + '</div>';
  }
}

function paintWealth(data) {
  data = data || {};
  const list = Array.isArray(data.payouts) ? data.payouts : [];
  const todayStr = todayISO();
  // bucket last 7 days
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    days.push({ iso: d.toISOString().slice(0, 10), label: i === 0 ? 'Today' : d.toLocaleDateString('en-IN', { weekday: 'short' }), total: 0, trips: 0 });
  }
  const byIso = {};
  days.forEach(d => { byIso[d.iso] = d; });
  let weekTotal = 0, monthTotal = 0, todayTotal = 0, todayTrips = 0;
  const monthStr = todayStr.slice(0, 7);
  const dayTrips = {};
  days.forEach(d => { dayTrips[d.iso] = []; });
  list.forEach(p => {
    const iso = String(p.created_at || '').slice(0, 10);
    const amt = Number(p.amount_paise || 0);
    if (byIso[iso]) { byIso[iso].total += amt; byIso[iso].trips++; weekTotal += amt; dayTrips[iso].push(p); }
    if (iso.slice(0, 7) === monthStr) monthTotal += amt;
    if (iso === todayStr) { todayTotal += amt; todayTrips++; }
  });
  const max = Math.max.apply(null, days.map(d => d.total).concat([1]));
  const bars = days.map(d => {
    const h = Math.max(4, Math.round(d.total / max * 100));
    return `<div class="bar-col"><div class="bar-val">${d.total ? fmtRs(d.total) : ''}</div>` +
      `<div class="bar${d.iso === todayStr ? ' today' : ''}" style="height:${h}%"></div>` +
      `<div class="bar-lbl">${d.label}</div></div>`;
  }).join('');

  let html = `
    <div class="earn-hero">
      <div class="eh-eyebrow">Earned today</div>
      <div class="eh-value">${fmtRs(todayTotal)}</div>
      <div class="eh-sub">${todayTrips} ${todayTrips === 1 ? 'delivery' : 'deliveries'} today · keep going!</div>
    </div>
    <div class="totals3">
      <div class="total-box"><div class="v">${fmtRs(todayTotal)}</div><div class="l">Today</div></div>
      <div class="total-box"><div class="v">${fmtRs(weekTotal)}</div><div class="l">This week</div></div>
      <div class="total-box"><div class="v">${fmtRs(monthTotal)}</div><div class="l">This month</div></div>
    </div>
    <div class="earn-chart-card">
      <h2>Last 7 days</h2>
      <div class="bars">${bars}</div>
    </div>`;
  // Dasher-style per-day rows — each expands to that day's payouts.
  const dayRows = days.slice().reverse().map(d => {
    const trips = dayTrips[d.iso] || [];
    const dt = new Date(d.iso + 'T12:00:00');
    const label = d.iso === todayStr ? 'Today' : dt.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' });
    const detail = trips.length ? trips.map(p => {
      const olabel = p.order_id ? ('Order #' + String(p.order_id).slice(0, 8)) : 'Bonus payout';
      const when = p.created_at ? fmtDate(p.created_at) : '';
      return `<div class="payout-row">
        <div><div style="font-weight:700">${esc(olabel)}</div>
        <div class="p-when">${esc(when)}${p.distance_km != null ? ' · ' + Number(p.distance_km).toFixed(1) + ' km' : ''}</div></div>
        <div class="p-amt">+${fmtRs(p.amount_paise)}</div>
      </div>`;
    }).join('') : '<div class="muted small" style="padding:8px 2px">No deliveries this day.</div>';
    return `<button class="dayrow" data-day="${d.iso}" aria-expanded="false">
      <span class="dr-l">${esc(label)}</span>
      <span class="dr-r"><span class="dr-t">${d.trips} ${d.trips === 1 ? 'trip' : 'trips'}</span>${fmtRs(d.total)}<span class="dr-chev">›</span></span>
    </button>
    <div class="daydetail" id="dd-${d.iso}" hidden>${detail}</div>`;
  }).join('');
  html += eyebrow('Day by day') + '<div class="dayrows">' + dayRows + '</div>';
  // Day-by-day rows above already break down every payout — a separate
  // "Recent payouts" list would just repeat the same data.
  if (!list.length) {
    html += `<div class="empty">${I.wallet}<p><b>No earnings yet.</b></p><p>Your first payout is one delivery away — go online and grab an order.</p><a class="btn sm" href="#/orders" style="text-decoration:none">Find deliveries</a></div>`;
  }
  return html;
}
function weekStartISO() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}


/* ---------------- go ---------------- */
document.addEventListener('DOMContentLoaded', boot);

/* ============================================================
   WORLD-CLASS RIDER UPGRADE — helpers
   ============================================================ */

/* scrEnter removed — a full-page fade on every tab tap read as the app
   reloading. Tabs now swap instantly; the header is never rebuilt. */

/* ---------- home: quest nudge ---------- */
async function loadQuestNudge() {
  const el = $('#quest-nudge');
  if (!el) return;
  try {
    const data = await api('/api/rider/quests');
    const qs = (data.quests || []).filter(q => !q.bonus_earned && Number(q.target_deliveries || 0) > 0);
    if (!qs.length) { el.innerHTML = ''; return; }
    // nearest to completion first
    qs.sort((a, b) => (Number(b.completed || 0) / Number(b.target_deliveries || 1)) - (Number(a.completed || 0) / Number(a.target_deliveries || 1)));
    const q = qs[0];
    const target = Number(q.target_deliveries);
    const done = Math.min(Number(q.completed || 0), target);
    const left = target - done;
    const pct = Math.round((done / target) * 100);
    el.innerHTML = `
      <div class="quest-nudge">
        <div class="qn-ico">🏆</div>
        <div class="qn-main">
          <div class="qn-title">${left === 0 ? 'Bonus unlocked!' : `${left} more ${left === 1 ? 'delivery' : 'deliveries'} = ${fmtRs(q.bonus_paise)} bonus`}</div>
          <div class="qn-sub">${esc(q.name || 'Quest')} · ${done}/${target}</div>
          <div class="qbar"><div class="qfill" style="width:${pct}%"></div></div>
        </div>
      </div>`;
  } catch (e) { el.innerHTML = ''; }
}

/* ---------- home: demand banner ---------- */

/* ---------- available: capacity bar ---------- */
function paintCapacityBar() {
  const el = $('#cap-bar');
  if (!el) return;
  const used = activeCount();
  /* Guard: this runs on every 2.5s poll via paintAvailableList — skip the
     innerHTML rebuild when the slot count hasn't changed. */
  if (el.dataset.used === String(used)) return;
  el.dataset.used = String(used);
  const max = 3;
  let slots = '';
  for (let i = 0; i < max; i++) slots += `<span class="slot${i < used ? ' used' : ''}"></span>`;
  el.innerHTML = `
    <div class="capbar">
      <div class="slots">${slots}</div>
      <div><b>${used} of ${max}</b> delivery slots used${used >= max ? ' — finish one to take more' : ''}</div>
    </div>`;
}

/* ---------- active: mission step rail ---------- */
function stepRail(step) {
  const labels = ['Reached\nrestaurant', 'Picked up', 'Reached\ncustomer', 'Delivered'];
  const icons = ['🏪', '📦', '🛵', '🏁'];
  return `<div class="steprail">` + labels.map((lb, i) => {
    const cls = i < step ? 'done' : (i === step ? 'now' : '');
    const dot = i < step ? '✓' : icons[i];
    return `<div class="rstep ${cls}"><span class="rsdot">${dot}</span><span class="rslbl">${lb.replace('\n', '<br>')}</span></div>`;
  }).join('') + `</div>`;
}

/* ================= RIDER REGISTRATION (Swiggy/Zomato-style, 2026-10-15) ================= */
/* 4-step full onboarding: Personal -> Identity -> Vehicle -> Bank. New riders land here
   after OTP when verify-otp returns is_new_rider=true. Each step saves to backend. */

const REG_STEPS = ['Personal', 'Identity', 'Vehicle', 'Bank'];

function regPhotoField(id, label, required) {
  return `<div class="field"><label>${label}${required ? ' *' : ''}</label>
    <div class="reg-photo" id="ph-${id}">
      <input type="file" id="file-${id}" accept="image/*" capture="environment" style="display:none">
      <button type="button" class="btn ghost sm" id="btn-${id}">Take photo / Upload</button>
      <div class="reg-preview" id="prev-${id}" style="display:none">
        <img id="img-${id}" alt="${label} preview">
        <button type="button" class="btn ghost sm" id="re-${id}">Retake</button>
      </div>
    </div></div>`;
}

function wirePhotoField(id) {
  const file = $('#file-' + id), btn = $('#btn-' + id), prev = $('#prev-' + id),
        img = $('#img-' + id), re = $('#re-' + id);
  btn.onclick = () => file.click();
  re.onclick = () => { file.value = ''; prev.style.display = 'none'; btn.style.display = ''; file.dataset.data = ''; };
  file.onchange = () => {
    const f = file.files[0];
    if (!f) return;
    // Downscale to max 1024px, JPEG 0.8 — keeps uploads well under the 1.5MB limit
    const reader = new FileReader();
    reader.onload = (e) => {
      const im = new Image();
      im.onload = () => {
        const maxDim = 1024;
        let w = im.width, h = im.height;
        if (w > maxDim || h > maxDim) {
          const r = Math.min(maxDim / w, maxDim / h);
          w = Math.round(w * r); h = Math.round(h * r);
        }
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(im, 0, 0, w, h);
        const dataUrl = c.toDataURL('image/jpeg', 0.8);
        file.dataset.data = dataUrl;
        img.src = dataUrl;
        prev.style.display = 'flex';
        btn.style.display = 'none';
      };
      im.src = e.target.result;
    };
    reader.readAsDataURL(f);
  };
}

function regGetPhoto(id) {
  const f = $('#file-' + id);
  return (f && f.dataset.data) || null;
}

// Upload a base64 data URL to Cloudinary, return the hosted URL.
// Rider document photos must never land in Postgres as blobs.
async function regUploadPhoto(dataUrl) {
  if (!dataUrl) return null;
  if (dataUrl.startsWith('http')) return dataUrl; // already uploaded
  const d = await api('/api/upload/image', {
    method: 'POST', body: { image: dataUrl, folder: 'rider-docs' }
  });
  if (!d || !d.url) throw new Error('Photo upload failed. Try again.');
  return d.url;
}

function renderRegistration() {
  clearTimers();
  let step = 1;
  try { step = Math.max(1, Math.min(4, parseInt(localStorage.getItem('reg_step') || '1', 10))); } catch (e) {}

  function paint() {
    const pct = Math.round((step / 4) * 100);
    $('#app').innerHTML = `
    <div class="authwrap regwrap">
      ${eyebrow('Rider registration', true)}
      <h1>Register Now</h1>
      <p class="tag">Become a Floop delivery partner</p>
      <div class="reg-progress">
        <div class="reg-bar"><div class="reg-fill" style="width:${pct}%"></div></div>
        <div class="reg-steps">${REG_STEPS.map((s, i) =>
          `<span class="${i + 1 === step ? 'on' : ''} ${i + 1 < step ? 'done' : ''}">${i + 1}. ${s}</span>`
        ).join('')}</div>
      </div>
      <div id="reg-err"></div>
      <div id="reg-body"></div>
      <div class="reg-nav">
        ${step > 1 ? '<button class="btn ghost" id="reg-back">Back</button>' : ''}
        <button class="btn" id="reg-next">${step === 4 ? 'Submit for approval' : 'Save & Continue'}</button>
      </div>
      <button class="btn ghost sm" id="reg-later" style="margin-top:12px">Save & do this later</button>
    </div>`;
    paintStep();
    const back = $('#reg-back');
    if (back) back.onclick = () => { step--; saveLocal(); paint(); };
    $('#reg-next').onclick = () => submitStep();
    $('#reg-later').onclick = async () => {
      await saveStep(false);
      toast('Progress saved. Come back anytime to finish.', 'ok');
      location.hash = '#/approval'; route();
    };
  }

  function saveLocal() {
    try { localStorage.setItem('reg_step', String(step)); } catch (e) {}
  }

  function paintStep() {
    const b = $('#reg-body');
    if (step === 1) {
      b.innerHTML = `
        <div class="field"><label for="rg-name">Full name *</label>
          <input class="input" id="rg-name" placeholder="As on Aadhaar" autocomplete="name"></div>
        <div class="field"><label for="rg-dob">Date of birth *</label>
          <input class="input" id="rg-dob" type="date" max="${new Date().toISOString().slice(0, 10)}"></div>
        <div class="field"><label for="rg-gender">Gender *</label>
          <select class="input" id="rg-gender">
            <option value="">Select</option><option>Male</option><option>Female</option><option>Other</option>
          </select></div>
        <div class="field"><label for="rg-email">Email</label>
          <input class="input" id="rg-email" type="email" placeholder="you@example.com" autocomplete="email"></div>
        <div class="field"><label for="rg-address">Full address *</label>
          <textarea class="input" id="rg-address" rows="2" placeholder="House no, street, area, Nellore"></textarea></div>`;
    } else if (step === 2) {
      b.innerHTML = `
        <div class="field"><label for="rg-aadhaar">Aadhaar number *</label>
          <input class="input" id="rg-aadhaar" inputmode="numeric" maxlength="14" placeholder="12-digit Aadhaar"
            oninput="this.value=this.value.replace(/[^0-9]/g,'').replace(/(.{4})/g,'$1 ').trim()"></div>
        ${regPhotoField('aadhaar-front', 'Aadhaar front photo', true)}
        ${regPhotoField('aadhaar-back', 'Aadhaar back photo', true)}
        <div class="field"><label for="rg-pan">PAN number *</label>
          <input class="input" id="rg-pan" maxlength="10" placeholder="ABCDE1234F" style="text-transform:uppercase"
            oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9]/g,'')"></div>
        ${regPhotoField('pan-photo', 'PAN card photo', true)}
        ${regPhotoField('profile-photo', 'Your photo (face) *', true)}`;
      wirePhotoField('aadhaar-front'); wirePhotoField('aadhaar-back');
      wirePhotoField('pan-photo'); wirePhotoField('profile-photo');
    } else if (step === 3) {
      b.innerHTML = `
        <div class="field"><label for="rg-vehicle-type">Vehicle type *</label>
          <select class="input" id="rg-vehicle-type">
            <option value="">Select</option>
            <option value="bike">Bike</option>
            <option value="scooter">Scooter</option>
            <option value="electric">Electric 2-wheeler</option>
          </select></div>
        <div class="field"><label for="rg-vehicle-number">Vehicle number *</label>
          <input class="input" id="rg-vehicle-number" placeholder="AP 39 AB 1234" style="text-transform:uppercase"
            oninput="this.value=this.value.toUpperCase()"></div>
        <div class="field"><label for="rg-dl">Driving licence number *</label>
          <input class="input" id="rg-dl" placeholder="Licence number" style="text-transform:uppercase"
            oninput="this.value=this.value.toUpperCase()"></div>
        ${regPhotoField('licence-photo', 'Driving licence photo', true)}
        ${regPhotoField('rc-photo', 'Vehicle RC photo', true)}`;
      wirePhotoField('licence-photo'); wirePhotoField('rc-photo');
    } else {
      b.innerHTML = `
        <div class="field"><label for="rg-bank">Bank account number *</label>
          <input class="input" id="rg-bank" inputmode="numeric" placeholder="Account number"
            oninput="this.value=this.value.replace(/[^0-9]/g,'')"></div>
        <div class="field"><label for="rg-ifsc">IFSC code *</label>
          <input class="input" id="rg-ifsc" maxlength="11" placeholder="SBIN0001234" style="text-transform:uppercase"
            oninput="this.value=this.value.toUpperCase().replace(/[^A-Z0-9]/g,'')"></div>
        <div class="field"><label for="rg-upi">UPI ID</label>
          <input class="input" id="rg-upi" placeholder="name@upi"></div>
        ${regPhotoField('cheque-photo', 'Cancelled cheque / passbook photo', true)}`;
      wirePhotoField('cheque-photo');
    }
  }

  function val(id) { const el = $(id); return el ? el.value.trim() : ''; }
  function err(msg) { $('#reg-err').innerHTML = '<div class="errbox" role="alert">' + esc(msg) + '</div>'; }

  async function saveStep(showToast) {
    const payload = { step };
    if (step === 1) {
      const name = val('#rg-name'), dob = val('#rg-dob'), gender = val('#rg-gender'), address = val('#rg-address');
      if (!name) return err('Please enter your full name.'), false;
      if (!dob) return err('Please enter your date of birth.'), false;
      if (!gender) return err('Please select your gender.'), false;
      if (!address) return err('Please enter your full address.'), false;
      Object.assign(payload, { name, dob, gender, email: val('#rg-email') || null, address });
    } else if (step === 2) {
      const aadhaar = val('#rg-aadhaar').replace(/\s/g, '');
      const pan = val('#rg-pan').replace(/\s/g, '');
      if (!/^\d{12}$/.test(aadhaar)) return err('Aadhaar must be 12 digits.'), false;
      if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return err('PAN must look like ABCDE1234F.'), false;
      const af = regGetPhoto('aadhaar-front'), ab = regGetPhoto('aadhaar-back'),
            pf = regGetPhoto('pan-photo'), pp = regGetPhoto('profile-photo');
      if (!af || !ab || !pf || !pp) return err('Please add all 4 photos for this step.'), false;
      let up;
      try {
        toast('Uploading photos…');
        up = await Promise.all([af, ab, pf, pp].map(regUploadPhoto));
      } catch (e) { return err(e.message || 'Photo upload failed.'), false; }
      Object.assign(payload, { aadhaar_no: aadhaar, aadhaar_front_photo: up[0], aadhaar_back_photo: up[1],
        pan_no: pan, pan_photo: up[2], profile_photo: up[3] });
    } else if (step === 3) {
      const vt = val('#rg-vehicle-type'), vn = val('#rg-vehicle-number'), dl = val('#rg-dl');
      if (!vt) return err('Please select your vehicle type.'), false;
      if (!vn) return err('Please enter your vehicle number.'), false;
      if (!dl) return err('Please enter your driving licence number.'), false;
      const lp = regGetPhoto('licence-photo'), rp = regGetPhoto('rc-photo');
      if (!lp || !rp) return err('Please add licence and RC photos.'), false;
      let up3;
      try {
        toast('Uploading photos…');
        up3 = await Promise.all([lp, rp].map(regUploadPhoto));
      } catch (e) { return err(e.message || 'Photo upload failed.'), false; }
      Object.assign(payload, { vehicle_type: vt, vehicle_number: vn, licence_no: dl,
        licence_photo: up3[0], rc_photo: up3[1] });
    } else {
      const bank = val('#rg-bank'), ifsc = val('#rg-ifsc');
      if (!bank || bank.length < 9) return err('Please enter a valid bank account number.'), false;
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return err('IFSC must look like SBIN0001234.'), false;
      const cp = regGetPhoto('cheque-photo');
      if (!cp) return err('Please add a cancelled cheque or passbook photo.'), false;
      let up4;
      try {
        toast('Uploading photo…');
        up4 = await regUploadPhoto(cp);
      } catch (e) { return err(e.message || 'Photo upload failed.'), false; }
      Object.assign(payload, { bank_account: bank, ifsc, upi_id: val('#rg-upi') || null,
        cancelled_cheque_photo: up4, completed: true });
    }
    try {
      await api('/api/rider/registration', { method: 'PUT', body: payload });
      if (showToast !== false) toast('Step ' + step + ' of 4 saved', 'ok');
      return true;
    } catch (e) {
      err(e.message || 'Could not save. Check your connection and try again.');
      return false;
    }
  }

  async function submitStep() {
    const btn = $('#reg-next');
    btn.disabled = true;
    const ok = await saveStep(true);
    btn.disabled = false;
    if (!ok) return;
    if (step < 4) {
      step++;
      saveLocal();
      paint();
      window.scrollTo(0, 0);
    } else {
      try { localStorage.removeItem('reg_step'); } catch (e) {}
      toast('Registration submitted! Waiting for approval.', 'ok');
      location.hash = '#/approval';
      route();
    }
  }

  paint();
}

/* ================= GOOGLE MAPS MODULE (ported 20261017r01) =================
   Ported from rider-new build. Adapted for this codebase:
   - Uses state.active (not activeOrders), state.online, state.currentPos, state.token
   - Uses API constant (not API_BASE)
   - Heavy null-guards for the "Map-first Active tab crashed with real orders" bug:
     every coordinate access, stop iteration, and DOM lookup is guarded.
   Crash guards marked with [GUARD]. */

/* ---- Map state ---- */
let map = null, riderMarker = null;
let miniMap = null, miniRiderMarker = null, miniMapReady = false;
let stopMarkers = [];
let optimizedRoute = null, optimizedRouteFetchedAt = 0;
const OPTIMIZED_ROUTE_TTL_MS = 60000;

/* ---- 3D bike rider marker ---- */
const BIKE_IMG_URL = 'rider-bike-marker.png';
const BIKE_ICON_SIZE = 52;
let bikeBaseImg = null;
const bikeRotCache = {};
function preloadBikeImg() {
  try { bikeBaseImg = new Image(); bikeBaseImg.src = BIKE_IMG_URL; } catch (e) { bikeBaseImg = null; }
}
function bikeIconForHeading(heading) {
  if (!window.google) return null;
  const hasH = heading != null && !isNaN(heading) && isFinite(heading);
  const deg = hasH ? (((Math.round(heading / 15) * 15) % 360) + 360) % 360 : 0;
  let url = BIKE_IMG_URL;
  if (hasH && deg !== 0 && bikeBaseImg && bikeBaseImg.complete && bikeBaseImg.naturalWidth) {
    if (!bikeRotCache[deg]) {
      const s = 128, c = document.createElement('canvas');
      c.width = c.height = s;
      const ctx = c.getContext('2d');
      ctx.translate(s / 2, s / 2);
      ctx.rotate(deg * Math.PI / 180);
      const iw = bikeBaseImg.naturalWidth, ih = bikeBaseImg.naturalHeight;
      const sc = s / Math.max(iw, ih);
      ctx.drawImage(bikeBaseImg, -iw * sc / 2, -ih * sc / 2, iw * sc, ih * sc);
      try { bikeRotCache[deg] = c.toDataURL('image/png'); }
      catch (e) { bikeRotCache[deg] = BIKE_IMG_URL; }
    }
    url = bikeRotCache[deg];
  }
  return {
    url: url,
    scaledSize: new google.maps.Size(BIKE_ICON_SIZE, BIKE_ICON_SIZE),
    anchor: new google.maps.Point(BIKE_ICON_SIZE / 2, BIKE_ICON_SIZE / 2)
  };
}

// Running man marker (user request) - SVG running figure
function runnerIcon() {
  if (!window.google) return null;
  // Use emoji rendered to canvas for crisp marker
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = '48px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('\u{1F3C3}', 32, 34); // 🏃 runner emoji
  return {
    url: c.toDataURL(),
    scaledSize: new google.maps.Size(44, 44),
    anchor: new google.maps.Point(22, 22)
  };
}
function standingIcon() {
  if (!window.google) return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.font = '48px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('\u{1F6B6}', 32, 34); // 🚶 walking emoji (stopped)
  return {
    url: c.toDataURL(),
    scaledSize: new google.maps.Size(44, 44),
    anchor: new google.maps.Point(22, 22)
  };
}
function updateRunnerState(moving) {
  // Default Google marker - no custom icon switching
  return;
}

let _hdgAnim = null;
function paintRiderHeading(marker, heading, speed) {
  if (!marker || !window.google) return;
  const moving = speed != null && !isNaN(speed) && speed > 1.5;
  const hasH = moving && heading != null && !isNaN(heading) && isFinite(heading);
  const target = hasH ? (((Math.round(heading / 15) * 15) % 360) + 360) % 360 : 0;
  if (marker._bikeHdg === target && !_hdgAnim) return;
  if (_hdgAnim && _hdgAnim.marker === marker) cancelAnimationFrame(_hdgAnim.raf);
  const from = (marker._bikeHdg != null) ? marker._bikeHdg : target;
  const delta = ((target - from + 540) % 360) - 180;
  if (delta === 0) {
    marker._bikeHdg = target;
    try { marker.setIcon(bikeIconForHeading(hasH ? target : null)); } catch (e) {}
    return;
  }
  const start = performance.now(), dur = 240;
  const anim = { marker: marker, raf: null };
  _hdgAnim = anim;
  function frame(now) {
    const p = Math.min((now - start) / dur, 1);
    const e = 1 - Math.pow(1 - p, 3);
    const norm = ((Math.round((from + delta * e) / 15) * 15) % 360 + 360) % 360;
    if (marker._bikeHdg !== norm) {
      marker._bikeHdg = norm;
      try { marker.setIcon(bikeIconForHeading(hasH ? norm : null)); } catch (err) {}
    }
    if (p < 1) anim.raf = requestAnimationFrame(frame);
    else if (_hdgAnim === anim) _hdgAnim = null;
  }
  anim.raf = requestAnimationFrame(frame);
}

/* ---- Map styles/themes ---- */
function systemPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return true; }
}
const DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#1e1e1e' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#a8a8b3' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1e1e1e' }] },
  { featureType: 'administrative', elementType: 'geometry.stroke', stylers: [{ color: '#3d3d3d' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#232323' }] },
  { featureType: 'poi', elementType: 'geometry', stylers: [{ color: '#2a2a2a' }] },
  { featureType: 'poi', elementType: 'labels.text.fill', stylers: [{ color: '#ea580c' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#1c2a20' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#3a3a3a' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#1e1e1e' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#c0c0c8' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#4a4a4a' }] },
  { featureType: 'road.highway', elementType: 'geometry.stroke', stylers: [{ color: '#2e2e2e' }] },
  { featureType: 'transit', elementType: 'geometry', stylers: [{ color: '#2a2a2a' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#1a2a3a' }] }
];
function currentMapStyle() { return []; } // Clean Light — user picked Option 1, no dark map
function applyMapTheme() {
  var style = currentMapStyle();
  [window._mainMap, window._homeMap].forEach(function(m) {
    try { m && m.setOptions({ styles: style }); } catch (e) {}
  });
  var bg = systemPrefersDark() ? '#1e1e1e' : '#e5e3df';
  ['maps-map', 'home-mini-map'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.background = bg;
  });
}
try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyMapTheme); } catch (e) {}

/* ---- Map init ---- */
function fadeMapIn(el, gmap) {
  if (!el || el.dataset.mapFaded) return;
  el.dataset.mapFaded = '1';
  el.classList.add('map-fade');
  const show = () => el.classList.add('map-live');
  try { if (gmap && window.google) google.maps.event.addListenerOnce(gmap, 'tilesloaded', show); } catch (e) {}
  setTimeout(show, 2500);
}
const _markerGlides = new WeakMap();
function glideMarkerTo(marker, to, durationMs) {
  if (!marker || !to) return;
  durationMs = durationMs || 900;
  const prev = _markerGlides.get(marker);
  if (prev && prev.raf) cancelAnimationFrame(prev.raf);
  let from = null;
  try { const p = marker.getPosition(); from = p ? { lat: p.lat(), lng: p.lng() } : null; } catch (e) {}
  if (!from) { try { marker.setPosition(to); } catch (e) {} return; }
  const mLat = (to.lat - from.lat) * 111320;
  const mLng = (to.lng - from.lng) * 111320 * Math.cos(from.lat * Math.PI / 180);
  if (Math.hypot(mLat, mLng) < 3) { try { marker.setPosition(to); } catch (e) {} return; }
  const start = performance.now();
  const st = {};
  _markerGlides.set(marker, st);
  function frame(now) {
    const p = Math.min((now - start) / durationMs, 1);
    const e = 1 - Math.pow(1 - p, 3);
    try { marker.setPosition({ lat: from.lat + (to.lat - from.lat) * e, lng: from.lng + (to.lng - from.lng) * e }); } catch (err) {}
    if (p < 1) st.raf = requestAnimationFrame(frame);
    else { st.raf = null; _markerGlides.delete(marker); }
  }
  st.raf = requestAnimationFrame(frame);
}
function initMap() {
  if (window.google && window.google.maps) { if (!map) initGoogleMap(); return; }
  if (document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]')) return;
  fetchBackendConfig().then(() => {
    if (!MAPS_KEY) {
      const label = document.getElementById('maps-status');
      if (label) label.textContent = 'Map unavailable (no API key)';
      return;
    }
    if (window.google && window.google.maps) { if (!map) initGoogleMap(); return; }
    if (document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]')) return;
    const script = document.createElement('script');
    script.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(MAPS_KEY) + '&callback=initGoogleMap';
    script.async = true; script.defer = true;
    script.onerror = () => {
      const l2 = document.getElementById('maps-status');
      if (l2) l2.textContent = 'Map failed to load';
    };
    document.head.appendChild(script);
  });
}
window.initGoogleMap = function() {
  try { initGoogleMapInner(); } catch (e) { console.error('initGoogleMap failed', e); }
};
function initGoogleMapInner() {
  if (!window.google || map) return;
  const el = document.getElementById('maps-map');
  if (!el) return; // [GUARD] Maps tab not rendered
  map = new google.maps.Map(el, {
    center: { lat: 14.4426, lng: 79.9865 }, // Nellore default
    zoom: 13,
    disableDefaultUI: true,
    gestureHandling: 'greedy', tilt: 0, rotateControl: false,
    streetViewControl: false, mapTypeControl: false, fullscreenControl: false,
    styles: currentMapStyle()
  });
  window._mainMap = map;
  fadeMapIn(el, map);
  const lastPos = state.currentPos && state.currentPos.lat != null
    ? { lat: +state.currentPos.lat, lng: +state.currentPos.lng }
    : { lat: 14.4426, lng: 79.9865 };
  riderMarker = new google.maps.Marker({
    position: lastPos,
    map: map, visible: true
  });
  if (navigator.geolocation) {
    const updateRiderPos = (pos) => {
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      state.currentPos = p;
      try {
        riderMarker.setPosition(p); riderMarker.setVisible(true);
        map.setCenter(p); map.setZoom(14);
      } catch (e) {}
      renderMapStops();
    };
    // Fast first: low accuracy (~2 sec), then refine with high accuracy
    navigator.geolocation.getCurrentPosition(updateRiderPos, () => {
      navigator.geolocation.getCurrentPosition(updateRiderPos, () => {},
        { enableHighAccuracy: true, timeout: 30000, maximumAge: 0 });
    }, { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 });
  }
  initMapControls();
  renderMapStops();
}
function initHomeMiniMap() {
  if (miniMapReady || !window.google) return;
  const el = document.getElementById('home-mini-map');
  if (!el) return;
  const cp = state.currentPos;
  miniMap = new google.maps.Map(el, {
    center: (cp && cp.lat != null) ? { lat: +cp.lat, lng: +cp.lng } : { lat: 14.4426, lng: 79.9865 },
    zoom: (cp && cp.lat != null) ? 15 : 12,
    disableDefaultUI: true,
    gestureHandling: 'greedy', tilt: 0, rotateControl: false,
    streetViewControl: false, mapTypeControl: false, fullscreenControl: false,
    styles: currentMapStyle()
  });
  window._homeMap = miniMap;
  fadeMapIn(el, miniMap);
  miniRiderMarker = new google.maps.Marker({
    position: { lat: 14.4426, lng: 79.9865 },
    map: miniMap, visible: false,
    icon: bikeIconForHeading(null)
  });
  if (cp && cp.lat != null) paintMiniRider(cp);
  miniMapReady = true;
}
function paintMiniRider(p, heading, speed) {
  if (!p || p.lat == null) return; // [GUARD]
  const pos = { lat: +p.lat, lng: +p.lng };
  if (miniRiderMarker) {
    glideMarkerTo(miniRiderMarker, pos, 700);
    miniRiderMarker.setVisible(true);
    paintRiderHeading(miniRiderMarker, heading, speed);
  }
  if (miniMap) {
    try {
      miniMap.panTo(pos);
      if (miniMap.getZoom() < 12) miniMap.setZoom(16);
    } catch (e) {}
  }
}
function initMapControls() {
  // Map control buttons (recenter, etc.) — wired if present in DOM
  const rc = document.getElementById('maps-recenter');
  if (rc) rc.onclick = () => {
    const cp = state.currentPos;
    if (map && cp && cp.lat != null) {
      try { map.panTo({ lat: +cp.lat, lng: +cp.lng }); map.setZoom(15); } catch (e) {}
    }
  };
}

/* ---- Route optimization (adapted: state.active instead of activeOrders) ---- */
async function fetchOptimizedRoute(force) {
  const now = Date.now();
  if (!force && optimizedRoute && (now - optimizedRouteFetchedAt) < OPTIMIZED_ROUTE_TTL_MS) {
    return optimizedRoute;
  }
  const cp = state.currentPos;
  const lat = (cp && cp.lat != null) ? +cp.lat : null;
  const lng = (cp && cp.lng != null) ? +cp.lng : null;
  const active = state.active || []; // [GUARD] empty active list
  if (lat == null || lng == null || active.length === 0) return null;
  const token = state.token;
  try {
    const res = await fetch(API + '/api/rider/route/optimized?lat=' + lat + '&lng=' + lng, {
      headers: token ? { 'Authorization': 'Bearer ' + token } : {}
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.stops) || data.stops.length === 0) return null;
    optimizedRoute = data;
    optimizedRouteFetchedAt = now;
    return data;
  } catch (e) {
    return null; // never break navigation on a backend failure
  }
}
function normalizeStop(s) {
  if (!s) return null; // [GUARD] null stop
  const ids = Array.isArray(s.order_ids) ? s.order_ids
    : (Array.isArray(s.orderIds) ? s.orderIds : null);
  const firstId = (ids && ids.length) ? String(ids[0]) : null;
  const orderId = firstId || s.delivery_id || s.order_id || s.deliveryId || s.orderId || s.id;
  const rawType = String(s.type || s.stop_type || s.stopType || s.kind || '').toLowerCase();
  const type = (rawType.indexOf('drop') >= 0 || rawType.indexOf('deliver') >= 0) ? 'drop' : 'pickup';
  const lat = (s.lat != null ? s.lat : (s.latitude != null ? s.latitude : null));
  const lng = (s.lng != null ? s.lng : (s.longitude != null ? s.longitude : null));
  const seq = (s.sequence != null ? s.sequence : (s.seq != null ? s.seq : (s.order != null ? s.order : 0)));
  return {
    orderId: orderId,
    orderIds: ids ? ids.map(String) : (orderId != null ? [String(orderId)] : []),
    type: type,
    lat: lat != null ? parseFloat(lat) : null, // [GUARD] null coords stay null
    lng: lng != null ? parseFloat(lng) : null,
    seq: seq,
    raw: s
  };
}
function matchStopToOrder(stop) {
  if (!stop) return null; // [GUARD]
  const ids = (stop.orderIds && stop.orderIds.length) ? stop.orderIds
    : (stop.orderId != null ? [String(stop.orderId)] : []);
  const active = state.active || [];
  for (const id of ids) {
    const o = active.find(x => String(x.id) === String(id));
    if (o) return o;
  }
  return null;
}
/* Extract pickup/drop coordinates from a target delivery object.
   Backend: rest_lat/rest_lng (restaurant), addr_lat/addr_lng (customer). */
function deliveryCoords(d, type) {
  if (!d) return null; // [GUARD]
  if (type === 'pickup') {
    const lat = d.rest_lat != null ? +d.rest_lat : null;
    const lng = d.rest_lng != null ? +d.rest_lng : null;
    return (lat != null && lng != null) ? { lat, lng } : null;
  }
  const lat = d.addr_lat != null ? +d.addr_lat : null;
  const lng = d.addr_lng != null ? +d.addr_lng : null;
  return (lat != null && lng != null) ? { lat, lng } : null;
}
function getOrderedStops() {
  const active = state.active || []; // [GUARD]
  if (!active.length) return [];
  const backendStops = (optimizedRoute && Array.isArray(optimizedRoute.stops)) ? optimizedRoute.stops : null;
  if (backendStops && backendStops.length > 0) {
    const matched = [];
    backendStops.forEach(bs => {
      const s = normalizeStop(bs);
      if (!s || s.lat == null || s.lng == null) return; // [GUARD] skip bad stops
      const order = matchStopToOrder(s);
      if (order) matched.push({ orderId: s.orderId, type: s.type, lat: s.lat, lng: s.lng, seq: s.seq, order: order });
    });
    if (matched.length > 0) return matched;
  }
  // Fallback: derive stops from active deliveries (pickup then drop per delivery)
  const out = [];
  active.forEach(o => {
    if (!o || !o.id) return; // [GUARD]
    const pk = deliveryCoords(o, 'pickup');
    if (pk) out.push({ orderId: o.id, type: 'pickup', lat: pk.lat, lng: pk.lng, seq: 0, order: o });
    const dp = deliveryCoords(o, 'drop');
    if (dp) out.push({ orderId: o.id, type: 'drop', lat: dp.lat, lng: dp.lng, seq: 1, order: o });
  });
  return out;
}
function getNextStop() {
  const stops = getOrderedStops();
  const s = stops.find(x => x.lat != null && x.lng != null); // [GUARD]
  if (!s) return null;
  return { lat: s.lat, lng: s.lng, order: s.order, type: s.type };
}
let _lastStopSig = '';
function renderMapStops() {
  if (!map || !window.google) return; // [GUARD]
  let stops = [];
  try { stops = getOrderedStops().filter(s => s && s.lat != null && s.lng != null); }
  catch (e) { stops = []; } // [GUARD] never crash the map tab
  const sig = stops.map(s => s.orderId + ':' + s.type + ':' + s.seq).join('|');
  if (sig === _lastStopSig && stopMarkers.length > 0) return;
  _lastStopSig = sig;
  stopMarkers.forEach(m => { try { m.setMap(null); } catch (e) {} });
  stopMarkers = [];
  if (!stops.length) return; // [GUARD] no stops — leave map clean
  let bounds = null;
  try { bounds = new google.maps.LatLngBounds(); } catch (e) { return; }
  stops.forEach((s, i) => {
    try {
      const idx = i + 1;
      const pos = { lat: s.lat, lng: s.lng };
      const marker = new google.maps.Marker({
        position: pos, map: map, opacity: 0,
        label: { text: String(idx), color: '#fff', fontWeight: 'bold' },
        icon: {
          path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z',
          fillColor: s.type === 'pickup' ? '#f97316' : '#22c55e',
          fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2, scale: 1.2,
          anchor: new google.maps.Point(12, 22)
        }
      });
      stopMarkers.push(marker);
      fadeMarkerIn(marker, i * 90);
      bounds.extend(pos);
    } catch (e) {} // [GUARD] one bad marker never breaks the rest
  });
  if (stops.length > 0 && !navActive) {
    try { map.fitBounds(bounds); } catch (e) {}
  }
}
function fadeMarkerIn(marker, delay) {
  delay = delay || 0;
  let start = null;
  function step(ts) {
    if (start === null) start = ts;
    const p = Math.min(Math.max((ts - start - delay) / 320, 0), 1);
    const eased = 1 - Math.pow(1 - p, 3);
    try { marker.setOpacity(eased); } catch (e) {}
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ---- Google Routes API v2 ---- */
function decodePolyline(enc) {
  const pts = [];
  if (!enc) return pts; // [GUARD]
  let i = 0, lat = 0, lng = 0;
  try {
    while (i < enc.length) {
      let b, shift = 0, result = 0;
      do { b = enc.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
      lat += dlat;
      shift = 0; result = 0;
      do { b = enc.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
      lng += dlng;
      pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
  } catch (e) {}
  return pts;
}
function routesManeuverToLegacy(m) {
  const mp = {
    TURN_LEFT: 'turn-left', TURN_RIGHT: 'turn-right',
    TURN_SLIGHT_LEFT: 'turn-slight-left', TURN_SLIGHT_RIGHT: 'turn-slight-right',
    TURN_SHARP_LEFT: 'turn-sharp-left', TURN_SHARP_RIGHT: 'turn-sharp-right',
    UTURN_LEFT: 'uturn-left', UTURN_RIGHT: 'uturn-right', U_TURN: 'uturn-left',
    ROUNDABOUT_ENTER: 'roundabout-right', ROUNDABOUT_EXIT: 'roundabout-right',
    ROUNDABOUT_LEFT: 'roundabout-left', ROUNDABOUT_RIGHT: 'roundabout-right',
    FORK_LEFT: 'fork-left', FORK_RIGHT: 'fork-right',
    STRAIGHT: 'straight', DEPART: 'straight', CONTINUE: 'straight', MERGE: 'straight',
    ARRIVE: 'straight', NAME_CHANGE: 'straight'
  };
  return mp[m] || 'straight';
}
function parseRoutesDuration(s) {
  if (!s) return 0;
  let sec = 0;
  const h = /(\d+)h/.exec(s); if (h) sec += (+h[1]) * 3600;
  const m = /(\d+)m/.exec(s); if (m) sec += (+m[1]) * 60;
  const ss = /(\d+(?:\.\d+)?)s/.exec(s); if (ss) sec += Math.round(+ss[1]);
  return sec;
}
function fmtDistText(m) {
  m = Math.round(m || 0);
  return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : m + ' m';
}
function normalizeRoutesResponse(data) {
  try {
    const r = data && data.routes && data.routes[0];
    if (!r) return null;
    const path = r.polyline && r.polyline.encodedPolyline ? decodePolyline(r.polyline.encodedPolyline) : [];
    const legs = (r.legs || []).map(leg => {
      const steps = (leg.steps || []).map(s => {
        const ni = s.navigationInstruction || {};
        const sl = s.startLocation && s.startLocation.latLng;
        const el = s.endLocation && s.endLocation.latLng;
        const slat = sl ? +sl.latitude : 0, slng = sl ? +sl.longitude : 0;
        const elat = el ? +el.latitude : 0, elng = el ? +el.longitude : 0;
        const dm = s.distanceMeters || 0;
        return {
          distance: { text: fmtDistText(dm), value: dm },
          instructions: ni.instructions || '',
          maneuver: routesManeuverToLegacy(ni.maneuver),
          start_location: { lat: function() { return slat; }, lng: function() { return slng; } },
          end_location: { lat: function() { return elat; }, lng: function() { return elng; } },
        };
      });
      return {
        duration: { value: parseRoutesDuration(leg.duration || leg.staticDuration) },
        distance: { value: leg.distanceMeters || 0 },
        steps: steps,
      };
    });
    return { routes: [{ overview_path: path, legs: legs }] };
  } catch (e) { return null; }
}
async function fetchRoutesApi(origin, dest, waypointStops) {
  await fetchBackendConfig();
  const key = MAPS_KEY || '';
  if (!key) return null;
  if (!origin || origin.lat == null || !dest || dest.lat == null) return null; // [GUARD]
  const ll = p => ({ latitude: +p.lat, longitude: +p.lng });
  const body = {
    origin: { location: { latLng: ll(origin) } },
    destination: { location: { latLng: ll(dest) } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_AWARE',
    languageCode: 'en',
    units: 'METRIC',
  };
  if (waypointStops && waypointStops.length) {
    body.intermediates = waypointStops
      .filter(s => s && s.lat != null && s.lng != null) // [GUARD]
      .map(s => ({ location: { latLng: ll(s) } }));
  }
  try {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.duration,routes.legs.distanceMeters,routes.legs.steps',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) return null;
    return normalizeRoutesResponse(await res.json());
  } catch (e) { return null; }
}
/* Draw the optimized route polyline on the Maps tab (no navigation mode).
   Called after renderMapStops when stops exist. */
let _routeLine = null, _routeGlow = null;
function addRouteGlow(gmap, path) {
  if (!gmap || !window.google || !path || !path.length) return null; // [GUARD]
  try {
    return new google.maps.Polyline({
      path: path, map: gmap,
      strokeColor: '#f97316', strokeWeight: 10, strokeOpacity: 0.25,
    });
  } catch (e) { return null; }
}
async function drawOptimizedRouteLine() {
  if (!map || !window.google) return; // [GUARD]
  const stops = getOrderedStops().filter(s => s && s.lat != null && s.lng != null);
  if (stops.length < 1) return; // [GUARD] nothing to route
  const cp = state.currentPos;
  if (!cp || cp.lat == null) return; // [GUARD] need rider position
  const origin = { lat: +cp.lat, lng: +cp.lng };
  const dest = { lat: stops[stops.length - 1].lat, lng: stops[stops.length - 1].lng };
  const waypoints = stops.slice(0, -1).map(s => ({ lat: s.lat, lng: s.lng }));
  let result = null;
  try { result = await fetchRoutesApi(origin, dest, waypoints); } catch (e) { result = null; }
  if (!result || !result.routes || !result.routes[0]) return; // [GUARD] API failed — markers still show
  const path = result.routes[0].overview_path || [];
  if (!path.length) return;
  try {
    if (_routeGlow) { _routeGlow.setMap(null); _routeGlow = null; }
    if (_routeLine) { _routeLine.setMap(null); _routeLine = null; }
    _routeGlow = addRouteGlow(map, path);
    _routeLine = new google.maps.Polyline({
      path: path, map: map,
      strokeColor: '#f97316', strokeWeight: 5, strokeOpacity: 0.95,
    });
  } catch (e) {}
}

/* ---- Turn-by-turn navigation (adapted with crash guards) ---- */
let navActive = false;
let navRoutePath = null;
let lastRerouteAt = 0;
const OFF_ROUTE_THRESHOLD_M = 150;
const REROUTE_COOLDOWN_MS = 30000;
let navRouteLine = null, navGlow = null, navWatchId = null;
let navSteps = [], navCurrentStep = 0, navEtaInfo = null;
let navDestMarkers = [];
let navRerouting = false;
let _dirCache = null;
function clearNavDestMarkers() {
  navDestMarkers.forEach(m => { try { m.setMap(null); } catch (e) {} });
  navDestMarkers = [];
}
function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Auto-arrive: GPS proximity detection (user 2026-10-18: best rider app)
// When rider is within 100m of the next stop for 30+ seconds, auto-mark arrived
let _arriveCheckId = null;
let _arriveNearSince = 0;
function startAutoArrive() {
  if (_arriveCheckId) return;
  _arriveCheckId = setInterval(() => {
    try {
      if (!state.online || !state.active.length) return;
      const next = getNextStop();
      if (!next || !next.lat || !state.currentPos) return;
      const d = haversineKm(state.currentPos.lat, state.currentPos.lng, next.lat, next.lng) * 1000; // meters
      if (d < 100) {
        if (!_arriveNearSince) _arriveNearSince = Date.now();
        if (Date.now() - _arriveNearSince > 30000 && next.order) {
          // Auto-mark arrived
          const step = next.type === 'pickup' ? 'arrived-restaurant' : 'arrived-customer';
          _arriveNearSince = 0;
          toast('📍 Auto-arrived at ' + (next.type === 'pickup' ? 'restaurant' : 'customer'));
          stepAction(next.order.id, step);
        }
      } else _arriveNearSince = 0;
    } catch (e) {}
  }, 10000);
}
function stopAutoArrive() {
  if (_arriveCheckId) { clearInterval(_arriveCheckId); _arriveCheckId = null; }
  _arriveNearSince = 0;
}
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function startNavigation() {
  const next = getNextStop();
  window._navActive = true;
  if (window._voiceNav === undefined) window._voiceNav = true;
  if (!next) { toast('No stops to navigate to', 'err'); return; } // [GUARD]
  if (!window.google || !map) { toast('Map not ready', 'err'); return; } // [GUARD]
  if (!navigator.geolocation) { toast('Geolocation not supported', 'err'); return; } // [GUARD]
  navigator.geolocation.getCurrentPosition(
    pos => {
      try {
        const origin = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        const dest = { lat: next.lat, lng: next.lng };
        const orderedStops = getOrderedStops();
        const waypoints = orderedStops.slice(1, 9)
          .filter(s => s && s.lat != null && s.lng != null)
          .map(s => ({ lat: parseFloat(s.lat), lng: parseFloat(s.lng) }));
        fetchRoutesApi(origin, dest, waypoints).then(result => {
          const ok = result && result.routes && result.routes[0];
          _onDirectionsResult(result, ok ? 'OK' : 'ERROR', origin, dest, waypoints, next, orderedStops);
        });
      } catch (e) { navRerouting = false; }
    },
    () => { navRerouting = false; toast('Could not get your location', 'err'); },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}
function _onDirectionsResult(result, status, origin, dest, waypoints, next, orderedStops) {
  navRerouting = false;
  if (status !== 'OK' || !result || !result.routes || !result.routes[0]) {
    toast('Could not get directions', 'err');
    return;
  }
  if (!map || !window.google) return; // [GUARD]
  try {
    if (navRouteLine) { navRouteLine.setMap(null); navRouteLine = null; }
    if (navGlow) { navGlow.setMap(null); navGlow = null; }
    const path = result.routes[0].overview_path || [];
    navGlow = addRouteGlow(map, path);
    navRouteLine = new google.maps.Polyline({
      path: path, map: map,
      strokeColor: '#f97316', strokeWeight: 6, strokeOpacity: 0.95,
    });
    const allLegs = result.routes[0].legs || [];
    navSteps = allLegs.reduce((acc, l) => acc.concat(l.steps || []), []);
    navCurrentStep = 0;
    navActive = true;
    const nh = document.getElementById('nav-header');
    updateNavBanner();
    const etaText = document.getElementById('nav-eta-text');
    const etaSub = document.getElementById('nav-eta-sub');
    let totSec = 0, totM = 0;
    allLegs.forEach(l => {
      if (l.duration && l.duration.value) totSec += l.duration.value;
      if (l.distance && l.distance.value) totM += l.distance.value;
    });
    if (etaBanner && totSec > 0 && etaText) {
      const etaTxt = totSec >= 3600
        ? Math.floor(totSec / 3600) + 'h ' + Math.round((totSec % 3600) / 60) + 'm'
        : Math.round(totSec / 60) + ' min';
      const distTxt = totM >= 1000 ? (totM / 1000).toFixed(1) + ' km' : Math.round(totM) + ' m';
      etaText.textContent = etaTxt + ' • ' + distTxt;
      if (etaSub && next && next.order) {
        const isPickup = next.type === 'pickup';
        const destName = next.order.restaurant_name || next.order.name || (isPickup ? 'restaurant' : 'customer');
        etaSub.textContent = isPickup ? 'Arriving at ' + destName + ' for pickup' : "Arriving at customer's location";
      }
      etaBanner.classList.add('show');
      navEtaInfo = { etaTxt: etaTxt, distTxt: distTxt };
    }
    const _seqIdx = (orderedStops || []).findIndex(s => s && s.lat === next.lat && s.lng === next.lng);
    drawNavStopMarkers(next, _seqIdx >= 0 ? _seqIdx + 1 : 1);
    try {
      navRoutePath = path.map(p => ({ lat: p.lat, lng: p.lng }));
    } catch (e) { navRoutePath = null; }
    lastRerouteAt = Date.now();
    map.setCenter(origin);
    map.setZoom(16);
    if (navWatchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(navWatchId);
    navWatchId = navigator.geolocation.watchPosition(
      p => updateNavProgress({ lat: p.coords.latitude, lng: p.coords.longitude, speed: p.coords.speed }),
      () => {},
      { enableHighAccuracy: true }
    );
  } catch (e) { navRerouting = false; }
}
// Voice navigation: speak turn-by-turn instructions (user 2026-10-18: best rider app)
let _lastSpokenStep = -1;
function speakInstruction(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    if (!window._voiceNav) return; // voice toggle
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.1; u.volume = 1;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}
function updateNavBanner() {
  if (!navSteps.length || navCurrentStep >= navSteps.length) return;
  const step = navSteps[navCurrentStep];
  // Speak new steps aloud
  if (navCurrentStep !== _lastSpokenStep) {
    _lastSpokenStep = navCurrentStep;
    const dist = step.distance ? step.distance.text : '';
    const instr = step.instructions ? step.instructions.replace(/<[^>]*>/g, '') : '';
    if (instr) speakInstruction(dist ? ('In ' + dist + ', ' + instr) : instr);
  }
  if (!step) return; // [GUARD]
  const dist = step.distance ? step.distance.text : '';
  const instr = step.instructions ? step.instructions.replace(/<[^>]*>/g, '') : '';
  const dEl = document.getElementById('nav-dist');
  const iEl = document.getElementById('nav-instr');
  if (dEl) dEl.textContent = dist;
  if (iEl) iEl.textContent = instr;
  const tbbCard = document.getElementById('nav-turn-card');
  if (tbbCard) { tbbCard.classList.remove('tbb-swap'); void tbbCard.offsetWidth; tbbCard.classList.add('tbb-swap'); }
  const maneuver = step.maneuver || '';
  const icons = {
    'turn-left': '⬅️', 'turn-right': '➡️',
    'turn-slight-left': '↖️', 'turn-slight-right': '↗️',
    'turn-sharp-left': '⬅️', 'turn-sharp-right': '➡️',
    'uturn-left': '↩️', 'uturn-right': '↪️',
    'roundabout-left': '🔄', 'roundabout-right': '🔄',
    'fork-left': '↖️', 'fork-right': '↗️',
    'straight': '⬆️',
  };
  const icEl = document.getElementById('nav-turn-icon');
  if (icEl) icEl.textContent = icons[maneuver] || '⬆️';
  const thenEl = document.getElementById('nav-then');
  if (thenEl) {
    if (navCurrentStep + 1 < navSteps.length) {
      const ns = navSteps[navCurrentStep + 1];
      const ni = ns && ns.instructions ? ns.instructions.replace(/<[^>]*>/g, '').substring(0, 40) : '';
      thenEl.textContent = 'Then ' + (ns && ns.distance ? ns.distance.text : '') + ' • ' + ni;
      thenEl.style.display = 'block';
    } else thenEl.style.display = 'none';
  }
}
function updateNavProgress(riderPos) {
  if (!navActive || !navSteps.length || !riderPos) return; // [GUARD]
  let advanced = false;
  while (navCurrentStep + 1 < navSteps.length) {
    const ns = navSteps[navCurrentStep + 1];
    if (!ns || !ns.start_location) break;
    let dStart = Infinity;
    try { dStart = haversineM(riderPos.lat, riderPos.lng, ns.start_location.lat(), ns.start_location.lng()); } catch (e) {}
    if (dStart < 50) { navCurrentStep++; advanced = true; }
    else break;
  }
  if (!advanced) {
    const step = navSteps[navCurrentStep];
    if (step && step.end_location) {
      let distM = Infinity;
      try { distM = haversineM(riderPos.lat, riderPos.lng, step.end_location.lat(), step.end_location.lng()); } catch (e) {}
      if (distM < 30 && navCurrentStep + 1 < navSteps.length) { navCurrentStep++; advanced = true; }
    }
  }
  if (advanced) updateNavBanner();
  if (navRoutePath && navRoutePath.length > 0 && Date.now() - lastRerouteAt > REROUTE_COOLDOWN_MS) {
    let minDist = Infinity;
    for (const pt of navRoutePath) {
      if (!pt || pt.lat == null) continue; // [GUARD]
      const d = haversineM(riderPos.lat, riderPos.lng, pt.lat, pt.lng);
      if (d < minDist) minDist = d;
      if (minDist < OFF_ROUTE_THRESHOLD_M) break;
    }
    if (minDist >= OFF_ROUTE_THRESHOLD_M && !navRerouting) {
      navRerouting = true;
      startNavigation();
    }
  }
  // Glide the rider marker to the live position
  if (riderMarker && riderPos.lat != null) {
    glideMarkerTo(riderMarker, { lat: +riderPos.lat, lng: +riderPos.lng }, 900);
    riderMarker.setVisible(true);
  }
  state.currentPos = { lat: riderPos.lat, lng: riderPos.lng };
}
function drawNavStopMarkers(nextStop, stopNumber) {
  if (!nextStop || !window.google || !map) return; // [GUARD]
  clearNavDestMarkers();
  const isPickup = nextStop.type === 'pickup';
  const color = isPickup ? '#22c55e' : '#ef4444';
  const num = (stopNumber != null && stopNumber > 0) ? String(stopNumber) : '1';
  try {
    const marker = new google.maps.Marker({
      position: { lat: nextStop.lat, lng: nextStop.lng },
      map: map,
      title: 'Stop ' + num,
      label: { text: num, color: '#fff', fontWeight: 'bold', fontSize: '14px' },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 16, fillColor: color, fillOpacity: 1,
        strokeColor: '#fff', strokeWeight: 3,
      }
    });
    navDestMarkers.push(marker);
    fadeMarkerIn(marker, 0);
  } catch (e) {}
}
function exitNavigation() {
  window._navActive = false;
  navActive = false;
  navSteps = []; navCurrentStep = 0; navEtaInfo = null;
  try {
    if (navRouteLine) { navRouteLine.setMap(null); navRouteLine = null; }
    if (navGlow) { navGlow.setMap(null); navGlow = null; }
    if (navWatchId !== null && navigator.geolocation) { navigator.geolocation.clearWatch(navWatchId); navWatchId = null; }
  } catch (e) {}
  clearNavDestMarkers();
  const nh = document.getElementById('nav-header');
  if (nh) nh.style.display = 'none';

}

/* ============================================================
   SELF-UPDATE (ported from the customer app, 2026-10-17)
   The rider app had no self-update: a stale cached build (like the one
   seen 2026-10-17 with the map gap + slow GPS) sat on the phone until the
   rider closed all of Safari. Now the app fetches version.txt on boot and
   whenever the tab becomes visible again; if the served build differs from
   APP_V it reloads — but never while an offer is on screen, turn-by-turn
   navigation is running, or the rider is in login/onboarding/approval.
   version.txt ships beside app.js in the deploy (no-store fetch so it is
   never itself stale).
   ============================================================ */
var _vCheckedAt = 0;

function _safeToAutoReload() {
  var tk = document.getElementById('takeover-root');
  if (tk && tk.firstChild) return false;            // incoming offer (full takeover)
  if (document.querySelector('.offer-sheet')) return false; // offer bottom sheet while riding
  try { if (typeof navActive !== 'undefined' && navActive) return false; } catch (e) {}
  var h = location.hash || '';
  if (h.indexOf('#/onboarding') === 0 || h.indexOf('#/approval') === 0 ||
      h.indexOf('#/login') === 0 || h.indexOf('#/register') === 0) return false;
  return true;
}

function checkAppVersion(force) {
  var t = Date.now();
  if (!force && t - _vCheckedAt < 60000) return;
  _vCheckedAt = t;
  fetch('version.txt?x=' + t, { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw 0; return r.text(); })
    .then(function (txt) {
      txt = (txt || '').trim();
      if (txt && txt !== APP_V && (force || _safeToAutoReload())) location.reload();
    })
    .catch(function () {});
}

document.addEventListener('DOMContentLoaded', function () { checkAppVersion(true); });
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) checkAppVersion(false);
});
