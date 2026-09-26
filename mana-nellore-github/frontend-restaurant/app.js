'use strict';
/* Mana Nellore Partner — restaurant portal.
   Static frontend talking to the live Railway backend via fetch.
   All money in paise; UI shows ₹. Auth: OTP -> JWT in localStorage. */

const API = 'https://mana-nellore-mana-nellore.up.railway.app';
const TOKEN_KEY = 'mana_rest_token';

const view = document.getElementById('view');
const topbar = document.getElementById('topbar');
const tabbar = document.getElementById('tabbar');
const modalRoot = document.getElementById('modalRoot');
const toastRoot = document.getElementById('toastRoot');
const openToggle = document.getElementById('openToggle');

const state = {
  user: null,
  restaurant: null,
  orders: [],
  ordersFilter: 'all',
  ordersSearch: '',
  ordersSeeded: false,
  knownOrderIds: new Set(),
  menuCats: [],
  menuItems: [],
  soundOn: true
};
try { state.soundOn = localStorage.getItem('mana_rest_sound') !== 'off'; } catch (e) { /* default on */ }

let pollTimer = null;
function stopPollers() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/* ---------------- utils ---------------- */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtRs(paise) {
  const n = (Number(paise) || 0) / 100;
  return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function rsToPaise(rs) {
  const s = String(rs).trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}
function fmtDT(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
}
function fmtClock(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function timeHM(t) { // "HH:MM:SS" -> "HH:MM"
  return t ? String(t).slice(0, 5) : '';
}
function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso), now = new Date();
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
}
function getToken() { return localStorage.getItem(TOKEN_KEY); }

function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' error' : '');
  el.textContent = msg;
  toastRoot.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3200);
}

let audioCtx = null;
function playNewOrderSound() {
  if (!state.soundOn) return;
  try {
    if (navigator.vibrate) { try { navigator.vibrate([150, 80, 150]); } catch (e) {} }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx || new AC();
    if (audioCtx.state === 'suspended') { audioCtx.resume().catch(() => {}); }
    const t0 = audioCtx.currentTime;
    [[880, 0], [1174.66, 0.22]].forEach(pair => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = pair[0];
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      gain.gain.setValueAtTime(0.0001, t0 + pair[1]);
      gain.gain.exponentialRampToValueAtTime(0.35, t0 + pair[1] + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + pair[1] + 0.2);
      osc.start(t0 + pair[1]);
      osc.stop(t0 + pair[1] + 0.24);
    });
  } catch (e) { /* audio unavailable — stay silent */ }
}

function syncSoundBtn() {
  const b = document.getElementById('soundBtn');
  if (!b) return;
  b.classList.toggle('off', !state.soundOn);
  b.setAttribute('aria-pressed', state.soundOn ? 'true' : 'false');
  b.title = state.soundOn ? 'New-order sound: on' : 'New-order sound: off';
}

function openModal(html) {
  modalRoot.innerHTML = '<div class="modal-backdrop"><div class="modal" role="dialog">' + html + '</div></div>';
  const bd = modalRoot.firstElementChild;
  bd.addEventListener('click', e => { if (e.target === bd) closeModal(); });
}
function closeModal() { modalRoot.innerHTML = ''; }

async function api(path, opts) {
  opts = opts || {};
  const headers = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) headers.Authorization = 'Bearer ' + t;
  let res;
  try {
    res = await fetch(API + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
  } catch (e) {
    throw new Error('Network error. Check your internet connection and try again.');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
  if (res.status === 401) {
    const err = new Error('Session expired. Please log in again.');
    err.unauth = true;
    logout();
    throw err;
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
    err.status = res.status;
    throw err;
  }
  return data || {};
}

function logout() {
  localStorage.removeItem(TOKEN_KEY);
  state.user = null; state.restaurant = null; state.orders = [];
  state.ordersSeeded = false; state.knownOrderIds = new Set();
  stopPollers(); closeModal();
  setChrome(false);
  if ((location.hash || '') !== '#/login') location.hash = '#/login';
  else router();
}

function setChrome(on) {
  topbar.classList.toggle('hidden', !on);
  tabbar.classList.toggle('hidden', !on);
  view.classList.toggle('fullscreen', !on);
}

function setActiveTab(tab) {
  tabbar.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
}

function loadingHtml(msg) {
  return '<div class="loading"><div class="spinner"></div>' + esc(msg || 'Loading…') + '</div>';
}
function skel(h) {
  return '<div class="skel" style="height:' + (h || 120) + 'px;margin-bottom:12px"></div>';
}
function emptyHtml(title, sub) {
  return '<div class="empty">' +
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M8 12h8"/></svg>' +
    '<h3>' + esc(title) + '</h3><p>' + esc(sub || '') + '</p></div>';
}
function statCard(num, label, cls, id) {
  return '<div class="stat-card ' + (cls || '') + '"' +
    (id ? ' id="' + id + '" role="button" tabindex="0" aria-label="' + esc(label) + ': ' + esc(String(num)) + '"' : '') + '>' +
    '<div class="num">' + num + '</div><div class="lbl">' + esc(label) + '</div></div>';
}

/* ---------------- router ---------------- */
function currentParts() {
  const h = location.hash || '#/login';
  return h.replace(/^#\//, '').split('/');
}

async function ensureRestaurant() {
  try {
    const data = await api('/api/owner/restaurant');
    state.restaurant = data.restaurant;
    return data.restaurant;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function router() {
  stopPollers(); closeModal();
  const parts = currentParts();
  const token = getToken();

  if (!token) { setChrome(false); renderLogin(); return; }
  if (parts[0] === 'login') { location.hash = '#/app/home'; return; }

  let r;
  try { r = await ensureRestaurant(); }
  catch (e) { if (e.unauth) return; setChrome(false); renderBootError(e.message); return; }

  if (!r) {
    setChrome(false);
    if (parts[0] !== 'register') { location.hash = '#/register'; return; }
    renderRegister(); return;
  }
  if (r.status === 'pending' || r.status === 'rejected' || r.status === 'suspended') {
    setChrome(false);
    if (parts[0] !== 'pending') { location.hash = '#/pending'; return; }
    renderPending(r); return;
  }
  // approved
  setChrome(true);
  syncOpenToggle();
  const tab = (parts[0] === 'app' && parts[1]) ? parts[1] : 'home';
  if (parts[0] !== 'app' || !['home','orders','menu','profile','settlements','ratings'].includes(tab)) {
    location.hash = '#/app/home'; return;
  }
  setActiveTab(tab);
  if (tab === 'home') await renderHome();
  else if (tab === 'orders') await renderOrders();
  else if (tab === 'menu') await renderMenu();
  else if (tab === 'profile') await renderProfile();
  else if (tab === 'settlements') await renderSettlements();
  else if (tab === 'ratings') await renderRatings();
}

function renderBootError(msg) {
  view.innerHTML = '<div class="auth-wrap"><div class="error-box">' + esc(msg) + '</div>' +
    '<button class="btn" id="retryBtn" type="button">Retry</button>' +
    '<div style="text-align:center;margin-top:8px"><button class="link-btn" id="logoutLink" type="button">Log out</button></div></div>';
  document.getElementById('retryBtn').onclick = router;
  document.getElementById('logoutLink').onclick = logout;
}

/* ---------------- login ---------------- */
function renderLogin() { renderLoginPhone(); }

function renderLoginPhone() {
  view.innerHTML =
    '<div class="auth-wrap"><div class="auth-brand">' +
    '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#0b5b43"/>' +
    '<path d="M10 21.5c1.8-4.2 4-6.3 6-6.3s4.2 2.1 6 6.3" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
    '<circle cx="16" cy="11" r="2.6" fill="#ffd166"/></svg>' +
    '<h1>Mana Nellore Partner</h1><p>Restaurant owner portal</p></div>' +
    '<div class="card"><div class="field"><label for="phone">Mobile number</label>' +
    '<input id="phone" inputmode="numeric" maxlength="13" placeholder="10-digit mobile number" autocomplete="tel">' +
    '<div class="hint">We will send a one-time password by SMS.</div></div>' +
    '<button class="btn" id="sendOtpBtn" type="button">Send OTP</button></div></div>';
  const phoneInput = document.getElementById('phone');
  phoneInput.focus();
  const send = async () => {
    const phone = phoneInput.value.replace(/\D/g, '');
    if (!/^\d{10}$/.test(phone.slice(-10))) { toast('Enter a valid 10-digit mobile number', true); return; }
    const btn = document.getElementById('sendOtpBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const data = await api('/api/auth/send-otp', { method: 'POST', body: { phone } });
      renderLoginOtp(phone, data.dev_code);
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Send OTP'; }
  };
  document.getElementById('sendOtpBtn').onclick = send;
  phoneInput.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
}

function renderLoginOtp(phone, devCode) {
  view.innerHTML =
    '<div class="auth-wrap"><div class="auth-brand">' +
    '<svg viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#0b5b43"/>' +
    '<path d="M10 21.5c1.8-4.2 4-6.3 6-6.3s4.2 2.1 6 6.3" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>' +
    '<circle cx="16" cy="11" r="2.6" fill="#ffd166"/></svg>' +
    '<h1>Enter OTP</h1><p>Sent to +91 ' + esc(phone.slice(-10)) + '</p></div>' +
    '<div class="card">' +
    '<div class="field"><label for="otp">One-time password</label>' +
    '<input id="otp" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code">' +
    (devCode ? '<div class="hint">Test mode: code auto-filled.</div>' : '') + '</div>' +
    '<div class="field"><label for="ownerName">Your name <span style="font-weight:400;color:var(--muted)">(for new accounts)</span></label>' +
    '<input id="ownerName" placeholder="e.g. Ravi Kumar" autocomplete="name"></div>' +
    '<button class="btn" id="verifyBtn" type="button">Verify &amp; log in</button>' +
    '<div style="text-align:center;margin-top:6px"><button class="link-btn" id="backBtn" type="button">Change number</button></div>' +
    '</div></div>';
  const otpInput = document.getElementById('otp');
  if (devCode) otpInput.value = devCode;
  otpInput.focus();
  document.getElementById('backBtn').onclick = renderLoginPhone;
  const verify = async () => {
    const code = otpInput.value.trim();
    const name = document.getElementById('ownerName').value.trim();
    if (code.length < 4) { toast('Enter the OTP sent to your phone', true); return; }
    const btn = document.getElementById('verifyBtn');
    btn.disabled = true; btn.textContent = 'Verifying…';
    try {
      const data = await api('/api/auth/verify-otp', {
        method: 'POST', body: { phone, code, name: name || undefined, role: 'restaurant_owner' }
      });
      if (data.user && data.user.role !== 'restaurant_owner') {
        throw new Error('This number is registered as a ' + data.user.role.replace('_', ' ') + '. Please use the matching app or a different number.');
      }
      localStorage.setItem(TOKEN_KEY, data.token);
      state.user = data.user;
      toast('Welcome' + (data.user.name ? ', ' + data.user.name : '') + '!');
      location.hash = '#/app/home';
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = 'Verify & log in'; }
  };
  document.getElementById('verifyBtn').onclick = verify;
  otpInput.addEventListener('keydown', e => { if (e.key === 'Enter') verify(); });
}

/* ---------------- registration & pending ---------------- */
function renderRegister() {
  view.innerHTML =
    '<div class="auth-wrap"><div class="auth-brand">' +
    '<h1 style="font-size:22px">Register your restaurant</h1>' +
    '<p>Our team will review and approve it, usually within a day.</p></div>' +
    '<div class="card"><form id="regForm">' +
    '<div class="field"><label>Restaurant name *</label><input name="name" required maxlength="80" placeholder="e.g. Babai Hotel"></div>' +
    '<div class="field"><label>Contact phone *</label><input name="phone" inputmode="tel" required maxlength="13" placeholder="Owner mobile number"></div>' +
    '<div class="field"><label>Street address *</label><input name="street" required maxlength="160" placeholder="Shop no, street, area"></div>' +
    '<div class="field-row"><div class="field"><label>City *</label><input name="city" required maxlength="60" value="Nellore"></div>' +
    '<div class="field"><label>Pincode *</label><input name="pincode" inputmode="numeric" required maxlength="6" placeholder="524001"></div></div>' +
    '<div class="field"><label>FSSAI license no.</label><input name="fssai" maxlength="30" placeholder="Optional"></div>' +
    '<div class="field"><label>Photo URL</label><input name="image_url" inputmode="url" maxlength="500" placeholder="https://… (optional)"></div>' +
    '<div class="field"><label>About</label><textarea name="description" rows="2" maxlength="500" placeholder="A line about your food (optional)"></textarea></div>' +
    '<div class="field-row"><div class="field"><label>Opens at</label><input name="opens_at" type="time" value="10:00"></div>' +
    '<div class="field"><label>Closes at</label><input name="closes_at" type="time" value="22:00"></div></div>' +
    '<button class="btn" type="submit" id="regSubmit">Submit for approval</button>' +
    '</form></div><div style="text-align:center"><button class="link-btn" id="regLogout" type="button">Log out</button></div></div>';
  document.getElementById('regLogout').onclick = logout;
  document.getElementById('regForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = document.getElementById('regSubmit');
    btn.disabled = true; btn.textContent = 'Submitting…';
    const address = [f.get('street'), f.get('city') + ' - ' + f.get('pincode')].filter(Boolean).join(', ');
    try {
      const data = await api('/api/owner/restaurant', { method: 'POST', body: {
        name: String(f.get('name')).trim(),
        phone: String(f.get('phone')).trim(),
        address,
        description: String(f.get('description')).trim() || undefined,
        image_url: String(f.get('image_url')).trim() || undefined,
        fssai: String(f.get('fssai')).trim() || undefined,
        opens_at: f.get('opens_at') || undefined,
        closes_at: f.get('closes_at') || undefined
      }});
      state.restaurant = data.restaurant;
      toast('Registration submitted!');
      location.hash = '#/pending';
    } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = 'Submit for approval'; }
  });
}

function renderPending(r) {
  if (r.status === 'rejected') {
    view.innerHTML = '<div class="auth-wrap"><div class="card"><div class="error-box"><strong>Registration not approved.</strong><br>' +
      'Our team could not approve your restaurant at this time. Please contact Mana Nellore support for details.</div>' +
      '<button class="btn secondary" id="pLogout" type="button">Log out</button></div></div>';
    document.getElementById('pLogout').onclick = logout;
    return;
  }
  if (r.status === 'suspended') {
    view.innerHTML = '<div class="auth-wrap"><div class="card"><div class="error-box"><strong>Restaurant suspended.</strong><br>' +
      'Your restaurant has been suspended by the operations team. Please contact support to resolve this.</div>' +
      '<button class="btn secondary" id="pLogout" type="button">Log out</button></div></div>';
    document.getElementById('pLogout').onclick = logout;
    return;
  }
  view.innerHTML =
    '<div class="auth-wrap"><div class="card"><div class="pending-hero">' +
    '<div class="spinner"></div><h2 style="color:var(--green-900);margin:0 0 8px">Waiting for approval</h2>' +
    '<p style="color:var(--muted);margin:0 0 6px"><strong style="color:var(--ink)">' + esc(r.name) + '</strong> is under review.</p>' +
    '<p style="color:var(--muted);font-size:13px;margin:0">This page checks automatically. You can close the app — we will notify you.</p></div>' +
    '<button class="btn secondary" id="checkNow" type="button">Check now</button>' +
    '<div style="text-align:center;margin-top:6px"><button class="link-btn" id="pLogout" type="button">Log out</button></div>' +
    '</div></div>';
  document.getElementById('pLogout').onclick = logout;
  const check = async () => {
    try {
      const nr = await ensureRestaurant();
      if (!nr) { location.hash = '#/register'; return; }
      if (nr.status === 'approved') { toast('Your restaurant is approved!'); location.hash = '#/app/home'; return; }
      if (nr.status !== 'pending') renderPending(nr);
    } catch (e) { if (!e.unauth) toast(e.message, true); }
  };
  document.getElementById('checkNow').onclick = check;
  pollTimer = setInterval(check, 15000);
}

/* ---------------- chrome: open toggle, tabs ---------------- */
function syncOpenToggle() {
  const r = state.restaurant;
  if (!r) return;
  openToggle.classList.toggle('closed', !r.is_open);
  openToggle.querySelector('.lbl').textContent = r.is_open ? 'Open' : 'Closed';
}
openToggle.addEventListener('click', async () => {
  if (!state.restaurant) return;
  const next = !state.restaurant.is_open;
  openToggle.disabled = true;
  try {
    const data = await api('/api/owner/open', { method: 'PUT', body: { is_open: next } });
    state.restaurant = data.restaurant;
    syncOpenToggle();
    toast(next ? 'You are now OPEN for orders' : 'You are now CLOSED');
  } catch (e) { toast(e.message, true); }
  openToggle.disabled = false;
});
document.getElementById('logoutBtn').addEventListener('click', () => {
  if (confirm('Log out of the partner portal?')) logout();
});
document.getElementById('soundBtn').addEventListener('click', () => {
  state.soundOn = !state.soundOn;
  try { localStorage.setItem('mana_rest_sound', state.soundOn ? 'on' : 'off'); } catch (e) {}
  syncSoundBtn();
  toast(state.soundOn ? 'New-order sound on' : 'New-order sound off');
  if (state.soundOn) playNewOrderSound();
});
syncSoundBtn();
tabbar.querySelectorAll('button').forEach(b => {
  b.addEventListener('click', () => { location.hash = '#/app/' + b.dataset.tab; });
});

/* ---------------- orders ---------------- */
const ORDER_LABEL = {
  placed: 'New', accepted: 'Accepted', preparing: 'Preparing', ready: 'Ready',
  picked_up: 'Picked up', on_way: 'On the way', delivered: 'Delivered',
  rejected: 'Rejected', cancelled: 'Cancelled'
};
const FILTERS = [
  ['all', 'All'], ['placed', 'New'], ['accepted', 'Accepted'],
  ['preparing', 'Preparing'], ['ready', 'Ready'], ['past', 'Past']
];
function filterMatch(o, f) {
  if (f === 'all') return true;
  if (f === 'past') return ['delivered', 'rejected', 'cancelled'].includes(o.status);
  return o.status === f;
}

async function renderOrders() {
  const counts = {};
  for (const o of state.orders) counts[o.status] = (counts[o.status] || 0) + 1;
  const chips = FILTERS.map(([k, label]) => {
    const n = k === 'all' ? state.orders.length : k === 'past'
      ? (counts.delivered || 0) + (counts.rejected || 0) + (counts.cancelled || 0)
      : (counts[k] || 0);
    return '<button type="button" class="chip' + (state.ordersFilter === k ? ' active' : '') +
      '" data-filter="' + k + '">' + label + '<span class="count">' + n + '</span></button>';
  }).join('');
  view.innerHTML =
    '<div class="screen-head"><h1>Orders</h1>' +
    '<span class="live-dot"><i></i>Live · refreshes every 10s</span></div>' +
    '<div class="search-wrap">' +
    '<input id="orderSearch" type="search" placeholder="Search order ID, customer name or phone…" ' +
    'autocomplete="off" value="' + esc(state.ordersSearch) + '" aria-label="Search orders">' +
    '<button type="button" class="search-clear' + (state.ordersSearch ? '' : ' hidden') + '" id="orderSearchClear" aria-label="Clear search" title="Clear search">×</button></div>' +
    '<div class="filter-chips">' + chips + '</div>' +
    '<div id="ordersList">' + skel(120) + skel(120) + skel(120) + '</div>';
  view.querySelectorAll('[data-filter]').forEach(c => {
    c.addEventListener('click', () => { state.ordersFilter = c.dataset.filter; renderOrders(); });
  });
  const sInput = document.getElementById('orderSearch');
  const sClear = document.getElementById('orderSearchClear');
  sInput.addEventListener('input', () => {
    state.ordersSearch = sInput.value.trim();
    sClear.classList.toggle('hidden', !state.ordersSearch);
    paintOrdersList();
  });
  sClear.addEventListener('click', () => { state.ordersSearch = ''; renderOrders(); });
  document.getElementById('ordersList').addEventListener('click', onOrderClick);
  await loadOrders();
  pollTimer = setInterval(() => loadOrders(true), 10000);
}

async function loadOrders(silent) {
  try {
    const data = await api('/api/owner/orders');
    const orders = data.orders || [];
    if (!state.ordersSeeded) {
      orders.forEach(o => state.knownOrderIds.add(o.id));
      state.ordersSeeded = true;
    } else {
      for (const o of orders) {
        if (o.status === 'placed' && !state.knownOrderIds.has(o.id)) {
          state.knownOrderIds.add(o.id);
          toast('New order ' + shortId(o.id) + ' — ' + fmtRs(o.total_paise));
          playNewOrderSound();
        }
      }
    }
    state.orders = orders;
    updateOrdersBadge();
    paintOrdersList();
    // refresh filter counts without full re-render
    const counts = {};
    for (const o of orders) counts[o.status] = (counts[o.status] || 0) + 1;
    view.querySelectorAll('[data-filter]').forEach(c => {
      const k = c.dataset.filter;
      const n = k === 'all' ? orders.length : k === 'past'
        ? (counts.delivered || 0) + (counts.rejected || 0) + (counts.cancelled || 0)
        : (counts[k] || 0);
      const s = c.querySelector('.count'); if (s) s.textContent = n;
    });
    return true;
  } catch (e) {
    if (e.unauth) return false;
    if (!silent) document.getElementById('ordersList').innerHTML =
      '<div class="error-box">' + esc(e.message) + ' <button class="link-btn" id="ordRetry" type="button">Retry</button></div>';
    const rb = document.getElementById('ordRetry');
    if (rb) rb.onclick = () => loadOrders(false);
    return false;
  }
}

function updateOrdersBadge() {
  const n = state.orders.filter(o => o.status === 'placed').length;
  const b = document.getElementById('ordersBadge');
  b.classList.toggle('hidden', n === 0);
  b.textContent = n > 99 ? '99+' : n;
}

function shortId(id) { return '#' + String(id).slice(0, 8).toUpperCase(); }

function promiseHtml(o) {
  if (!o.promised_at) return '';
  const diff = new Date(o.promised_at) - Date.now();
  const mins = Math.round(Math.abs(diff) / 60000);
  const t = fmtClock(o.promised_at);
  let cls = '', label;
  if (diff < 0) { cls = 'late'; label = 'Overdue by ' + mins + ' min'; }
  else if (diff <= 10 * 60000) { cls = 'soon'; label = 'Due in ' + mins + ' min'; }
  else label = 'Due in ' + mins + ' min';
  return '<div class="promise ' + cls + '">Promised by ' + esc(t) + ' · ' + esc(label) + '</div>';
}

function orderCard(o) {
  const items = (o.items || []).map(it =>
    '<div class="oi"><span>' + esc(it.qty) + ' × ' + esc(it.name_snapshot) + '</span><span>' +
    fmtRs(it.unit_price_paise * it.qty) + '</span></div>'
  ).join('');
  const addr = [o.line1, o.line2, o.city].filter(Boolean).join(', ');
  let actions = '';
  if (o.status === 'placed') {
    actions = '<div class="btn-row"><button class="btn small" data-action="accept" data-id="' + o.id + '" type="button">Accept</button>' +
      '<button class="btn small danger" data-action="reject" data-id="' + o.id + '" type="button">Reject</button></div>';
  } else if (o.status === 'accepted') {
    actions = '<div class="btn-row"><button class="btn small" data-action="preparing" data-id="' + o.id + '" type="button">Start preparing</button></div>';
  } else if (o.status === 'preparing') {
    actions = '<div class="btn-row"><button class="btn small" data-action="ready" data-id="' + o.id + '" type="button">Mark ready for pickup</button></div>';
  } else if (o.status === 'ready') {
    actions = '<div class="notice-box" style="margin:10px 0 0">Packed and ready — waiting for the rider to pick up.</div>';
  }
  return '<div class="card order st-' + o.status + '">' +
    '<div class="order-top"><div><div class="order-id">' + esc(shortId(o.id)) + '</div>' +
    '<div class="order-time">' + esc(fmtDT(o.placed_at)) + ' · ' + esc(o.payment_method || '—').toUpperCase() +
    ' · ' + esc(o.payment_status || '') + '</div></div>' +
    '<span class="pill ' + o.status + '">' + esc(ORDER_LABEL[o.status] || o.status) + '</span></div>' +
    '<div class="order-items">' + items + '</div>' +
    '<div class="order-total"><span>Total</span><span>' + fmtRs(o.total_paise) + '</span></div>' +
    promiseHtml(o) +
    '<div class="order-meta"><strong>' + esc(o.customer_name || 'Customer') + '</strong>' +
    (o.customer_phone ? ' · <a href="tel:' + esc(o.customer_phone) + '">' + esc(o.customer_phone) + '</a>' : '') +
    (addr ? '<br>' + esc(addr) : '') +
    (o.rider_name ? '<br>Rider: ' + esc(o.rider_name) + (o.rider_phone ? ' (' + esc(o.rider_phone) + ')' : '') : '') +
    '</div>' + actions + '</div>';
}

function paintOrdersList() {
  const list = document.getElementById('ordersList');
  if (!list) return;
  const shown = state.orders.filter(o => filterMatch(o, state.ordersFilter) && searchMatch(o, state.ordersSearch));
  if (!shown.length) {
    if (state.ordersSearch) {
      list.innerHTML = emptyHtml('No matches for "' + state.ordersSearch + '"', 'Try a different order ID, customer name or phone number.') +
        '<div style="text-align:center"><button class="link-btn" id="clearSearchEmpty" type="button">Clear search</button></div>';
      document.getElementById('clearSearchEmpty').onclick = () => { state.ordersSearch = ''; renderOrders(); };
    } else {
      list.innerHTML = emptyHtml(
        state.ordersFilter === 'placed' ? 'No new orders' : 'No orders here',
        state.ordersFilter === 'placed' ? 'New orders will pop up here automatically.' : 'Try a different filter.'
      );
    }
    return;
  }
  list.innerHTML = shown.map(orderCard).join('');
}

function searchMatch(o, q) {
  if (!q) return true;
  const hay = [shortId(o.id), o.id, o.customer_name, o.customer_phone].filter(Boolean).join(' ').toLowerCase();
  return hay.indexOf(String(q).toLowerCase()) !== -1;
}

async function onOrderClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id, action = btn.dataset.action;
  if (action === 'reject') { openRejectModal(id); return; }
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Working…';
  try {
    await api('/api/owner/orders/' + id + '/' + action, { method: 'PUT' });
    const labels = { accept: 'Order accepted', preparing: 'Order is being prepared', ready: 'Order marked ready' };
    toast(labels[action] || 'Done');
    await loadOrders(true);
  } catch (err) { toast(err.message, true); btn.disabled = false; btn.textContent = orig; }
}

function openRejectModal(id) {
  openModal('<h2>Reject order ' + esc(shortId(id)) + '?</h2>' +
    '<div class="field"><label for="rejReason">Reason <span style="font-weight:400;color:var(--muted)">(shared with the customer)</span></label>' +
    '<textarea id="rejReason" rows="3" placeholder="e.g. Item out of stock right now"></textarea></div>' +
    '<div class="btn-row"><button class="btn secondary" id="rejCancel" type="button">Keep order</button>' +
    '<button class="btn danger" id="rejConfirm" type="button">Reject order</button></div>');
  document.getElementById('rejCancel').onclick = closeModal;
  document.getElementById('rejConfirm').onclick = async e => {
    const b = e.target; b.disabled = true; b.textContent = 'Rejecting…';
    try {
      await api('/api/owner/orders/' + id + '/reject', {
        method: 'PUT', body: { reason: document.getElementById('rejReason').value.trim() || undefined }
      });
      closeModal(); toast('Order rejected'); await loadOrders(true);
    } catch (err) { toast(err.message, true); b.disabled = false; b.textContent = 'Reject order'; }
  };
}

/* ---------------- home dashboard ---------------- */
async function renderHome() {
  view.innerHTML =
    '<div class="screen-head"><h1>Today' + (state.restaurant ? ' · ' + esc(state.restaurant.name) : '') + '</h1>' +
    '<span class="live-dot"><i></i>Live · refreshes every 10s</span></div>' +
    '<div id="homeBody"><div class="stat-grid">' + skel(68) + skel(68) + skel(68) + '</div>' + skel(120) + skel(48) + '</div>';
  const ok = await loadOrders(true);
  if (!getToken()) return; // logged out during fetch
  if (!ok && !state.orders.length) {
    document.getElementById('homeBody').innerHTML =
      '<div class="error-box">Could not load today\u2019s orders. <button class="link-btn" id="homeRetry" type="button">Retry</button></div>';
    document.getElementById('homeRetry').onclick = renderHome;
    return;
  }
  paintHome();
  pollTimer = setInterval(async () => {
    const ok2 = await loadOrders(true);
    if (ok2 && getToken()) paintHome();
  }, 10000);
}

function paintHome() {
  const body = document.getElementById('homeBody');
  if (!body) return;
  const todayOrders = state.orders.filter(o => isToday(o.placed_at));
  const revenue = todayOrders.reduce((s, o) => s + (Number(o.total_paise) || 0), 0);
  const needAction = state.orders.filter(o => o.status === 'placed' || o.status === 'accepted');
  const agg = {};
  for (const o of todayOrders) {
    for (const it of (o.items || [])) {
      const name = it.name_snapshot || 'Item';
      agg[name] = (agg[name] || 0) + (Number(it.qty) || 0);
    }
  }
  const top = Object.keys(agg)
    .map(k => ({ name: k, qty: agg[k] }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 3);

  let html = '<div class="stat-grid">' +
    statCard(todayOrders.length, 'Orders today', '') +
    statCard(fmtRs(revenue), 'Revenue today', '') +
    statCard(needAction.length, 'Need action', needAction.length ? 'alert tap' : '', 'actionCard') +
    '</div>';

  html += '<div class="card"><h3 class="sec-title">Top selling today</h3>';
  if (!top.length) {
    html += '<div style="color:var(--muted);font-size:13.5px">No sales yet today. Your best sellers will appear here.</div>';
  } else {
    html += top.map((t, i) =>
      '<div class="top-item"><span><span class="rank">' + (i + 1) + '</span>' + esc(t.name) + '</span>' +
      '<strong>' + t.qty + ' sold</strong></div>'
    ).join('');
  }
  html += '</div>';

  html += '<div class="btn-row"><button class="btn" id="homeGoOrders" type="button">View all orders</button>' +
    '<button class="btn secondary" id="homeGoMenu" type="button">Manage menu</button></div>';

  body.innerHTML = html;
  const ac = document.getElementById('actionCard');
  if (ac) {
    const go = () => { location.hash = '#/app/orders'; };
    ac.addEventListener('click', go);
    ac.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  }
  document.getElementById('homeGoOrders').onclick = () => { location.hash = '#/app/orders'; };
  document.getElementById('homeGoMenu').onclick = () => { location.hash = '#/app/menu'; };
}

/* ---------------- menu ---------------- */
async function renderMenu() {
  view.innerHTML = '<div class="screen-head"><h1>Menu</h1>' +
    '<button class="btn small" id="addCatBtn" type="button">+ Category</button></div>' +
    '<div id="menuBody">' + skel(100) + skel(100) + skel(100) + '</div>';
  document.getElementById('addCatBtn').onclick = () => openCategoryModal(null);
  try {
    const [c, i] = await Promise.all([api('/api/owner/menu/categories'), api('/api/owner/menu/items')]);
    state.menuCats = c.categories || [];
    state.menuItems = i.items || [];
    paintMenu();
  } catch (e) {
    if (e.unauth) return;
    document.getElementById('menuBody').innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

function paintMenu() {
  const body = document.getElementById('menuBody');
  if (!body) return;
  const byCat = {};
  for (const it of state.menuItems) {
    const k = it.category_id || 'none';
    (byCat[k] = byCat[k] || []).push(it);
  }
  let html = '';
  for (const cat of state.menuCats) {
    const items = byCat[cat.id] || [];
    html += '<div class="cat-head"><h2>' + esc(cat.name) + ' <span style="color:var(--muted);font-weight:400;font-size:13px">(' + items.length + ')</span></h2>' +
      '<div class="cat-actions">' +
      '<button class="mini-btn" data-catact="additem" data-id="' + cat.id + '" type="button">+ Item</button>' +
      '<button class="mini-btn" data-catact="rename" data-id="' + cat.id + '" type="button">Rename</button>' +
      '<button class="mini-btn danger" data-catact="delcat" data-id="' + cat.id + '" type="button">Delete</button>' +
      '</div></div>';
    html += items.length ? items.map(menuItemCard).join('')
      : '<div class="card tight" style="color:var(--muted);font-size:13px">No items in this category yet.</div>';
  }
  const uncat = byCat.none || [];
  if (uncat.length) {
    html += '<div class="cat-head"><h2>Uncategorized <span style="color:var(--muted);font-weight:400;font-size:13px">(' + uncat.length + ')</span></h2></div>';
    html += uncat.map(menuItemCard).join('');
  }
  if (!state.menuCats.length && !uncat.length) {
    html = emptyHtml('Your menu is empty', 'Add a category, then add your dishes with prices.');
  } else if (!state.menuCats.length) {
    html = '<div class="notice-box">Add categories to organise your menu.</div>' + html;
  }
  body.innerHTML = html;
  body.querySelectorAll('[data-catact]').forEach(b => {
    b.addEventListener('click', () => onCatAction(b.dataset.catact, b.dataset.id));
  });
  body.querySelectorAll('[data-itemact]').forEach(b => {
    b.addEventListener('click', () => onItemAction(b.dataset.itemact, b.dataset.id));
  });
  body.querySelectorAll('.avail-toggle').forEach(t => {
    t.addEventListener('change', async () => {
      try {
        await api('/api/owner/menu/items/' + t.dataset.id, { method: 'PUT', body: { available: t.checked } });
        const it = state.menuItems.find(x => x.id === t.dataset.id);
        if (it) it.available = t.checked;
        toast(t.checked ? 'Item is now available' : 'Item marked unavailable');
        paintMenu();
      } catch (e) { toast(e.message, true); t.checked = !t.checked; }
    });
  });
}

function vegMark(veg) {
  return '<span class="veg-mark ' + (veg ? 'veg' : 'nonveg') + '" title="' + (veg ? 'Veg' : 'Non-veg') + '"><i></i></span>';
}

function menuItemCard(it) {
  return '<div class="card tight menu-item' + (it.available ? '' : ' unavailable') + '">' +
    (it.image_url ? '<img src="' + esc(it.image_url) + '" alt="" loading="lazy" onerror="this.remove()">' : '') +
    '<div class="mi-body"><div class="mi-name">' + vegMark(it.veg) + esc(it.name) +
    (it.available ? '' : ' <span class="unavail-tag">Unavailable</span>') + '</div>' +
    (it.description ? '<div class="mi-desc">' + esc(it.description) + '</div>' : '') +
    '<div class="mi-price">' + fmtRs(it.price_paise) + '</div></div>' +
    '<div class="item-actions" style="flex-direction:column">' +
    '<label class="switch" title="Available"><input type="checkbox" class="avail-toggle" data-id="' + it.id + '"' + (it.available ? ' checked' : '') + '><span class="track"></span></label>' +
    '<button class="mini-btn" data-itemact="edit" data-id="' + it.id + '" type="button">Edit</button>' +
    '<button class="mini-btn danger" data-itemact="del" data-id="' + it.id + '" type="button">Delete</button>' +
    '</div></div>';
}

function openCategoryModal(cat) {
  openModal('<h2>' + (cat ? 'Rename category' : 'New category') + '</h2>' +
    '<div class="field"><label for="catName">Category name</label>' +
    '<input id="catName" maxlength="60" value="' + esc(cat ? cat.name : '') + '" placeholder="e.g. Biryani, Starters"></div>' +
    '<div class="btn-row"><button class="btn secondary" id="catCancel" type="button">Cancel</button>' +
    '<button class="btn" id="catSave" type="button">Save</button></div>');
  const inp = document.getElementById('catName');
  inp.focus();
  document.getElementById('catCancel').onclick = closeModal;
  document.getElementById('catSave').onclick = async e => {
    const name = inp.value.trim();
    if (!name) { toast('Enter a category name', true); return; }
    const b = e.target; b.disabled = true;
    try {
      if (cat) {
        const d = await api('/api/owner/menu/categories/' + cat.id, { method: 'PUT', body: { name } });
        Object.assign(cat, d.category);
      } else {
        const d = await api('/api/owner/menu/categories', { method: 'POST', body: { name } });
        state.menuCats.push(d.category);
      }
      closeModal(); toast('Category saved'); paintMenu();
    } catch (err) { toast(err.message, true); b.disabled = false; }
  };
}

function onCatAction(act, id) {
  const cat = state.menuCats.find(c => c.id === id);
  if (act === 'rename') openCategoryModal(cat);
  else if (act === 'additem') openItemModal(null, id);
  else if (act === 'delcat') {
    if (!confirm('Delete category "' + (cat ? cat.name : '') + '"? Its items will become uncategorized.')) return;
    api('/api/owner/menu/categories/' + id, { method: 'DELETE' })
      .then(() => { state.menuCats = state.menuCats.filter(c => c.id !== id); toast('Category deleted'); paintMenu(); })
      .catch(e => toast(e.message, true));
  }
}

function onItemAction(act, id) {
  const it = state.menuItems.find(x => x.id === id);
  if (act === 'edit') openItemModal(it, null);
  else if (act === 'del') {
    if (!confirm('Delete "' + (it ? it.name : '') + '" from the menu?')) return;
    api('/api/owner/menu/items/' + id, { method: 'DELETE' })
      .then(() => { state.menuItems = state.menuItems.filter(x => x.id !== id); toast('Item deleted'); paintMenu(); })
      .catch(e => toast(e.message, true));
  }
}

function openItemModal(it, presetCatId) {
  const catOpts = '<option value="">No category</option>' + state.menuCats.map(c =>
    '<option value="' + c.id + '"' + ((it ? it.category_id : presetCatId) === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>'
  ).join('');
  openModal('<h2>' + (it ? 'Edit item' : 'New item') + '</h2>' +
    '<div class="field"><label for="itName">Item name *</label><input id="itName" maxlength="80" value="' + esc(it ? it.name : '') + '" placeholder="e.g. Chicken Dum Biryani"></div>' +
    '<div class="field-row"><div class="field"><label for="itPrice">Price (₹) *</label><input id="itPrice" inputmode="decimal" placeholder="e.g. 149" value="' + (it ? ((Number(it.price_paise) / 100).toString()) : '') + '"></div>' +
    '<div class="field"><label for="itCat">Category</label><select id="itCat">' + catOpts + '</select></div></div>' +
    '<div class="field"><label for="itDesc">Description</label><textarea id="itDesc" rows="2" maxlength="300" placeholder="Optional">' + esc(it && it.description ? it.description : '') + '</textarea></div>' +
    '<div class="field"><label for="itImg">Photo URL</label><input id="itImg" inputmode="url" maxlength="500" value="' + esc(it && it.image_url ? it.image_url : '') + '" placeholder="https://… (optional)"></div>' +
    '<div class="field"><label for="itPrep">Preparation time (minutes)</label><input id="itPrep" inputmode="numeric" value="' + (it && it.prep_minutes != null ? it.prep_minutes : 20) + '"></div>' +
    '<label class="check-row"><input type="checkbox" id="itVeg"' + (it && it.veg ? ' checked' : '') + '> Vegetarian</label>' +
    '<label class="check-row"><input type="checkbox" id="itAvail"' + (!it || it.available ? ' checked' : '') + '> Available for ordering</label>' +
    '<div class="btn-row"><button class="btn secondary" id="itCancel" type="button">Cancel</button>' +
    '<button class="btn" id="itSave" type="button">Save item</button></div>');
  document.getElementById('itCancel').onclick = closeModal;
  document.getElementById('itSave').onclick = async e => {
    const name = document.getElementById('itName').value.trim();
    const paise = rsToPaise(document.getElementById('itPrice').value);
    if (!name) { toast('Enter the item name', true); return; }
    if (paise == null) { toast('Enter a valid price in ₹', true); return; }
    const b = e.target; b.disabled = true;
    const body = {
      name,
      price_paise: paise,
      category_id: document.getElementById('itCat').value || null,
      description: document.getElementById('itDesc').value.trim() || null,
      image_url: document.getElementById('itImg').value.trim() || null,
      prep_minutes: Math.max(1, parseInt(document.getElementById('itPrep').value, 10) || 20),
      veg: document.getElementById('itVeg').checked,
      available: document.getElementById('itAvail').checked
    };
    try {
      if (it) {
        const d = await api('/api/owner/menu/items/' + it.id, { method: 'PUT', body });
        Object.assign(it, d.item);
      } else {
        const d = await api('/api/owner/menu/items', { method: 'POST', body });
        state.menuItems.push(d.item);
      }
      closeModal(); toast('Item saved'); paintMenu();
    } catch (err) { toast(err.message, true); b.disabled = false; }
  };
}

/* ---------------- profile ---------------- */
async function renderProfile() {
  const r = state.restaurant;
  view.innerHTML =
    '<div class="screen-head"><h1>Restaurant profile</h1></div>' +
    '<div class="card"><div class="toggle-row"><div><div class="t-label">Accepting orders</div>' +
    '<div class="t-sub">Turn off when the kitchen is closed</div></div>' +
    '<label class="switch"><input type="checkbox" id="profOpen"' + (r.is_open ? ' checked' : '') + '><span class="track"></span></label></div></div>' +
    '<div class="card"><form id="profForm">' +
    '<div class="field"><label>Restaurant name *</label><input name="name" required maxlength="80" value="' + esc(r.name) + '"></div>' +
    '<div class="field"><label>About</label><textarea name="description" rows="2" maxlength="500">' + esc(r.description || '') + '</textarea></div>' +
    '<div class="field"><label>Contact phone</label><input name="phone" inputmode="tel" maxlength="13" value="' + esc(r.phone || '') + '"></div>' +
    '<div class="field"><label>Address</label><input name="address" maxlength="200" value="' + esc(r.address || '') + '"></div>' +
    '<div class="field"><label>Photo URL</label><input name="image_url" inputmode="url" maxlength="500" value="' + esc(r.image_url || '') + '"></div>' +
    '<div class="field"><label>FSSAI license no.</label><input name="fssai" maxlength="30" value="' + esc(r.fssai || '') + '"></div>' +
    '<div class="field-row"><div class="field"><label>Opens at</label><input name="opens_at" type="time" value="' + esc(timeHM(r.opens_at)) + '"></div>' +
    '<div class="field"><label>Closes at</label><input name="closes_at" type="time" value="' + esc(timeHM(r.closes_at)) + '"></div></div>' +
    '<button class="btn" type="submit" id="profSave">Save changes</button></form></div>' +
    '<div class="card tight" style="color:var(--muted);font-size:13px">Status: <strong style="color:var(--green-700)">Approved</strong> · ' +
    'Commission ' + esc(r.commission_pct != null ? r.commission_pct + '%' : '—') + ' · Rating ' + esc(Number(r.rating_avg || 0).toFixed(1)) + '</div>';
  document.getElementById('profOpen').addEventListener('change', async e => {
    try {
      const d = await api('/api/owner/open', { method: 'PUT', body: { is_open: e.target.checked } });
      state.restaurant = d.restaurant; syncOpenToggle();
      toast(e.target.checked ? 'You are now OPEN for orders' : 'You are now CLOSED');
    } catch (err) { toast(err.message, true); e.target.checked = !e.target.checked; }
  });
  document.getElementById('profForm').addEventListener('submit', async e => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = document.getElementById('profSave');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const d1 = await api('/api/owner/restaurant', { method: 'PUT', body: {
        name: String(f.get('name')).trim(),
        description: String(f.get('description')).trim() || null,
        phone: String(f.get('phone')).trim() || null,
        address: String(f.get('address')).trim() || null,
        image_url: String(f.get('image_url')).trim() || null,
        fssai: String(f.get('fssai')).trim() || null
      }});
      const d2 = await api('/api/owner/hours', { method: 'PUT', body: {
        opens_at: f.get('opens_at') || null, closes_at: f.get('closes_at') || null
      }});
      state.restaurant = d2.restaurant || d1.restaurant;
      toast('Profile saved');
    } catch (err) { toast(err.message, true); }
    btn.disabled = false; btn.textContent = 'Save changes';
  });
}

/* ---------------- settlements ---------------- */
async function renderSettlements() {
  view.innerHTML = '<div class="screen-head"><h1>Payouts</h1></div><div id="settleBody">' + skel(160) + skel(160) + '</div>';
  const body = document.getElementById('settleBody');
  try {
    const data = await api('/api/owner/settlements');
    const list = data.settlements || [];
    if (!list.length) { body.innerHTML = emptyHtml('No payouts yet', 'Settlements appear here once the operations team processes them.'); return; }
    body.innerHTML = list.map(s =>
      '<div class="card"><div class="settle-top"><div class="settle-period">' +
      esc(fmtDate(s.period_start)) + ' → ' + esc(fmtDate(s.period_end)) + '</div>' +
      '<span class="pill ' + (s.status === 'paid' ? 'ready' : 'placed') + '">' + esc(s.status) + '</span></div>' +
      '<div style="margin-top:8px"><div class="money-row"><span>Order value</span><span>' + fmtRs(s.gross_paise) + '</span></div>' +
      '<div class="money-row"><span>Commission</span><span>− ' + fmtRs(s.commission_paise) + '</span></div>' +
      '<div class="money-row"><span>Refunds</span><span>− ' + fmtRs(s.refunds_paise) + '</span></div>' +
      '<div class="money-row net"><span>You receive</span><span>' + fmtRs(s.net_paise) + '</span></div></div>' +
      (s.paid_at ? '<div class="order-meta">Paid on ' + esc(fmtDT(s.paid_at)) + '</div>' : '') +
      '</div>'
    ).join('');
  } catch (e) {
    if (e.unauth) return;
    body.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

/* ---------------- ratings ---------------- */
function starsHtml(n) {
  n = Math.round(Number(n) || 0);
  let s = '';
  for (let i = 1; i <= 5; i++) s += '<span style="color:' + (i <= n ? '#f0a92e' : '#d8e0db') + '">★</span>';
  return '<span class="stars" style="letter-spacing:1px">' + s + '</span>';
}

async function renderRatings() {
  view.innerHTML = '<div class="screen-head"><h1>Ratings &amp; reviews</h1></div><div id="rateBody">' + skel(86) + skel(110) + skel(110) + '</div>';
  const body = document.getElementById('rateBody');
  try {
    const data = await api('/api/owner/ratings');
    const list = data.ratings || [];
    const food = list.map(r => r.food_rating).filter(v => v != null);
    const avg = food.length ? (food.reduce((a, b) => a + Number(b), 0) / food.length) : 0;
    let html = '<div class="card"><div class="rating-summary"><div class="big-rating">' + avg.toFixed(1) + '</div>' +
      '<div>' + starsHtml(avg) + '<div style="color:var(--muted);font-size:13px;margin-top:4px">' +
      food.length + ' food rating' + (food.length === 1 ? '' : 's') + '</div></div></div></div>';
    if (!list.length) {
      html += emptyHtml('No reviews yet', 'Customer reviews will show up here.');
    } else {
      html += '<div class="card">' + list.map(r =>
        '<div class="review"><div class="r-head"><span class="r-name">' + esc(r.rater_name || 'Customer') + '</span>' +
        '<span class="r-date">' + esc(fmtDT(r.created_at)) + '</span></div>' +
        '<div style="margin:4px 0">' + starsHtml(r.food_rating) + '</div>' +
        (r.comment ? '<div class="r-comment">' + esc(r.comment) + '</div>' : '') +
        '</div>'
      ).join('') + '</div>';
    }
    body.innerHTML = html;
  } catch (e) {
    if (e.unauth) return;
    body.innerHTML = '<div class="error-box">' + esc(e.message) + '</div>';
  }
}

/* ---------------- boot ---------------- */
window.addEventListener('hashchange', router);
if (!location.hash) location.hash = '#/login';
router();
