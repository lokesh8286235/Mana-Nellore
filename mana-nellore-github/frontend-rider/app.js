/* Mana Nellore Rider — static frontend, talks to live backend via fetch.
   Only /api/rider/... endpoints are used: a rider can only ever see their own data. */
'use strict';

const API = 'https://mana-nellore-mana-nellore.up.railway.app';
const TOKEN_KEY = 'mana_rider_token';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || null,
  rider: null,
  online: false,
  available: [],
  active: [],
  earnings: null,
  timers: [],
  lastLocAt: null,
  pickupPhotos: {}, // deliveryId -> dataURL (temp, per session)
  onboardPhotos: {}, // { aadhaar, profile } dataURLs for first-time KYC
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
  if (res.status === 401) { logout(); throw new Error('Session expired. Please log in again.'); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON */ }
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
};

/* ---------------- auth / session ---------------- */
function logout() {
  state.token = null;
  state.rider = null;
  state.online = false;
  state.available = [];
  state.active = [];
  state.pickupPhotos = {};
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
  return state.rider;
}

/* ---------------- routing ---------------- */
const routes = ['#/login', '#/approval', '#/home', '#/available', '#/active', '#/earnings'];
window.addEventListener('hashchange', route);

async function boot() {
  if (!state.token) { location.hash = '#/login'; route(); return; }
  try {
    const rider = await loadProfile();
    if (profileIncomplete(rider)) { location.hash = '#/onboarding'; }
    else if (rider.status === 'pending') { location.hash = '#/approval'; }
    else { location.hash = '#/home'; }
  } catch (e) {
    if (!state.token) return; // 401 already logged out via api()
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
  const h = location.hash || '#/login';
  if (!state.token && h !== '#/login') { location.hash = '#/login'; return; }
  if (h === '#/login') return renderLogin();
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
  if (h === '#/available') return renderAvailable();
  if (h === '#/active') return renderActive();
  if (h === '#/earnings') return renderEarnings();
  location.hash = '#/login';
}

function shell(content, activeTab) {
  const availN = state.available.length;
  const actN = state.active.length;
  return `
  <div class="topbar">
    <div class="brand"><span class="mark">${I.bike}</span><span>Mana Nellore<small>Rider</small></span></div>
    <div class="spacer"></div>
    <span class="pill ${state.online ? 'on' : 'off'}"><span class="dot"></span>${state.online ? 'Online' : 'Offline'}</span>
    <button class="iconbtn" id="btn-logout" title="Log out" aria-label="Log out">${I.out}</button>
  </div>
  <div class="page">${content}</div>
  <nav class="tabbar">
    <a class="tab ${activeTab === 'home' ? 'active' : ''}" href="#/home">${I.home}<span>Home</span></a>
    <a class="tab ${activeTab === 'available' ? 'active' : ''}" href="#/available">${I.box}<span>Available</span>${availN ? `<span class="badge">${availN}</span>` : ''}</a>
    <a class="tab ${activeTab === 'active' ? 'active' : ''}" href="#/active">${I.truck}<span>Active</span>${actN ? `<span class="badge">${actN}</span>` : ''}</a>
    <a class="tab ${activeTab === 'earnings' ? 'active' : ''}" href="#/earnings">${I.wallet}<span>Earnings</span></a>
  </nav>`;
}

function bindShell() {
  const b = $('#btn-logout');
  if (b) b.onclick = () => { if (confirm('Log out of Mana Nellore Rider?')) logout(); };
}

/* ================= LOGIN ================= */
function renderLogin() {
  $('#app').innerHTML = `
  <div class="authwrap">
    <div class="logo">${I.bike}</div>
    <h1>Mana Nellore Rider</h1>
    <p class="tag">Deliver food. Earn money.</p>
    <div id="login-err"></div>
    <div id="step-phone">
      <div class="field"><label for="phone">Mobile number</label>
        <div class="phonewrap"><span class="cc">+91</span>
        <input class="input" id="phone" inputmode="numeric" maxlength="10" placeholder="98765 43210" autocomplete="tel"></div>
      </div>
      <button class="btn" id="btn-send">Send OTP</button>
    </div>
    <div id="step-otp" style="display:none">
      <div class="field"><label for="rname">Your name</label>
        <input class="input" id="rname" placeholder="Full name" autocomplete="name"></div>
      <div class="field"><label for="otp">Enter OTP</label>
        <input class="input otp" id="otp" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="one-time-code"></div>
      <button class="btn" id="btn-verify">Verify &amp; Log in</button>
      <div style="height:10px"></div>
      <button class="btn ghost sm" id="btn-back">Change number</button>
    </div>
  </div>`;
  let phone = '';

  $('#btn-send').onclick = async () => {
    phone = $('#phone').value.replace(/\D/g, '');
    if (phone.length !== 10) { $('#login-err').innerHTML = '<div class="errbox">Enter a valid 10-digit mobile number.</div>'; return; }
    const btn = $('#btn-send');
    btn.disabled = true; btn.textContent = 'Sending…';
    $('#login-err').innerHTML = '';
    try {
      const data = await api('/api/auth/send-otp', { method: 'POST', body: { phone } });
      $('#step-phone').style.display = 'none';
      $('#step-otp').style.display = 'block';
      if (data.dev_code) {
        $('#otp').value = String(data.dev_code);
        toast('OTP auto-filled (test mode)', 'ok');
      } else {
        toast('OTP sent to +91 ' + phone, 'ok');
      }
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
      toast('Welcome, ' + name + '!', 'ok');
      boot();
    } catch (e) {
      $('#login-err').innerHTML = '<div class="errbox">' + esc(e.message) + '</div>';
      btn.disabled = false; btn.textContent = 'Verify & Log in';
    }
  };
}

/* ================= APPROVAL GATE ================= */
function renderApproval() {
  clearTimers();
  $('#app').innerHTML = `
  <div class="authwrap">
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
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const max = 1024;
      let w = img.width, h = img.height;
      if (Math.max(w, h) > max) {
        const k = max / Math.max(w, h);
        w = Math.round(w * k); h = Math.round(h * k);
      }
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => toast('Could not read that photo.', 'err');
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
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
      <div class="logo">${I.bike}</div>
      ${steps}
      ${body}
      <div style="height:14px"></div>
      <button class="btn ghost" id="ob-out">Log out</button>
    </div>`;
    $('#ob-out').onclick = () => logout();

    const nx = $('#ob-next');
    if (nx) nx.onclick = () => {
      readStep1();
      if (!draft.vno) { toast('Please enter your vehicle number.', 'err'); return; }
      if (!draft.lic) { toast('Please enter your driving licence number.', 'err'); return; }
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

/* ================= HOME ================= */
async function refreshActiveCount() {
  try {
    const data = await api('/api/rider/deliveries?status=active');
    state.active = data.deliveries || [];
  } catch (e) { /* non-fatal */ }
}

function renderHome() {
  clearTimers();
  const r = state.rider || {};
  $('#app').innerHTML = shell(`
    <h1>Namaste, ${esc(r.name || 'Rider')}</h1>
    <p class="sub">Tap the big button to start or stop receiving deliveries.</p>

    <button class="toggle-big ${state.online ? 'online' : ''}" id="btn-toggle" aria-pressed="${state.online}">
      <span class="tdot"></span>${state.online ? 'YOU ARE ONLINE' : 'GO ONLINE'}
    </button>

    <div class="card">
      <h2>Profile</h2>
      <div class="kv"><span class="k">Name</span><span class="v">${esc(r.name || '—')}</span></div>
      <div class="kv"><span class="k">Phone</span><span class="v">+91 ${esc(r.phone || '')}</span></div>
      <div class="kv"><span class="k">Vehicle</span><span class="v">${esc(r.vehicle_type || '—')}</span></div>
      <div class="kv"><span class="k">Status</span><span class="v" style="color:var(--mint-ink)">${esc(r.status || 'approved')}</span></div>
      <div style="height:12px"></div>
      <button class="btn ghost sm" id="btn-edit">Edit profile</button>
    </div>

    <div class="card">
      <h2>Location</h2>
      <p class="muted small" id="loc-line">Last updated: ${relTime(state.lastLocAt)}</p>
      <button class="btn ghost sm" id="btn-loc">${I.pin} Update location now</button>
      <p class="muted small" style="margin:10px 0 0">While you are online, your location is shared automatically every minute so orders near you can be assigned.</p>
    </div>

    <div class="card">
      <div class="row">
        <div class="grow"><div class="big">${state.active.length}</div><div class="muted small">Active deliveries</div></div>
        <div class="grow"><div class="big">${state.available.length}</div><div class="muted small">Available now</div></div>
      </div>
      <div style="height:12px"></div>
      <div class="btnrow">
        <a class="btn sm" href="#/available" style="text-decoration:none">View available</a>
        <a class="btn ghost sm" href="#/active" style="text-decoration:none">View active</a>
      </div>
    </div>
  `, 'home');
  bindShell();

  $('#btn-toggle').onclick = async () => {
    const btn = $('#btn-toggle');
    const want = !state.online;
    btn.disabled = true;
    try {
      const res = await api('/api/rider/online', { method: 'PUT', body: { online: want } });
      state.online = !!res.online;
      toast(want ? 'You are online. Deliveries incoming!' : 'You are offline.', want ? 'ok' : undefined);
      if (want) { await sendLocation(true); await pollAvailable(); }
      renderHome();
    } catch (e) {
      toast(e.message, 'err');
      btn.disabled = false;
    }
  };

  $('#btn-loc').onclick = () => sendLocation(true);
  $('#btn-edit').onclick = openProfileModal;

  // background work while on home
  if (state.online) {
    sendLocation(false);
    every(60000, () => { if (state.online) sendLocation(false); });
    pollAvailable();
    every(15000, () => { if (state.online) pollAvailable(); });
  }
  refreshActiveCount().then(() => { /* counts refresh on re-render */ });
}

function openProfileModal() {
  const r = state.rider || {};
  const back = document.createElement('div');
  back.className = 'modalback';
  back.innerHTML = `
    <div class="modal" role="dialog" aria-label="Edit profile">
      <h2>Edit profile</h2>
      <div class="kv"><span class="k">Name</span><span class="v">${esc(r.name || '—')}</span></div>
      <div class="kv"><span class="k">Phone</span><span class="v">+91 ${esc(r.phone || '')}</span></div>
      <div style="height:10px"></div>
      <div class="field"><label for="m-vehicle">Vehicle type</label>
        <select class="input" id="m-vehicle">
          ${['bike', 'scooter', 'bicycle', 'ev'].map(v => `<option value="${v}" ${r.vehicle_type === v ? 'selected' : ''}>${v[0].toUpperCase() + v.slice(1)}</option>`).join('')}
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
          vehicle_type: $('#m-vehicle', back).value,
          vehicle_number: $('#m-vehno', back).value.trim(),
          licence_no: $('#m-lic', back).value.trim(),
        },
      });
      const rider = data.rider || data;
      if (rider.user) {
        if (!rider.name) rider.name = rider.user.name;
        if (!rider.phone) rider.phone = rider.user.phone;
      }
      state.rider = rider;
      toast('Profile updated', 'ok');
      close();
      renderHome();
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
async function pollAvailable() {
  try {
    const data = await api('/api/rider/deliveries/available');
    state.available = data.deliveries || [];
    if ((location.hash || '') === '#/available') paintAvailableList();
    updateBadges();
  } catch (e) { /* transient; keep old list */ }
}

function availCard(d) {
  const rest = d.restaurant_name || 'Restaurant';
  const dist = d.distance_km;
  const placed = d.placed_at ? relTime(new Date(d.placed_at).getTime()) : '';
  return `
  <div class="dcard">
    <p class="rest">${esc(rest)}</p>
    ${d.address ? `<p class="addr">${I.pin} ${esc(d.address)}</p>` : ''}
    <div class="specs">
      <span class="spec">Order total <b>${fmtRs(d.total_paise)}</b></span>
      ${dist != null ? `<span class="spec"><b>${Number(dist).toFixed(1)} km</b> away</span>` : ''}
      ${placed ? `<span class="spec">${esc(placed)}</span>` : ''}
      <span class="spec muted">Payout decided at completion</span>
    </div>
    <button class="btn" data-accept="${esc(d.id)}">Accept delivery</button>
  </div>`;
}

function paintAvailableList() {
  const list = $('#avail-list');
  if (!list) return;
  if (!state.online) {
    list.innerHTML = `<div class="empty">${I.truck}<p>You are offline.<br>Go online from Home to see deliveries.</p></div>`;
    return;
  }
  if (!state.available.length) {
    list.innerHTML = `<div class="empty">${I.box}<p><b>No deliveries right now.</b></p><p>Stay online — new orders appear here automatically.</p></div>`;
    return;
  }
  list.innerHTML = state.available.map(availCard).join('');
  $$('#avail-list [data-accept]').forEach(btn => {
    btn.onclick = () => acceptDelivery(btn.getAttribute('data-accept'), btn);
  });
}

async function acceptDelivery(id, btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Accepting…';
  try {
    await api('/api/rider/deliveries/' + encodeURIComponent(id) + '/accept', { method: 'POST' });
    toast('Delivery accepted! Head to the restaurant.', 'ok');
    await refreshActiveCount();
    await pollAvailable();
    location.hash = '#/active';
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
    btn.textContent = old;
  }
}

function renderAvailable() {
  clearTimers();
  $('#app').innerHTML = shell(`
    <h1>Available deliveries</h1>
    <p class="sub">New orders near you appear here. First to accept gets it.</p>
    <div id="avail-err"></div>
    <div id="avail-list">${skel(176)}${skel(176)}</div>
  `, 'available');
  bindShell();

  const load = async () => {
    if (!state.online) { paintAvailableList(); return; }
    try { await pollAvailable(); }
    catch (e) {
      const box = $('#avail-err');
      if (box) box.innerHTML = '<div class="errbox">' + esc(e.message) + ' <a href="#/available">Retry</a></div>';
    }
    paintAvailableList();
  };
  load();
  every(15000, () => { if (state.online) pollAvailable(); });
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

function activeCard(d) {
  const id = d.id;
  const step = stepIndex(d);
  const rest = d.restaurant_name || 'Restaurant';
  const cust = d.customer_name || 'Customer';
  const cphone = d.customer_phone || '';
  const rphone = d.restaurant_phone || '';
  const addr = [d.addr_label, d.line1, d.line2, d.city].filter(Boolean).join(', ');
  const items = Array.isArray(d.items) ? d.items : [];
  const itemsTxt = items.map(it => `${it.qty || 1} × ${it.name_snapshot || 'item'}`).join(', ');

  let action = '';
  if (step === 0) {
    action = `<button class="btn green" data-reached="${esc(id)}">${I.flag} Reached restaurant</button>`;
  } else if (step === 1) {
    const photo = state.pickupPhotos[id];
    action = `
      <label class="photopick-label" for="photo-${esc(id)}">${I.camera} ${photo ? 'Retake pickup photo (required)' : 'Take pickup photo (required)'}</label>
      <input type="file" class="photopick" id="photo-${esc(id)}" accept="image/*" capture="camera" data-photo="${esc(id)}">
      ${photo ? `<img class="photo-preview" src="${photo}" alt="Pickup photo preview">` : ''}
      <button class="btn green" data-picked="${esc(id)}">${I.check} Picked up — head to customer</button>`;
  } else if (step === 2) {
    action = `<button class="btn green" data-arrived-cust="${esc(id)}">${I.flag} Reached customer</button>`;
  } else {
    action = `
      <div class="field"><label for="otp-${esc(id)}">Delivery OTP (ask the customer)</label>
      <input class="input otp" id="otp-${esc(id)}" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off"></div>
      <button class="btn" data-done="${esc(id)}">${I.check} Delivered</button>`;
  }

  return `
  <div class="dcard">
    <div class="stepbar" aria-hidden="true">
      <span class="step ${step >= 0 ? 'done' : ''}"></span>
      <span class="step ${step >= 1 ? 'done' : ''}"></span>
      <span class="step ${step >= 2 ? 'done' : ''}"></span>
      <span class="step ${step >= 3 ? 'done' : ''}"></span>
    </div>
    <p class="rest">${esc(rest)}</p>
    ${d.restaurant_address ? `<p class="addr">${I.pin} ${esc(d.restaurant_address)}</p>` : ''}
    ${itemsTxt ? `<p class="addr">${esc(itemsTxt)}</p>` : ''}
    <div class="hr"></div>
    <div class="kv"><span class="k">Deliver to</span><span class="v">${esc(cust)}</span></div>
    <div class="kv"><span class="k">Address</span><span class="v">${esc(addr || '—')}</span></div>
    ${cphone ? `<a class="callbtn" href="tel:${esc(String(cphone).replace(/\D/g, ''))}">${I.phone} Call customer</a>` : ''}
    ${rphone ? `<a class="callbtn" href="tel:${esc(String(rphone).replace(/\D/g, ''))}">${I.phone} Call restaurant</a>` : ''}
    <div class="hr"></div>
    <div class="kv"><span class="k">Order total</span><span class="v">${fmtRs(d.total_paise)}</span></div>
    <div class="kv"><span class="k">Your payout</span><span class="v muted">Decided at completion</span></div>
    <div style="height:14px"></div>
    ${action}
  </div>`;
}

function paintActiveList() {
  const list = $('#active-list');
  if (!list) return;
  if (!state.active.length) {
    list.innerHTML = `<div class="empty">${I.truck}<p><b>No active deliveries.</b></p><p>Accepted orders will show up here with step-by-step actions.</p></div>`;
    return;
  }
  list.innerHTML = state.active.map(activeCard).join('');

  $$('#active-list [data-reached]').forEach(btn => {
    btn.onclick = () => stepAction(btn.getAttribute('data-reached'), 'arrived-restaurant', undefined, btn, 'Marking reached…');
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
      stepAction(id, 'picked-up', { photo: state.pickupPhotos[id] }, btn, 'Confirming pickup…');
    };
  });
  $$('#active-list [data-arrived-cust]').forEach(btn => {
    btn.onclick = () => stepAction(btn.getAttribute('data-arrived-cust'), 'arrived-customer', undefined, btn, 'Marking reached…');
  });
  $$('#active-list [data-done]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.getAttribute('data-done');
      const otp = ($('#otp-' + CSS.escape(id)) || {}).value || '';
      if (!String(otp).trim()) { toast('Enter the delivery OTP from the customer.', 'err'); return; }
      stepAction(id, 'complete', { otp: String(otp).trim() }, btn, 'Completing…');
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
    await api('/api/rider/deliveries/' + encodeURIComponent(id) + cfg.suffix, { method: cfg.method, body });
    const msgs = {
      'arrived-restaurant': 'Marked reached. Pick up the order!',
      'picked-up': 'Picked up. Head to the customer!',
      'arrived-customer': 'Reached customer. Ask for the delivery OTP!',
      'complete': 'Delivered! Payout added to your earnings.',
    };
    toast(msgs[step] || 'Done', 'ok');
    delete state.pickupPhotos[id];
    await loadActive();
    paintActiveList();
    updateBadges();
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

function handlePhoto(id, file) {
  if (!file) return;
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
      state.pickupPhotos[id] = c.toDataURL('image/jpeg', 0.7);
      paintActiveList();
      toast('Photo attached', 'ok');
    };
    img.onerror = () => toast('Could not read that photo.', 'err');
    img.src = reader.result;
  };
  reader.onerror = () => toast('Could not read that photo.', 'err');
  reader.readAsDataURL(file);
}

function updateBadges() {
  const tabs = $$('.tabbar .tab');
  tabs.forEach(tab => {
    const old = tab.querySelector('.badge');
    if (old) old.remove();
    const label = (tab.querySelector('span:last-child') || {}).textContent || '';
    const n = label === 'Available' ? state.available.length : label === 'Active' ? state.active.length : 0;
    if (n > 0) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = n;
      tab.appendChild(b);
    }
  });
}

function renderActive() {
  clearTimers();
  $('#app').innerHTML = shell(`
    <h1>Active deliveries</h1>
    <p class="sub">Follow the steps for each order.</p>
    <div id="active-err"></div>
    <div id="active-list">${skel(210)}${skel(210)}</div>
  `, 'active');
  bindShell();
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

/* ================= EARNINGS ================= */
function renderEarnings() {
  clearTimers();
  $('#app').innerHTML = shell(`
    <h1>Earnings</h1>
    <p class="sub">Your payouts, day by day.</p>
    <div class="card">
      <div class="btnrow" style="margin-bottom:12px">
        <button class="btn ghost" id="preset-today">Today</button>
        <button class="btn ghost" id="preset-week">This week</button>
        <button class="btn ghost" id="preset-month">This month</button>
      </div>
      <div class="dates">
        <div class="field"><label for="from">From</label><input class="input" type="date" id="from" value="${monthStartISO()}"></div>
        <div class="field"><label for="to">To</label><input class="input" type="date" id="to" value="${todayISO()}"></div>
      </div>
      <button class="btn" id="btn-earn">Show earnings</button>
    </div>
    <div id="earn-err"></div>
    <div id="earn-body"><div class="empty">${I.wallet}<p>Pick a date range and tap <b>Show earnings</b>.</p></div></div>
  `, 'earnings');
  bindShell();

  const loadEarnings = async (from, to) => {
    const btn = $('#btn-earn');
    const body = $('#earn-body');
    const err = $('#earn-err');
    err.innerHTML = '';
    if (!from || !to) { err.innerHTML = '<div class="errbox">Pick both dates.</div>'; return; }
    if (from > to) { err.innerHTML = '<div class="errbox">"From" date cannot be after "To" date.</div>'; return; }
    btn.disabled = true; btn.textContent = 'Loading…';
    body.innerHTML = skel(92) + skel(64) + skel(64) + skel(64);
    try {
      const data = await api('/api/rider/earnings?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to));
      state.earnings = data;
      paintEarnings(data, from, to);
    } catch (e) {
      err.innerHTML = '<div class="errbox">' + esc(e.message) + '</div>';
      body.innerHTML = '';
    } finally {
      btn.disabled = false; btn.textContent = 'Show earnings';
    }
  };

  $('#btn-earn').onclick = () => loadEarnings($('#from').value, $('#to').value);
  $('#preset-today').onclick = () => {
    const t = todayISO();
    $('#from').value = t; $('#to').value = t;
    loadEarnings(t, t);
  };
  $('#preset-week').onclick = () => {
    const t = todayISO();
    const w = weekStartISO();
    $('#from').value = w; $('#to').value = t;
    loadEarnings(w, t);
  };
  $('#preset-month').onclick = () => {
    const m = monthStartISO(), t = todayISO();
    $('#from').value = m; $('#to').value = t;
    loadEarnings(m, t);
  };
  // Auto-load the current month on first visit.
  loadEarnings(monthStartISO(), todayISO());
  every(60000, () => { if (state.online) sendLocation(false); });
}

function weekStartISO() {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);
}

function paintEarnings(data, from, to) {
  const body = $('#earn-body');
  data = data || {};
  // Backend shape: { total_paise, trips, payouts: [{order_id, amount_paise, distance_km, created_at, order_total}] }
  const total = Number(data.total_paise || 0);
  const trips = Number(data.trips || 0);
  const list = Array.isArray(data.payouts) ? data.payouts : [];

  let html = `
    <div class="sumgrid">
      <div class="sumbox"><div class="v">${fmtRs(total)}</div><div class="l">Total earnings</div></div>
      <div class="sumbox"><div class="v">${trips}</div><div class="l">Deliveries</div></div>
    </div>`;
  if (!list.length) {
    html += `<div class="empty">${I.wallet}<p><b>No earnings</b> between ${esc(from)} and ${esc(to)}.</p></div>`;
  } else {
    html += '<div class="card" style="padding:6px 18px">' + list.map(p => {
      const when = p.created_at || '';
      const label = p.order_id ? ('Order #' + String(p.order_id).slice(0, 8)) : 'Delivery';
      const sub = [
        p.distance_km != null ? Number(p.distance_km).toFixed(1) + ' km' : null,
        p.order_total != null ? 'order ' + fmtRs(p.order_total) : null,
        when ? fmtDate(when) : null,
      ].filter(Boolean).join(' · ');
      return `<div class="earnrow">
        <div><div style="font-weight:700">${esc(label)}</div>
        ${sub ? `<div class="muted small">${esc(sub)}</div>` : ''}</div>
        <div class="amt">${fmtRs(p.amount_paise)}</div>
      </div>`;
    }).join('') + '</div>';
  }
  body.innerHTML = html;
}

/* ---------------- go ---------------- */
document.addEventListener('DOMContentLoaded', boot);
