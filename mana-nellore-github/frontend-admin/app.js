'use strict';
/* ============================================================
   Mana Nellore Ops — Admin / Operations Console
   Static frontend. All data comes live from the Railway API.
   ============================================================ */

var API_BASE = 'https://mana-nellore-mana-nellore.up.railway.app';
var TOKEN_KEY = 'mana_admin_token';

/* ---------------- utils ---------------- */

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function rupees(paise) {
  var n = Number(paise);
  if (paise == null || paise === '' || !isFinite(n)) return '—';
  return '₹' + (n / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function prettyNum(v) {
  if (typeof v === 'number' && isFinite(v)) return v.toLocaleString('en-IN');
  return v == null || v === '' ? '—' : esc(v);
}

function prettyLabel(k) {
  return String(k).replace(/_x100$|_paise$/, '').replace(/_/g, ' ')
    .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function shortId(id) {
  var s = String(id == null ? '' : id);
  return s.length > 12 ? s.slice(0, 8) + '…' : s;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return esc(iso);
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function pillClass(s) {
  s = String(s || '').toLowerCase();
  if (['approved', 'active', 'delivered', 'paid', 'resolved', 'success', 'completed'].indexOf(s) >= 0) return 'green';
  if (['pending', 'placed', 'accepted', 'preparing', 'open', 'processing', 'in_progress', 'partial'].indexOf(s) >= 0) return 'amber';
  if (['ready', 'assigned', 'picked_up', 'on_way', 'on_the_way', 'out_for_delivery', 'in_transit'].indexOf(s) >= 0) return 'blue';
  if (['rejected', 'cancelled', 'canceled', 'suspended', 'failed', 'expired', 'inactive'].indexOf(s) >= 0) return 'red';
  return 'slate';
}

function pill(status) {
  return '<span class="pill ' + pillClass(status) + '">' + esc(status || '—') + '</span>';
}

var toastTimer = null;
function toast(msg, type) {
  var t = $('toast');
  t.textContent = msg;
  t.className = 'toast show ' + (type || 'info');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.className = 'toast hidden'; }, 3200);
}

/* ---------------- API ---------------- */

function api(path, opts) {
  opts = opts || {};
  var headers = { 'Content-Type': 'application/json' };
  if (opts.headers) {
    for (var k in opts.headers) headers[k] = opts.headers[k];
  }
  var token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* storage unavailable */ }
  if (token) headers['Authorization'] = 'Bearer ' + token;

  var req = { method: opts.method || 'GET', headers: headers };
  if (opts.body !== undefined) req.body = opts.body;

  return fetch(API_BASE + path, req).then(function (res) {
    if (res.status === 401) {
      return res.json().catch(function () { return null; }).then(function (data) {
        var msg = (data && (data.error || data.message)) || 'Session expired. Please sign in again.';
        var err = new Error(msg);
        err.unauthorized = true;
        showLogin();
        throw err;
      });
    }
    return res.json().catch(function () { return null; }).then(function (data) {
      if (!res.ok) {
        var msg = (data && (data.error || data.message)) || ('Request failed (HTTP ' + res.status + ')');
        throw new Error(msg);
      }
      return data || {};
    });
  }, function () {
    throw new Error('Network error — could not reach the API server.');
  });
}

function handleErr(e) {
  if (e && e.unauthorized) return; // login screen already shown
  toast((e && e.message) ? e.message : 'Something went wrong', 'error');
}

/* ---------------- shared HTML builders ---------------- */

function skel(h) {
  return '<div class="skel" style="height:' + (h || 120) + 'px;margin-bottom:12px"></div>';
}

// Content-shaped skeleton placeholder: 'cards', 'table', 'detail', 'form', 'spot'.
function skelShape(shape, n) {
  shape = shape || 'table';
  var i, out;
  if (shape === 'cards') {
    out = '<div class="stat-grid">';
    for (i = 0; i < (n || 8); i++) {
      out += '<div class="stat-card"><div class="skel" style="height:11px;width:62%;margin-bottom:10px"></div>' +
        '<div class="skel" style="height:26px;width:44%;margin-bottom:0"></div></div>';
    }
    return out + '</div>';
  }
  if (shape === 'detail') {
    out = '';
    for (i = 0; i < (n || 8); i++) {
      out += '<div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:14px">' +
        '<div class="skel" style="height:13px;width:34%;margin-bottom:0"></div>' +
        '<div class="skel" style="height:13px;width:56%;margin-bottom:0"></div></div>';
    }
    return out;
  }
  if (shape === 'form') {
    out = '<div class="card">';
    for (i = 0; i < (n || 5); i++) {
      out += '<div class="skel" style="height:13px;width:28%;margin-bottom:8px"></div>' +
        '<div class="skel" style="height:38px;margin-bottom:16px"></div>';
    }
    return out + '</div>';
  }
  if (shape === 'spot') {
    out = '';
    for (i = 0; i < (n || 4); i++) {
      out += '<div class="card" style="display:flex;gap:14px;align-items:center;margin-bottom:12px">' +
        '<div class="skel" style="height:52px;width:52px;border-radius:50%;margin-bottom:0;flex-shrink:0"></div>' +
        '<div style="flex:1;min-width:0">' +
          '<div class="skel" style="height:15px;width:45%;margin-bottom:8px"></div>' +
          '<div class="skel" style="height:12px;width:70%;margin-bottom:0"></div>' +
        '</div>' +
        '<div class="skel" style="height:20px;width:52px;margin-bottom:0;flex-shrink:0"></div></div>';
    }
    return out;
  }
  // 'table' (default): matches the .table-wrap look with skeleton rows.
  out = '<div class="table-wrap"><div style="padding:14px 12px 4px">';
  for (i = 0; i < (n || 6); i++) {
    out += '<div class="skel" style="height:18px;margin-bottom:10px"></div>';
  }
  return out + '</div></div>';
}

function loadingHtml(msg, shape, count) {
  return '<div class="loading-wrap"><p class="loading-msg">' + esc(msg || 'Loading…') + '</p>' +
    skelShape(shape || 'table', count) + '</div>';
}

function errorHtml(msg, screenId) {
  return '<div class="state"><p>' + esc(msg || 'Could not load data.') + '</p>' +
    '<button class="btn" data-action="retry" data-screen="' + esc(screenId) + '">Retry</button></div>';
}

function tableHtml(heads, rowsHtml) {
  var body = rowsHtml
    ? rowsHtml
    : '<tr><td class="empty" colspan="' + heads.length + '">No records found.</td></tr>';
  return '<div class="table-wrap"><table class="tbl"><thead><tr>' +
    heads.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
    '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

function filterSelect(filterKey, screenId, options, current) {
  var opts = options.map(function (o) {
    return '<option value="' + esc(o[0]) + '"' + (o[0] === current ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
  }).join('');
  return '<select data-filter="' + esc(filterKey) + '" data-screen="' + esc(screenId) + '">' + opts + '</select>';
}

/* ---------------- icons / nav ---------------- */

function svg(paths) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
}

var I = {
  dashboard: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  store: svg('<path d="M4 8l1.2-4.5h13.6L20 8"/><path d="M4 8h16"/><path d="M6 8v12h12V8"/><path d="M9.5 12h5"/>'),
  bike: svg('<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17l4-7h5l3 7"/><path d="M10 10l1.5-4H15"/>'),
  users: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.4 3.4-5.5 6.5-5.5s5.7 2.1 6.5 5.5"/><circle cx="17" cy="9" r="2.6"/><path d="M16.5 14.6c2.6.6 4.4 2.7 5 5.4"/>'),
  receipt: svg('<path d="M6 3h12v18l-2-1.6-2 1.6-2-1.6L10 21l-2-1.6L6 21z"/><path d="M9.5 8h5M9.5 12h5"/>'),
  tag: svg('<path d="M3.5 12V4.5A1 1 0 0 1 4.5 3.5H12l8.5 8.5-7.5 7.5z"/><circle cx="8.5" cy="8.5" r="1.4"/>'),
  coupon: svg('<path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a2.5 2.5 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a2.5 2.5 0 0 0 0-6z"/><path d="M13 5v2M13 11v2M13 17v2"/>'),
  wallet: svg('<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10.5h18"/><path d="M7 15h4"/>'),
  refund: svg('<path d="M3.5 12a8.5 8.5 0 1 0 2.5-6"/><path d="M3.5 3.5V8H8"/>'),
  chat: svg('<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.4 0-2.8-.3-4-.9L3 20.5l1.6-4.6A8.5 8.5 0 1 1 21 11.5z"/>'),
  chart: svg('<path d="M3 21h18"/><path d="M6.5 21v-7M11 21V5M15.5 21v-10M20 21v-4"/>'),
  list: svg('<path d="M8.5 6h12M8.5 12h12M8.5 18h12"/><circle cx="4" cy="6" r="1.2"/><circle cx="4" cy="12" r="1.2"/><circle cx="4" cy="18" r="1.2"/>'),
  star: svg('<path d="M12 2.8l2.8 6 6.4.7-4.8 4.4 1.3 6.3L12 16.9l-5.7 3.3 1.3-6.3L2.8 9.5l6.4-.7z"/>'),
  crown: svg('<path d="M3 8.5l4.3 3.8L12 4.5l4.7 7.8L21 8.5 19.2 19H4.8z"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3.2 2"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>')
};

var NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: I.dashboard },
  { id: 'restaurants', label: 'Restaurants', icon: I.store },
  { id: 'riders', label: 'Riders', icon: I.bike },
  { id: 'spotlight', label: 'Spotlight', icon: I.star },
  { id: 'customers', label: 'Customers', icon: I.users },
  { id: 'orders', label: 'Orders', icon: I.receipt },
  { id: 'pricing', label: 'Pricing', icon: I.tag },
  { id: 'promise', label: 'Promise', icon: I.clock },
  { id: 'coupons', label: 'Coupons', icon: I.coupon },
  { id: 'settlements', label: 'Settlements', icon: I.wallet },
  { id: 'refunds', label: 'Refunds', icon: I.refund },
  { id: 'tickets', label: 'Support tickets', icon: I.chat },
  { id: 'reports', label: 'Reports', icon: I.chart },
  { id: 'audit', label: 'Audit logs', icon: I.list }
];

/* ---------------- state ---------------- */

var currentScreen = 'dashboard';
var filters = {
  restaurants: '', riders: '', orders: '',
  settlementsRestaurant: '',
  tickets: '', ticketCategory: '', reportFrom: '', reportTo: ''
};
var cache = { tickets: [], coupons: [] };

/* ---------------- views ---------------- */

function showLogin() {
  $('app-view').classList.add('hidden');
  $('login-view').classList.remove('hidden');
  closeDrawer();
  closeSidebar();
}

function showApp() {
  $('login-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
}

function buildNav() {
  $('nav').innerHTML = NAV.map(function (n) {
    return '<button class="nav-btn" data-screen="' + esc(n.id) + '">' + n.icon +
      '<span>' + esc(n.label) + '</span></button>';
  }).join('');
  $('nav').addEventListener('click', function (e) {
    var btn = e.target.closest('.nav-btn');
    if (btn) navigate(btn.dataset.screen);
  });
}

function navigate(id) {
  currentScreen = id;
  var btns = document.querySelectorAll('.nav-btn');
  for (var i = 0; i < btns.length; i++) {
    btns[i].classList.toggle('active', btns[i].dataset.screen === id);
  }
  var meta = null;
  for (var j = 0; j < NAV.length; j++) { if (NAV[j].id === id) meta = NAV[j]; }
  $('screen-title').textContent = meta ? meta.label : id;
  closeDrawer();
  closeSidebar();
  RENDER[id]();
}

/* ---------------- drawer ---------------- */

function openDrawer(html) {
  $('drawer').innerHTML = html;
  $('drawer').classList.remove('hidden');
  $('drawer-scrim').classList.remove('hidden');
}

function closeDrawer() {
  $('drawer').classList.add('hidden');
  $('drawer-scrim').classList.add('hidden');
  $('drawer').innerHTML = '';
}

function drawerShell(title, bodyHtml) {
  return '<div class="drawer-head"><h3>' + esc(title) + '</h3>' +
    '<button class="drawer-close" data-action="close-drawer" aria-label="Close">' + I.x + '</button></div>' +
    '<div class="drawer-body">' + bodyHtml + '</div>';
}

/* ---------------- sidebar (mobile) ---------------- */

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-scrim').classList.add('hidden');
}

/* ============================================================
   SCREENS
   ============================================================ */

/* ---------- Dashboard ---------- */

function renderDashboard() {
  $('screen').innerHTML = loadingHtml('Loading dashboard…', 'cards', 11);
  api('/api/admin/dashboard').then(function (data) {
    // Backend shape: { orders_today, sales_today_paise, active_orders, online_riders,
    //   cancellations_today, refunds_today: {count, total_paise}, open_tickets,
    //   contribution_today_paise, restaurants, riders, customers }
    data = data || {};
    var refunds = data.refunds_today || {};
    var cards = [
      ['Orders today', prettyNum(data.orders_today)],
      ['Sales today', rupees(data.sales_today_paise)],
      ['Active orders', prettyNum(data.active_orders)],
      ['Riders online', prettyNum(data.online_riders)],
      ['Cancellations today', prettyNum(data.cancellations_today)],
      ['Refunds today', prettyNum(refunds.count) + ' · ' + rupees(refunds.total_paise)],
      ['Open tickets', prettyNum(data.open_tickets)],
      ['Contribution today', rupees(data.contribution_today_paise)],
      ['Restaurants', prettyNum(data.restaurants)],
      ['Riders', prettyNum(data.riders)],
      ['Customers', prettyNum(data.customers)]
    ];
    $('screen').innerHTML = '<div class="stat-grid">' + cards.map(function (c) {
      return '<div class="stat-card"><div class="stat-label">' + esc(c[0]) +
        '</div><div class="stat-value">' + c[1] + '</div></div>';
    }).join('') + '</div>';
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('screen').innerHTML = errorHtml('Could not load the dashboard.', 'dashboard');
  });
}

/* ---------- Restaurants ---------- */

function renderRestaurants() {
  $('screen').innerHTML = loadingHtml('Loading restaurants…', 'table');
  var f = filters.restaurants;
  var path = '/api/admin/restaurants' + (f ? '?status=' + encodeURIComponent(f) : '');
  api(path).then(function (data) {
    var list = data.restaurants || [];
    var toolbar = '<div class="toolbar">' +
      filterSelect('restaurants', 'restaurants',
        [['', 'All statuses'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['suspended', 'Suspended']], f) +
      '</div>';
    var rows = list.map(function (r) {
      var actions = [];
      if (String(r.status).toLowerCase() === 'pending') {
        actions.push('<button class="btn btn-sm btn-primary" data-action="approve-restaurant" data-id="' + esc(r.id) + '">Approve</button>');
        actions.push('<button class="btn btn-sm" data-action="reject-restaurant" data-id="' + esc(r.id) + '">Reject</button>');
      } else if (String(r.status).toLowerCase() === 'approved' || String(r.status).toLowerCase() === 'active') {
        actions.push('<button class="btn btn-sm btn-danger" data-action="suspend-restaurant" data-id="' + esc(r.id) + '">Suspend</button>');
      }
      return '<tr><td><strong>' + esc(r.name || '—') + '</strong><br /><span class="id-mono">' + esc(shortId(r.id)) + '</span></td>' +
        '<td>' + esc(r.owner_name || '') + '<br />' + esc(r.owner_phone || '') + '</td>' +
        '<td>' + esc(r.address || '—') + '</td>' +
        '<td>' + esc(r.rating_avg != null ? Number(r.rating_avg).toFixed(1) : '—') + '</td>' +
        '<td>' + pill(r.status) + '</td>' +
        '<td><div class="row-actions">' +
        '<button class="btn btn-sm" data-action="view-restaurant" data-id="' + esc(r.id) + '">View</button>' +
        actions.join('') + '</div></td></tr>';
    }).join('');
    $('screen').innerHTML = toolbar +
      tableHtml(['Restaurant', 'Owner', 'Address', 'Rating', 'Status', 'Actions'], rows);
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('screen').innerHTML = errorHtml('Could not load restaurants.', 'restaurants');
  });
}

function setRestaurantStatus(id, status, verb) {
  if (!confirm(verb + ' this restaurant?')) return;
  api('/api/admin/restaurants/' + id + '/status', { method: 'PUT', body: JSON.stringify({ status: status }) }).then(function () {
    toast('Restaurant ' + status, 'success');
    renderRestaurants();
  }).catch(handleErr);
}

function approveRestaurant(id) { setRestaurantStatus(id, 'approved', 'Approve'); }
function rejectRestaurant(id) { setRestaurantStatus(id, 'rejected', 'Reject'); }
function suspendRestaurant(id) { setRestaurantStatus(id, 'suspended', 'Suspend'); }

function openRestaurantDrawer(id) {
  openDrawer(drawerShell('Restaurant', loadingHtml('Loading restaurant…', 'detail')));
  api('/api/admin/restaurants/' + id).then(function (data) {
    var r = data.restaurant || {};
    var st = String(r.status || '').toLowerCase();
    var menu = Number(r.category_count) + ' categories · ' + Number(r.item_count) + ' items';
    var acts = '';
    if (st === 'pending') {
      acts = '<div class="drawer-actions">' +
        '<button class="btn btn-sm btn-primary" data-action="approve-restaurant-d" data-id="' + esc(r.id) + '">Approve</button>' +
        '<button class="btn btn-sm" data-action="reject-restaurant-d" data-id="' + esc(r.id) + '">Reject</button></div>';
    } else if (st === 'approved' || st === 'active') {
      acts = '<div class="drawer-actions">' +
        '<button class="btn btn-sm btn-danger" data-action="suspend-restaurant-d" data-id="' + esc(r.id) + '">Suspend</button></div>';
    }
    openDrawer(drawerShell('Restaurant — ' + (r.name || 'restaurant'),
      '<dl class="kv">' +
      '<dt>Name</dt><dd>' + esc(r.name || '—') + '</dd>' +
      '<dt>Status</dt><dd>' + pill(r.status) + '</dd>' +
      '<dt>Phone</dt><dd>' + esc(r.phone || '—') + '</dd>' +
      '<dt>Address</dt><dd>' + esc(r.address || '—') + '</dd>' +
      '<dt>FSSAI</dt><dd>' + esc(r.fssai || '—') + '</dd>' +
      '<dt>Rating</dt><dd>' + esc(r.rating_avg != null ? Number(r.rating_avg).toFixed(1) : '—') + '</dd>' +
      '<dt>Commission</dt><dd>' + esc(r.commission_pct != null ? Number(r.commission_pct) + '%' : '—') + '</dd>' +
      '<dt>Total orders</dt><dd>' + prettyNum(Number(r.total_orders)) + '</dd>' +
      '<dt>Menu</dt><dd>' + esc(menu) + '</dd>' +
      '<dt>Owner</dt><dd>' + esc(r.owner_name || '—') + ' ' + esc(r.owner_phone || '') + '</dd>' +
      '<dt>Open</dt><dd>' + esc(r.is_open ? 'Yes' : 'No') +
        (r.opens_at ? ' · ' + esc(String(r.opens_at).slice(0, 5)) : '') +
        (r.closes_at ? ' – ' + esc(String(r.closes_at).slice(0, 5)) : '') + '</dd>' +
      '<dt>Joined</dt><dd>' + esc(fmtDateTime(r.created_at)) + '</dd>' +
      '</dl>' +
      (r.description ? '<h3 class="section-title">About</h3><p>' + esc(r.description) + '</p>' : '') +
      acts));
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) openDrawer(drawerShell('Restaurant', errorHtml('Could not load restaurant.', 'restaurants')));
  });
}

function setRestaurantStatusFromDrawer(id, status, verb) {
  if (!confirm(verb + ' this restaurant?')) return;
  api('/api/admin/restaurants/' + id + '/status', { method: 'PUT', body: JSON.stringify({ status: status }) }).then(function () {
    toast('Restaurant ' + status, 'success');
    openRestaurantDrawer(id);
    if (currentScreen === 'restaurants') renderRestaurants();
  }).catch(handleErr);
}

/* ---------- Riders ---------- */

function renderRiders() {
  $('screen').innerHTML = loadingHtml('Loading riders…', 'table');
  var f = filters.riders;
  var path = '/api/admin/riders' + (f ? '?status=' + encodeURIComponent(f) : '');
  api(path).then(function (data) {
    var list = data.riders || [];
    var toolbar = '<div class="toolbar">' +
      filterSelect('riders', 'riders',
        [['', 'All statuses'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['suspended', 'Suspended']], f) +
      '</div>';
    var rows = list.map(function (r) {
      var actions = [];
      actions.push('<button class="btn btn-sm" data-action="rider-kyc" data-id="' + esc(r.id) + '">KYC</button>');
      if (String(r.status).toLowerCase() === 'pending') {
        actions.push('<button class="btn btn-sm btn-primary" data-action="approve-rider" data-id="' + esc(r.id) + '">Approve</button>');
        actions.push('<button class="btn btn-sm" data-action="reject-rider" data-id="' + esc(r.id) + '">Reject</button>');
      } else if (String(r.status).toLowerCase() === 'approved' || String(r.status).toLowerCase() === 'active') {
        actions.push('<button class="btn btn-sm btn-danger" data-action="suspend-rider" data-id="' + esc(r.id) + '">Suspend</button>');
      }
      return '<tr><td><strong>' + esc(r.name || '—') + '</strong><br /><span class="id-mono">' + esc(shortId(r.id)) + '</span></td>' +
        '<td>' + esc(r.phone || '') + '</td>' +
        '<td>' + esc(r.vehicle || r.vehicle_type || '') + '</td>' +
        '<td>' + esc(r.rating_avg != null ? Number(r.rating_avg).toFixed(1) : '—') + '</td>' +
        '<td>' + pill(r.status) + '</td>' +
        '<td><div class="row-actions">' + actions.join('') + '</div></td></tr>';
    }).join('');
    $('screen').innerHTML = toolbar +
      tableHtml(['Rider', 'Phone', 'Vehicle', 'Rating', 'Status', 'Actions'], rows);
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('screen').innerHTML = errorHtml('Could not load riders.', 'riders');
  });
}

function setRiderStatus(id, status, verb) {
  if (!confirm(verb + ' this rider?')) return;
  api('/api/admin/riders/' + id + '/status', { method: 'PUT', body: JSON.stringify({ status: status }) }).then(function () {
    toast('Rider ' + status, 'success');
    renderRiders();
  }).catch(handleErr);
}

function approveRider(id) { setRiderStatus(id, 'approved', 'Approve'); }
function rejectRider(id) { setRiderStatus(id, 'rejected', 'Reject'); }
function suspendRider(id) { setRiderStatus(id, 'suspended', 'Suspend'); }

function openRiderKyc(id) {
  openDrawer(drawerShell('Rider KYC', loadingHtml('Loading documents…', 'detail')));
  api('/api/admin/riders').then(function (data) {
    var r = (data.riders || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!r) { openDrawer(drawerShell('Rider KYC', errorHtml('Rider not found.', 'riders'))); return; }
    var st = String(r.status || '').toLowerCase();
    function doc(label, src) {
      return '<div class="kyc-doc"><div class="kyc-doc-label">' + esc(label) + '</div>' +
        (src ? '<img class="kyc-doc-img" src="' + esc(src) + '" alt="' + esc(label) + '">' :
          '<div class="kyc-doc-none">Not provided</div>') + '</div>';
    }
    var acts = '';
    if (st === 'pending') {
      acts = '<div class="drawer-actions">' +
        '<button class="btn btn-sm btn-primary" data-action="approve-rider-kyc" data-id="' + esc(r.id) + '">Approve</button>' +
        '<button class="btn btn-sm" data-action="reject-rider-kyc" data-id="' + esc(r.id) + '">Reject</button></div>';
    }
    openDrawer(drawerShell('Rider KYC — ' + (r.name || 'rider'),
      '<dl class="kv">' +
      '<dt>Name</dt><dd>' + esc(r.name || '—') + '</dd>' +
      '<dt>Phone</dt><dd>+' + esc(r.phone || '') + '</dd>' +
      '<dt>Status</dt><dd>' + pill(r.status) + '</dd>' +
      '<dt>Vehicle type</dt><dd>' + esc(r.vehicle_type || '—') + '</dd>' +
      '<dt>Vehicle number</dt><dd>' + esc(r.vehicle_number || '—') + '</dd>' +
      '<dt>Licence no.</dt><dd>' + esc(r.licence_no || '—') + '</dd>' +
      '<dt>Aadhaar no.</dt><dd>' + esc(r.aadhaar_no || '—') + '</dd>' +
      '</dl>' +
      doc('Aadhaar card photo', r.aadhaar_photo) +
      doc('Rider photo', r.profile_photo) +
      acts));
  }).catch(handleErr);
}

/* ---------- Customers ---------- */

function renderCustomers() {
  $('screen').innerHTML = loadingHtml('Loading customers…', 'table');
  api('/api/admin/customers').then(function (data) {
    var list = data.customers || [];
    var rows = list.map(function (c) {
      return '<tr><td class="id-mono">' + esc(shortId(c.id)) + '</td>' +
        '<td>' + esc(c.name || '—') + '</td>' +
        '<td>' + esc(c.phone || '') + '</td>' +
        '<td>' + prettyNum(c.total_orders != null ? Number(c.total_orders) : null) + '</td>' +
        '<td>' + rupees(c.lifetime_paise) + '</td>' +
        '<td>' + esc(fmtDateTime(c.created_at)) + '</td></tr>';
    }).join('');
    $('screen').innerHTML = tableHtml(['ID', 'Name', 'Phone', 'Orders', 'Lifetime spend', 'Joined'], rows);
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('screen').innerHTML = errorHtml('Could not load customers.', 'customers');
  });
}

/* ---------- Orders ---------- */

function renderOrders() {
  $('screen').innerHTML = loadingHtml('Loading orders…', 'table');
  var f = filters.orders;
  var path = '/api/admin/orders' + (f ? '?status=' + encodeURIComponent(f) : '');
  api(path).then(function (data) {
    var list = data.orders || [];
    var toolbar = '<div class="toolbar">' +
      filterSelect('orders', 'orders',
        [['', 'All statuses'], ['placed', 'Placed'], ['accepted', 'Accepted'], ['preparing', 'Preparing'],
         ['ready', 'Ready'], ['picked_up', 'Picked up'], ['on_way', 'On the way'],
         ['delivered', 'Delivered'], ['cancelled', 'Cancelled']], f) +
      '</div>';
    var rows = list.map(function (o) {
      return '<tr><td class="id-mono">' + esc(shortId(o.id)) + '</td>' +
        '<td>' + esc(o.customer_name || '') + '<br />' + esc(o.customer_phone || '') + '</td>' +
        '<td>' + esc(o.restaurant_name || '') + '</td>' +
        '<td>' + rupees(o.total_paise) + '</td>' +
        '<td>' + pill(o.status) + '</td>' +
        '<td>' + pill(o.payment_status) + '</td>' +
        '<td>' + esc(fmtDateTime(o.placed_at)) + '</td>' +
        '<td><button class="btn btn-sm" data-action="view-order" data-id="' + esc(o.id) + '">View</button></td></tr>';
    }).join('');
    $('screen').innerHTML = toolbar +
      tableHtml(['Order', 'Customer', 'Restaurant', 'Total', 'Status', 'Payment', 'Placed', ''], rows);
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('screen').innerHTML = errorHtml('Could not load orders.', 'orders');
  });
}

function openOrderDrawer(id) {
  openDrawer(drawerShell('Order ' + shortId(id), loadingHtml('Loading order…', 'detail')));
  api('/api/admin/orders/' + id).then(function (data) {
    // Backend shape: { order: { ...o, items: [{name_snapshot, qty, unit_price_paise}], timeline: [{status, at, by}] } }
    var o = data.order || {};
    var items = Array.isArray(o.items) ? o.items : [];
    var timeline = Array.isArray(o.timeline) ? o.timeline : [];
    var itemRows = items.map(function (it) {
      return '<tr><td>' + esc(it.name_snapshot || '—') + '</td>' +
        '<td>' + prettyNum(it.qty != null ? Number(it.qty) : null) + '</td>' +
        '<td>' + rupees(it.unit_price_paise) + '</td></tr>';
    }).join('');
    var tl = timeline.map(function (t) {
      return '<li><strong>' + esc(t.status || '') + '</strong><br />' +
        '<span class="t-time">' + esc(fmtDateTime(t.at)) + (t.by ? ' · by ' + esc(t.by) : '') + '</span></li>';
    }).join('');
    var addr = [o.line1, o.line2, o.city].filter(Boolean).join(', ');
    var body =
      '<dl class="kv">' +
      '<dt>Order ID</dt><dd class="id-mono">' + esc(o.id || id) + '</dd>' +
      '<dt>Status</dt><dd>' + pill(o.status) + '</dd>' +
      '<dt>Customer</dt><dd>' + esc(o.customer_name || '') + ' ' + esc(o.customer_phone || '') + '</dd>' +
      '<dt>Restaurant</dt><dd>' + esc(o.restaurant_name || '') + '</dd>' +
      '<dt>Rider</dt><dd>' + esc(o.rider_name || 'Unassigned') + ' ' + esc(o.rider_phone || '') + '</dd>' +
      '<dt>Total</dt><dd><strong>' + rupees(o.total_paise) + '</strong></dd>' +
      '<dt>Delivery fee</dt><dd>' + rupees(o.delivery_fee_paise) + '</dd>' +
      '<dt>Promised by</dt><dd>' + esc(fmtDateTime(o.promised_at)) + '</dd>' +
      '<dt>Payment</dt><dd>' + esc(o.payment_method || '') + ' · ' + esc(o.payment_status || '') + '</dd>' +
      '<dt>Address</dt><dd>' + esc(addr || '—') + '</dd>' +
      '</dl>' +
      '<h3 class="section-title">Items</h3>' + tableHtml(['Item', 'Qty', 'Price'], itemRows) +
      '<h3 class="section-title">Timeline</h3>' +
      (tl ? '<ul class="timeline">' + tl + '</ul>' : '<p class="empty">No timeline events.</p>') +
      '<h3 class="section-title">Assign rider</h3>' +
      '<div class="toolbar"><select id="assign-rider-id" style="max-width:260px"><option value="">Loading riders…</option></select>' +
      '<button class="btn btn-primary" data-action="assign-rider" data-id="' + esc(o.id || id) + '">Assign</button></div>' +
      '<h3 class="section-title">Danger zone</h3>' +
      '<button class="btn btn-danger" data-action="cancel-order" data-id="' + esc(o.id || id) + '">Cancel order</button>';
    openDrawer(drawerShell('Order ' + shortId(id), body));
    // Populate the rider dropdown with approved riders (online first).
    api('/api/admin/riders?status=approved').then(function (data) {
      var sel = $('assign-rider-id');
      if (!sel) return; // drawer was closed before riders loaded
      var riders = data.riders || [];
      riders.sort(function (a, b) { return (b.online ? 1 : 0) - (a.online ? 1 : 0); });
      if (!riders.length) {
        sel.innerHTML = '<option value="">No approved riders</option>';
        return;
      }
      sel.innerHTML = '<option value="">Select a rider…</option>' + riders.map(function (r) {
        var label = (r.name || r.phone || 'Rider') + ' (' + (r.phone || '—') + ')' +
          (r.online ? ' — online' : ' — offline');
        return '<option value="' + esc(r.id) + '">' + esc(label) + '</option>';
      }).join('');
    }).catch(function () {
      var sel = $('assign-rider-id');
      if (sel) sel.innerHTML = '<option value="">Could not load riders</option>';
    });
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) openDrawer(drawerShell('Order ' + shortId(id), '<div class="state"><p>Could not load order.</p></div>'));
  });
}

function assignRider(orderId) {
  var input = $('assign-rider-id');
  var riderId = input ? input.value.trim() : '';
  if (!riderId) { toast('Select a rider', 'error'); return; }
  api('/api/admin/orders/' + orderId + '/assign-rider', { method: 'POST', body: JSON.stringify({ rider_id: riderId }) }).then(function () {
    toast('Rider assigned', 'success');
    openOrderDrawer(orderId);
    if (currentScreen === 'orders') renderOrders();
  }).catch(handleErr);
}

function cancelOrder(orderId) {
  var reason = prompt('Reason for cancelling this order:');
  if (reason === null) return;
  if (!reason.trim()) { toast('A reason is required', 'error'); return; }
  if (!confirm('Cancel this order? This cannot be undone.')) return;
  api('/api/admin/orders/' + orderId + '/cancel', { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) }).then(function (data) {
    toast('Order cancelled' + (data && data.refunded ? ' — payment refunded' : ''), 'success');
    openOrderDrawer(orderId);
    if (currentScreen === 'orders') renderOrders();
  }).catch(handleErr);
}

/* ---------- Pricing ---------- */

/* Backend: GET /api/admin/pricing -> { pricing: { key: value } } (an OBJECT).
   PUT /api/admin/pricing { key, value } where value is raw JSON.
   Keys ending in _paise are paise numbers; the three tier/rule keys are objects. */
var PRICING_KEYS = [
  { key: 'delivery_tiers', label: 'Delivery fee tiers', type: 'json' },
  { key: 'rider_payout_tiers', label: 'Rider payout tiers', type: 'json' },
  { key: 'platform_fee_paise', label: 'Platform fee', type: 'rupee' },
  { key: 'default_commission_pct', label: 'Default commission %', type: 'number' },
  { key: 'free_delivery_rules', label: 'Free delivery rules', type: 'json' },
  { key: 'promise_minutes', label: 'Delivery promise (minutes)', type: 'number' },
  { key: 'apology_credit_paise', label: 'Apology credit (late / cold food)', type: 'rupee' }
];

function pricingMeta(key) {
  for (var i = 0; i < PRICING_KEYS.length; i++) {
    if (PRICING_KEYS[i].key === key) return PRICING_KEYS[i];
  }
  return { key: key, label: prettyLabel(key), type: 'number' };
}

function renderPricing() {
  $('screen').innerHTML = loadingHtml('Loading pricing…', 'form');
  Promise.all([
    api('/api/admin/pricing'),
    api('/api/admin/zones').catch(function () { return { zones: [] }; })
  ]).then(function (results) {
    var data = results[0] || {};
    var zones = (results[1] && results[1].zones) || [];
    var pricing = data.pricing || {};
    var rows = PRICING_KEYS.map(function (meta) {
      var key = meta.key;
      var value = pricing[key];
      var display, editor;
      if (meta.type === 'json') {
        display = '<pre class="jsonview">' + esc(JSON.stringify(value == null ? {} : value, null, 2)) + '</pre>';
        editor = '<textarea id="price-input-' + esc(key) + '" class="jsonedit" rows="5">' +
          esc(JSON.stringify(value == null ? {} : value, null, 2)) + '</textarea>';
      } else if (meta.type === 'rupee') {
        display = '<strong>' + rupees(typeof value === 'number' ? value : null) + '</strong>';
        editor = '<div style="display:flex;gap:6px;align-items:center">' +
          '<input id="price-input-' + esc(key) + '" value="' + esc(typeof value === 'number' ? (value / 100) : '') + '" inputmode="decimal" style="max-width:140px" />' +
          '<span style="color:var(--muted);font-size:12px">₹</span></div>';
      } else {
        display = '<strong>' + esc(value == null ? '—' : value) + '</strong>';
        editor = '<input id="price-input-' + esc(key) + '" value="' + esc(value == null ? '' : value) + '" inputmode="decimal" style="max-width:140px" />';
      }
      return '<tr><td><strong>' + esc(meta.label) + '</strong><br /><span class="id-mono">' + esc(key) + '</span></td>' +
        '<td>' + display + '</td>' +
        '<td>' + editor + '</td>' +
        '<td><button class="btn btn-sm btn-primary" data-action="save-price" data-key="' + esc(key) + '">Save</button></td></tr>';
    }).join('');
    $('screen').innerHTML =
      '<p style="color:var(--muted);margin:0 0 14px">Changes apply immediately to all new orders across customer, restaurant and rider apps.</p>' +
      tableHtml(['Setting', 'Current value', 'New value', ''], rows) +
      '<h3 class="section-title">Delivery zones</h3>' +
      zonesCardHtml(zones);
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('screen').innerHTML = errorHtml('Could not load pricing.', 'pricing');
  });
}

/* ---------- Delivery zones ---------- */

/* Backend:
   GET    /api/admin/zones        -> { zones: [{id, name, promise_minutes, is_default, created_at}] }
   POST   /api/admin/zones        { name, promise_minutes } -> { zone }
   PUT    /api/admin/zones/:id    { name?, promise_minutes?, is_default? } -> { zone }
   DELETE /api/admin/zones/:id    -> { ok: true } */
function zonesCardHtml(zones) {
  var rows = zones.map(function (z) {
    var actions =
      '<button class="btn btn-sm" data-action="zone-save" data-id="' + esc(z.id) + '">Save</button>' +
      (z.is_default ? '' : ' <button class="btn btn-sm" data-action="zone-default" data-id="' + esc(z.id) + '">Set default</button>') +
      ' <button class="btn btn-sm btn-danger" data-action="zone-delete" data-id="' + esc(z.id) + '">Delete</button>';
    return '<tr><td><strong>' + esc(z.name || '—') + '</strong> ' +
      (z.is_default ? pill('default') : '') + '</td>' +
      '<td><input id="zone-min-' + esc(z.id) + '" value="' + esc(z.promise_minutes == null ? '' : z.promise_minutes) + '" inputmode="numeric" style="max-width:90px" /> min</td>' +
      '<td><div class="row-actions">' + actions + '</div></td></tr>';
  }).join('');
  return '<div class="card"><h3>Zones</h3>' +
    (zones.length
      ? tableHtml(['Zone', 'Promise minutes', ''], rows)
      : '<p style="color:var(--muted)">No zones yet. Add the first one below.</p>') +
    '<h4 style="margin:18px 0 10px;font-size:13.5px">Add zone</h4>' +
    '<div class="form-grid" style="max-width:520px">' +
      '<label class="field" style="margin:0"><span>Zone name</span><input id="zone-name" placeholder="e.g. Nellore Central" /></label>' +
      '<label class="field" style="margin:0"><span>Promise minutes</span><input id="zone-minutes" inputmode="numeric" placeholder="30" /></label>' +
    '</div>' +
    '<div class="form-actions"><button class="btn btn-primary" data-action="zone-add">Add zone</button></div></div>';
}

function zoneAdd() {
  var name = ($('zone-name') || {}).value || '';
  var mins = ($('zone-minutes') || {}).value || '';
  name = name.trim();
  var promiseMinutes = Number(mins);
  if (!name) { toast('Enter a zone name', 'error'); return; }
  if (mins === '' || !isFinite(promiseMinutes) || promiseMinutes <= 0) { toast('Enter valid promise minutes', 'error'); return; }
  api('/api/admin/zones', { method: 'POST', body: JSON.stringify({ name: name, promise_minutes: promiseMinutes }) }).then(function () {
    toast('Zone added', 'success');
    renderPricing();
  }).catch(handleErr);
}

function zoneSave(id) {
  var input = $('zone-min-' + id);
  var mins = input ? input.value.trim() : '';
  var promiseMinutes = Number(mins);
  if (mins === '' || !isFinite(promiseMinutes) || promiseMinutes <= 0) { toast('Enter valid promise minutes', 'error'); return; }
  api('/api/admin/zones/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ promise_minutes: promiseMinutes }) }).then(function () {
    toast('Zone updated', 'success');
    renderPricing();
  }).catch(handleErr);
}

function zoneSetDefault(id) {
  if (!confirm('Make this the default zone?')) return;
  api('/api/admin/zones/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ is_default: true }) }).then(function () {
    toast('Default zone updated', 'success');
    renderPricing();
  }).catch(handleErr);
}

function zoneDelete(id) {
  if (!confirm('Delete this zone? Orders referencing it will lose the zone link.')) return;
  api('/api/admin/zones/' + encodeURIComponent(id), { method: 'DELETE' }).then(function () {
    toast('Zone deleted', 'success');
    renderPricing();
  }).catch(handleErr);
}

function savePrice(key) {
  var input = $('price-input-' + key);
  if (!input) return;
  var meta = pricingMeta(key);
  var raw = input.value.trim();
  var value;
  if (meta.type === 'json') {
    try {
      value = JSON.parse(raw);
    } catch (e) {
      toast('Invalid JSON: ' + e.message, 'error');
      return;
    }
  } else if (meta.type === 'rupee') {
    if (raw === '' || isNaN(Number(raw))) { toast('Enter a valid ₹ amount', 'error'); return; }
    value = Math.round(Number(raw) * 100); // ₹ -> paise
  } else {
    if (raw === '' || isNaN(Number(raw))) { toast('Enter a valid number', 'error'); return; }
    value = Number(raw);
  }
  if (!confirm('Update "' + meta.label + '"? Changes apply to new orders instantly.')) return;
  api('/api/admin/pricing', { method: 'PUT', body: JSON.stringify({ key: key, value: value }) }).then(function () {
    toast('Pricing updated', 'success');
    renderPricing();
  }).catch(handleErr);
}

/* ---------- Coupons ---------- */

function couponValueDisplay(c) {
  var t = String(c.discount_type || '').toLowerCase();
  if (t === 'percent') return esc(c.value) + '%';
  return rupees(c.value); // flat coupons store value in paise
}

function renderCoupons() {
  $('screen').innerHTML = loadingHtml('Loading coupons…', 'table');
  api('/api/admin/coupons').then(function (data) {
    var list = data.coupons || [];
    cache.coupons = list;
    var form =
      '<div class="card"><h3>Create coupon</h3><form id="coupon-form">' +
      '<div class="form-grid">' +
      '<label class="field"><span>Code</span><input id="coupon-code" required style="text-transform:uppercase" /></label>' +
      '<label class="field"><span>Discount type</span><select id="coupon-dtype"><option value="flat">Flat (₹ off)</option><option value="percent">Percent (% off)</option></select></label>' +
      '<label class="field"><span>Value (₹ for flat, % for percent)</span><input id="coupon-value" inputmode="decimal" required /></label>' +
      '<label class="field"><span>Min order (₹, optional)</span><input id="coupon-min" inputmode="decimal" /></label>' +
      '<label class="field"><span>Max discount (₹, optional)</span><input id="coupon-maxd" inputmode="decimal" /></label>' +
      '<label class="field"><span>Valid from (optional)</span><input id="coupon-from" type="date" /></label>' +
      '<label class="field"><span>Valid to (optional)</span><input id="coupon-to" type="date" /></label>' +
      '</div><div class="form-actions"><button type="submit" class="btn btn-primary">Create coupon</button></div>' +
      '</form></div>';
    var rows = list.map(function (c) {
      var active = c.active !== false && c.active !== 0;
      return '<tr><td><strong>' + esc(c.code) + '</strong></td>' +
        '<td>' + esc(c.discount_type) + '</td>' +
        '<td>' + couponValueDisplay(c) + '</td>' +
        '<td>' + (c.min_order_paise ? rupees(c.min_order_paise) : '—') + '</td>' +
        '<td>' + (c.max_discount_paise != null ? rupees(c.max_discount_paise) : '—') + '</td>' +
        '<td>' + esc(fmtDateTime(c.valid_from)) + ' → ' + esc(fmtDateTime(c.valid_to)) + '</td>' +
        '<td>' + pill(active ? 'active' : 'inactive') + '</td>' +
        '<td><div class="row-actions">' +
        '<button class="btn btn-sm" data-action="coupon-edit" data-id="' + esc(c.id) + '">Edit</button>' +
        '<button class="btn btn-sm' + (active ? '' : ' btn-primary') + '" data-action="coupon-toggle" data-id="' + esc(c.id) + '" data-active="' + (active ? '0' : '1') + '">' +
        (active ? 'Deactivate' : 'Activate') + '</button></div></td></tr>';
    }).join('');
    $('screen').innerHTML = form +
      tableHtml(['Code', 'Type', 'Value', 'Min order', 'Max discount', 'Valid', 'Status', ''], rows);
    $('coupon-form').addEventListener('submit', createCoupon);
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('screen').innerHTML = errorHtml('Could not load coupons.', 'coupons');
  });
}

function createCoupon(e) {
  e.preventDefault();
  var code = $('coupon-code').value.trim().toUpperCase();
  var dtype = $('coupon-dtype').value;
  var rawVal = $('coupon-value').value.trim();
  var rawMin = $('coupon-min').value.trim();
  var rawMaxD = $('coupon-maxd').value.trim();
  var from = $('coupon-from').value;
  var to = $('coupon-to').value;
  if (!code || rawVal === '' || isNaN(Number(rawVal))) { toast('Enter a valid code and value', 'error'); return; }
  var body = {
    code: code,
    discount_type: dtype,
    value: dtype === 'flat' ? Math.round(Number(rawVal) * 100) : Number(rawVal) // flat = paise, percent = plain %
  };
  if (rawMin !== '' && !isNaN(Number(rawMin))) body.min_order_paise = Math.round(Number(rawMin) * 100);
  if (rawMaxD !== '' && !isNaN(Number(rawMaxD))) body.max_discount_paise = Math.round(Number(rawMaxD) * 100);
  if (from) body.valid_from = from;
  if (to) body.valid_to = to;
  api('/api/admin/coupons', { method: 'POST', body: JSON.stringify(body) }).then(function () {
    toast('Coupon created', 'success');
    renderCoupons();
  }).catch(handleErr);
}

function editCoupon(id) {
  var c = null;
  for (var i = 0; i < (cache.coupons || []).length; i++) {
    if (String(cache.coupons[i].id) === String(id)) c = cache.coupons[i];
  }
  if (!c) { toast('Coupon not found', 'error'); return; }
  var isFlat = String(c.discount_type).toLowerCase() !== 'percent';
  var body =
    '<div class="field"><label>Code</label><input id="ce-code" value="' + esc(c.code) + '" style="text-transform:uppercase" /></div>' +
    '<div class="field"><label>Discount type</label><select id="ce-dtype">' +
    '<option value="flat"' + (isFlat ? ' selected' : '') + '>Flat (₹ off)</option>' +
    '<option value="percent"' + (!isFlat ? ' selected' : '') + '>Percent (% off)</option></select></div>' +
    '<div class="field"><label>Value (' + (isFlat ? '₹' : '%') + ')</label>' +
    '<input id="ce-value" inputmode="decimal" value="' + esc(isFlat ? (Number(c.value) / 100) : c.value) + '" /></div>' +
    '<label class="field" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="ce-active"' + (c.active !== false && c.active !== 0 ? ' checked' : '') + ' style="width:auto" /><span>Active</span></label>' +
    '<div class="form-actions"><button class="btn btn-primary" data-action="coupon-save" data-id="' + esc(c.id) + '">Save changes</button></div>';
  openDrawer(drawerShell('Edit coupon ' + c.code, body));
}

function saveCouponEdit(id) {
  var code = $('ce-code').value.trim().toUpperCase();
  var dtype = $('ce-dtype').value;
  var rawVal = $('ce-value').value.trim();
  var active = $('ce-active').checked;
  if (!code || rawVal === '' || isNaN(Number(rawVal))) { toast('Enter a valid code and value', 'error'); return; }
  var body = {
    code: code,
    discount_type: dtype,
    value: dtype === 'flat' ? Math.round(Number(rawVal) * 100) : Number(rawVal),
    active: active
  };
  api('/api/admin/coupons/' + id, { method: 'PUT', body: JSON.stringify(body) }).then(function () {
    toast('Coupon updated', 'success');
    closeDrawer();
    renderCoupons();
  }).catch(handleErr);
}

function toggleCoupon(id, activate) {
  var toActive = activate === '1';
  if (!toActive && !confirm('Deactivate this coupon?')) return;
  api('/api/admin/coupons/' + id, { method: 'PUT', body: JSON.stringify({ active: toActive }) }).then(function () {
    toast(toActive ? 'Coupon activated' : 'Coupon deactivated', 'success');
    renderCoupons();
  }).catch(handleErr);
}

/* ---------- Settlements ---------- */

function renderSettlements() {
  $('screen').innerHTML = loadingHtml('Loading settlements…', 'table');
  var rid = (filters.settlementsRestaurant || '').trim();
  var path = '/api/admin/settlements' + (rid ? '?restaurant_id=' + encodeURIComponent(rid) : '');
  api(path).then(function (data) {
    var list = data.settlements || [];
    var form =
      '<div class="card"><h3>Generate settlement</h3><form id="sett-form">' +
      '<div class="form-grid">' +
      '<label class="field"><span>Restaurant ID</span><input id="sett-rid" required placeholder="Restaurant UUID" /></label>' +
      '<label class="field"><span>Period start</span><input id="sett-from" type="date" required /></label>' +
      '<label class="field"><span>Period end</span><input id="sett-to" type="date" required /></label>' +
      '</div><div class="form-actions"><button type="submit" class="btn btn-primary">Generate settlement</button></div>' +
      '</form></div>';
    var toolbar = '<div class="toolbar">' +
      '<input id="sett-filter-rid" placeholder="Filter by restaurant ID (optional)" value="' + esc(rid) + '" style="max-width:280px" />' +
      '<button class="btn" data-action="sett-filter">Filter</button>' +
      (rid ? '<button class="btn ghost" data-action="sett-clear">Clear</button>' : '') +
      '</div>';
    var rows = list.map(function (st) {
      var isPaid = String(st.status).toLowerCase() === 'paid';
      return '<tr><td class="id-mono">' + esc(shortId(st.id)) + '</td>' +
        '<td>' + esc(st.restaurant_name || '') + '</td>' +
        '<td>' + esc(fmtDate(st.period_start)) + ' → ' + esc(fmtDate(st.period_end)) + '</td>' +
        '<td>' + rupees(st.gross_paise) + '</td>' +
        '<td>' + rupees(st.commission_paise) + '</td>' +
        '<td>' + rupees(st.refunds_paise) + '</td>' +
        '<td><strong>' + rupees(st.net_paise) + '</strong></td>' +
        '<td>' + pill(st.status) + '</td>' +
        '<td>' + esc(fmtDateTime(st.paid_at)) + '</td>' +
        '<td>' + (isPaid ? '' : '<button class="btn btn-sm btn-primary" data-action="settlement-pay" data-id="' + esc(st.id) + '">Mark paid</button>') + '</td></tr>';
    }).join('');
    $('screen').innerHTML = form + toolbar +
      tableHtml(['ID', 'Restaurant', 'Period', 'Gross', 'Commission', 'Refunds', 'Net', 'Status', 'Paid at', ''], rows);
    $('sett-form').addEventListener('submit', generateSettlement);
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('screen').innerHTML = errorHtml('Could not load settlements.', 'settlements');
  });
}

function generateSettlement(e) {
  e.preventDefault();
  var rid = $('sett-rid').value.trim();
  var from = $('sett-from').value, to = $('sett-to').value;
  if (!rid || !from || !to) { toast('Fill all fields', 'error'); return; }
  if (from > to) { toast('Period start cannot be after period end', 'error'); return; }
  if (!confirm('Generate settlement for this restaurant and period?')) return;
  api('/api/admin/settlements', {
    method: 'POST',
    body: JSON.stringify({ restaurant_id: rid, period_start: from, period_end: to })
  }).then(function (data) {
    var s = data.settlement || {};
    toast('Settlement generated — net ' + rupees(s.net_paise), 'success');
    filters.settlementsRestaurant = rid;
    renderSettlements();
  }).catch(handleErr);
}

function markSettlementPaid(id) {
  if (!confirm('Mark this settlement as paid?')) return;
  api('/api/admin/settlements/' + id + '/pay', { method: 'POST' }).then(function () {
    toast('Settlement marked as paid', 'success');
    renderSettlements();
  }).catch(handleErr);
}

/* ---------- Refunds ---------- */

/* Backend has ONLY POST /api/admin/refunds { order_id, reason } -> { ok, refunded_paise }.
   The refund always covers the full paid order amount. */
function renderRefunds() {
  $('screen').innerHTML =
    '<div class="card"><h3>Issue refund</h3><form id="refund-form">' +
    '<div class="form-grid">' +
    '<label class="field"><span>Order ID</span><input id="refund-order" required placeholder="Order UUID" /></label>' +
    '<label class="field"><span>Reason</span><input id="refund-reason" required placeholder="Why is this being refunded?" /></label>' +
    '</div><div class="form-actions"><button type="submit" class="btn btn-primary">Issue refund</button></div>' +
    '</form><div id="refund-result" style="margin-top:14px"></div></div>' +
    '<p style="color:var(--muted)">Refunds apply to the full paid order amount. Only orders with payment status "paid" can be refunded.</p>';
  $('refund-form').addEventListener('submit', createRefund);
}

function createRefund(e) {
  e.preventDefault();
  var orderId = $('refund-order').value.trim();
  var reason = $('refund-reason').value.trim();
  if (!orderId || !reason) { toast('Enter the order ID and a reason', 'error'); return; }
  if (!confirm('Issue a full refund for this order?')) return;
  api('/api/admin/refunds', {
    method: 'POST',
    body: JSON.stringify({ order_id: orderId, reason: reason })
  }).then(function (data) {
    $('refund-result').innerHTML = '<div class="okbox">Refund issued: <strong>' +
      rupees(data.refunded_paise) + '</strong></div>';
    toast('Refund issued', 'success');
  }).catch(handleErr);
}

/* ---------- Support tickets ---------- */

function renderTickets() {
  $('screen').innerHTML = loadingHtml('Loading tickets…', 'table');
  var f = filters.tickets;
  var cat = filters.ticketCategory;
  var path = '/api/admin/tickets' + (f ? '?status=' + encodeURIComponent(f) : '');
  if (cat) path += (f ? '&' : '?') + 'category=' + encodeURIComponent(cat);
  api(path).then(function (data) {
    var list = data.tickets || [];
    cache.tickets = list;
    var toolbar = '<div class="toolbar">' +
      filterSelect('tickets', 'tickets',
        [['', 'All statuses'], ['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed']], f) +
      '<button class="btn btn-sm' + (cat === '' ? ' btn-primary' : '') + '" data-action="ticket-cat" data-cat="">All tickets</button>' +
      '<button class="btn btn-sm' + (cat === 'cold_food' ? ' btn-primary' : '') + '" data-action="ticket-cat" data-cat="cold_food">Cold food</button>' +
      '</div>';
    var rows = list.map(function (t) {
      return '<tr><td class="id-mono">' + esc(shortId(t.id)) + '</td>' +
        '<td><strong>' + esc(t.subject || t.title || '—') + '</strong></td>' +
        '<td>' + esc(t.customer_name || t.customer || t.user_name || '') + '</td>' +
        '<td>' + pill(t.status) + '</td>' +
        '<td>' + esc(fmtDateTime(t.updated_at || t.created_at)) + '</td>' +
        '<td><button class="btn btn-sm" data-action="ticket-view" data-id="' + esc(t.id) + '">Open</button></td></tr>';
    }).join('');
    if (!rows) {
      rows = '<tr><td class="empty" colspan="6">' +
        (cat === 'cold_food' ? 'No cold-food complaints.' : 'No tickets found.') + '</td></tr>';
    }
    $('screen').innerHTML = toolbar +
      tableHtml(['Ticket', 'Subject', 'Customer', 'Status', 'Updated', ''], rows);
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('screen').innerHTML = errorHtml('Could not load tickets.', 'tickets');
  });
}

/* Backend: PUT /api/admin/tickets/:id { status } — status ONLY, one of
   open | in_progress | resolved | closed. There is no reply endpoint. */
function openTicketDrawer(id) {
  // There is no ticket-detail endpoint; use the row cached from the list.
  var cached = null;
  for (var i = 0; i < cache.tickets.length; i++) {
    if (String(cache.tickets[i].id) === String(id)) cached = cache.tickets[i];
  }
  if (!cached) { toast('Ticket not found', 'error'); return; }
  renderTicketDrawer(cached);
}

function renderTicketDrawer(t) {
  var st = String(t.status || 'open');
  var body =
    '<dl class="kv">' +
    '<dt>Ticket</dt><dd class="id-mono">' + esc(t.id) + '</dd>' +
    '<dt>Subject</dt><dd>' + esc(t.subject || '—') + '</dd>' +
    '<dt>Message</dt><dd>' + esc(t.message || '—') + '</dd>' +
    '<dt>Category</dt><dd>' + esc(t.category || '—') + '</dd>' +
    '<dt>User</dt><dd>' + esc(t.user_name || '') + ' ' + esc(t.user_phone || '') + ' (' + esc(t.user_role || '') + ')</dd>' +
    '<dt>Order</dt><dd class="id-mono">' + esc(t.order_id ? shortId(t.order_id) : '—') + '</dd>' +
    '<dt>Status</dt><dd>' + pill(t.status) + '</dd>' +
    '<dt>Created</dt><dd>' + esc(fmtDateTime(t.created_at)) + '</dd>' +
    '</dl>' +
    '<h3 class="section-title">Change status</h3>' +
    '<div class="toolbar">' +
    '<select id="ticket-status">' +
    ['open', 'in_progress', 'resolved', 'closed'].map(function (s) {
      return '<option value="' + s + '"' + (s === st ? ' selected' : '') + '>' + esc(s.replace(/_/g, ' ')) + '</option>';
    }).join('') +
    '</select>' +
    '<button class="btn btn-primary" data-action="ticket-status" data-id="' + esc(t.id) + '">Update status</button>' +
    '</div>';
  openDrawer(drawerShell('Ticket ' + shortId(t.id), body));
}

function updateTicketStatus(id) {
  var sel = $('ticket-status');
  var status = sel ? sel.value : '';
  if (!status) return;
  if (!confirm('Set this ticket to "' + status.replace(/_/g, ' ') + '"?')) return;
  api('/api/admin/tickets/' + id, { method: 'PUT', body: JSON.stringify({ status: status }) }).then(function () {
    toast('Ticket marked ' + status.replace(/_/g, ' '), 'success');
    closeDrawer();
    renderTickets();
  }).catch(handleErr);
}

/* ---------- Reports ---------- */

function renderReports() {
  var today = new Date();
  var weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
  function iso(d) { return d.toISOString().slice(0, 10); }
  if (!filters.reportFrom) filters.reportFrom = iso(weekAgo);
  if (!filters.reportTo) filters.reportTo = iso(today);
  $('screen').innerHTML =
    '<div class="card"><h3>Business summary</h3>' +
    '<div class="toolbar">' +
    '<label class="field" style="margin:0"><span>From</span><input type="date" id="report-from" value="' + esc(filters.reportFrom) + '" /></label>' +
    '<label class="field" style="margin:0"><span>To</span><input type="date" id="report-to" value="' + esc(filters.reportTo) + '" /></label>' +
    '<button class="btn btn-primary" data-action="run-report" style="align-self:flex-end">Run report</button>' +
    '</div><div id="report-result"><p style="color:var(--muted)">Pick a date range and run the report.</p></div></div>';
}

function runReport() {
  var from = $('report-from').value, to = $('report-to').value;
  filters.reportFrom = from; filters.reportTo = to;
  if (!from || !to) { toast('Select both dates', 'error'); return; }
  $('report-result').innerHTML = loadingHtml('Running report…', 'table');
  api('/api/admin/reports/summary?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to)).then(function (data) {
    // Backend shape: { totals: {orders, sales_paise, avg_order_paise}, by_day, top_restaurants, by_status }
    var t = data.totals || {};
    var cards = [
      ['Orders', prettyNum(t.orders != null ? Number(t.orders) : null)],
      ['Sales', rupees(t.sales_paise)],
      ['Avg order value', rupees(t.avg_order_paise)]
    ];
    var byStatus = (data.by_status || []).map(function (s) {
      return '<tr><td>' + pill(s.status) + '</td><td>' + prettyNum(s.orders != null ? Number(s.orders) : null) + '</td></tr>';
    }).join('');
    var top = (data.top_restaurants || []).map(function (r) {
      return '<tr><td>' + esc(r.name) + '</td>' +
        '<td>' + prettyNum(r.orders != null ? Number(r.orders) : null) + '</td>' +
        '<td>' + rupees(r.sales) + '</td></tr>';
    }).join('');
    $('report-result').innerHTML =
      '<div class="stat-grid" style="margin:14px 0 0">' + cards.map(function (c) {
        return '<div class="stat-card"><div class="stat-label">' + esc(c[0]) +
          '</div><div class="stat-value">' + c[1] + '</div></div>';
      }).join('') + '</div>' +
      '<h3 class="section-title">Orders by status</h3>' + tableHtml(['Status', 'Orders'], byStatus) +
      '<h3 class="section-title">Top restaurants</h3>' + tableHtml(['Restaurant', 'Orders', 'Sales'], top);
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('report-result').innerHTML = '<p style="color:var(--red)">Could not run the report.</p>';
  });
}

/* ---------- Audit logs ---------- */

function renderAudit() {
  $('screen').innerHTML = loadingHtml('Loading audit logs…', 'table');
  api('/api/admin/audit-logs').then(function (data) {
    var list = data.logs || [];
    var rows = list.map(function (l) {
      var details = l.meta;
      if (typeof details === 'object' && details !== null) {
        try { details = JSON.stringify(details); } catch (e) { details = ''; }
      }
      details = String(details == null ? '' : details);
      if (details.length > 120) details = details.slice(0, 120) + '…';
      var target = [l.entity, l.entity_id ? shortId(l.entity_id) : null].filter(Boolean).join(' ');
      return '<tr><td>' + esc(fmtDateTime(l.created_at)) + '</td>' +
        '<td>' + esc(l.admin_name || '—') + '</td>' +
        '<td><strong>' + esc(l.action || '') + '</strong></td>' +
        '<td>' + esc(target) + '</td>' +
        '<td>' + esc(details) + '</td></tr>';
    }).join('');
    $('screen').innerHTML = tableHtml(['Time', 'Admin', 'Action', 'Target', 'Details'], rows);
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('screen').innerHTML = errorHtml('Could not load audit logs.', 'audit');
  });
}

/* ---------- Rider spotlight ---------- */

/* Backend: GET /api/admin/riders?status=approved ->
   { riders: [{ id, name, phone, rating_avg, total_deliveries, profile_photo, ... }] } */
function renderSpotlight() {
  $('screen').innerHTML = loadingHtml('Loading top riders…', 'spot');
  api('/api/admin/riders?status=approved').then(function (data) {
    var riders = data.riders || [];
    var rated = riders.filter(function (r) {
      return r.rating_avg != null && Number(r.rating_avg) > 0 && Number(r.total_deliveries) > 0;
    });
    rated.sort(function (a, b) { return Number(b.rating_avg) - Number(a.rating_avg); });
    if (rated.length === 0) {
      $('screen').innerHTML = '<div class="state"><p>No rated riders yet.</p></div>';
      return;
    }
    var cards = rated.map(function (r, i) {
      var rating = Number(r.rating_avg);
      var name = r.name || r.phone || 'Rider';
      var photo = r.profile_photo
        ? '<img src="' + esc(r.profile_photo) + '" alt="" style="width:52px;height:52px;border-radius:50%;object-fit:cover;flex-shrink:0" />'
        : '<span style="width:52px;height:52px;border-radius:50%;background:var(--slate-100);color:var(--indigo);' +
          'display:inline-flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;flex-shrink:0">' +
          esc(String(name).charAt(0).toUpperCase()) + '</span>';
      return '<div class="card" style="display:flex;gap:14px;align-items:center;margin-bottom:12px">' +
        '<div style="font-size:22px;font-weight:800;color:var(--slate-400);width:30px;text-align:center;flex-shrink:0">' + (i + 1) + '</div>' +
        photo +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:700;font-size:15px">' + esc(name) + '</div>' +
          '<div style="color:var(--muted);font-size:12.5px">' + esc(r.phone || '—') + ' · ' + prettyNum(Number(r.total_deliveries)) + ' deliveries</div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:5px;color:#f59e0b;font-weight:700;font-size:16px;flex-shrink:0">' +
          '<span style="width:20px;height:20px;display:inline-flex">' +
          '<svg viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" stroke-width="1.5" aria-hidden="true">' +
          '<path d="M12 2.8l2.8 6 6.4.7-4.8 4.4 1.3 6.3L12 16.9l-5.7 3.3 1.3-6.3L2.8 9.5l6.4-.7z"/></svg></span>' +
          rating.toFixed(1) +
        '</div>' +
      '</div>';
    }).join('');
    $('screen').innerHTML =
      '<p style="color:var(--muted);margin:0 0 16px">Top approved riders by customer rating.</p>' + cards;
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('screen').innerHTML = errorHtml('Could not load riders.', 'spotlight');
  });
}

/* ---------- Promise hit-rate ---------- */

/* Backend: GET /api/admin/promise-stats?days=30 ->
   { days, delivered, on_time, late, hit_rate (0-100 or null), avg_minutes } */
function renderPromise() {
  $('screen').innerHTML = loadingHtml('Loading promise stats…', 'cards', 4);
  api('/api/admin/promise-stats?days=30').then(function (data) {
    var delivered = Number(data.delivered) || 0;
    var onTime = Number(data.on_time) || 0;
    var late = Number(data.late) || 0;
    var hitRate = data.hit_rate == null ? null : Number(data.hit_rate);
    if (hitRate == null || !isFinite(hitRate) || delivered === 0) {
      $('screen').innerHTML = '<div class="state"><p>No deliveries yet.</p></div>';
      return;
    }
    var onPct = delivered > 0 ? (onTime / delivered) * 100 : 0;
    var avgMin = data.avg_minutes == null || !isFinite(Number(data.avg_minutes)) ? '—' : Number(data.avg_minutes).toFixed(1) + ' min';
    var bar =
      '<div style="height:14px;border-radius:999px;overflow:hidden;display:flex;background:var(--slate-100);margin:6px 0 4px">' +
        '<div style="width:' + onPct.toFixed(1) + '%;background:var(--green)"></div>' +
        '<div style="width:' + (100 - onPct).toFixed(1) + '%;background:var(--red)"></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted)">' +
        '<span><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--green)"></span> On time ' + prettyNum(onTime) + '</span>' +
        '<span><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--red)"></span> Late ' + prettyNum(late) + '</span>' +
      '</div>';
    var cards = [
      ['Hit rate', hitRate.toFixed(1) + '%'],
      ['On time', prettyNum(onTime)],
      ['Late', prettyNum(late)],
      ['Total delivered', prettyNum(delivered)],
      ['Avg delivery time', avgMin]
    ];
    $('screen').innerHTML =
      '<p style="color:var(--muted);margin:0 0 14px">Last 30 days · promise: delivered by the promised time.</p>' +
      '<div class="card"><div style="font-size:11.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600;margin-bottom:4px">On-time hit rate</div>' +
      '<div style="font-size:44px;font-weight:800;color:' + (hitRate >= 90 ? 'var(--green)' : hitRate >= 75 ? 'var(--amber)' : 'var(--red)') + '">' + hitRate.toFixed(1) + '%</div>' +
      bar + '</div>' +
      '<div class="stat-grid">' + cards.map(function (c) {
        return '<div class="stat-card"><div class="stat-label">' + esc(c[0]) +
          '</div><div class="stat-value">' + c[1] + '</div></div>';
      }).join('') + '</div>';
  }).catch(function (e) {
    handleErr(e);
    if (!e.unauthorized) $('screen').innerHTML = errorHtml('Could not load promise stats.', 'promise');
  });
}

/* ---------------- render map ---------------- */

var RENDER = {
  dashboard: renderDashboard,
  restaurants: renderRestaurants,
  riders: renderRiders,
  spotlight: renderSpotlight,
  customers: renderCustomers,
  orders: renderOrders,
  pricing: renderPricing,
  promise: renderPromise,
  coupons: renderCoupons,
  settlements: renderSettlements,
  refunds: renderRefunds,
  tickets: renderTickets,
  reports: renderReports,
  audit: renderAudit
};

/* ---------------- events ---------------- */

function onScreenClick(e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var action = el.dataset.action;
  var id = el.dataset.id;
  switch (action) {
    case 'retry': RENDER[el.dataset.screen](); break;
    case 'view-order': openOrderDrawer(id); break;
    case 'view-restaurant': openRestaurantDrawer(id); break;
    case 'approve-restaurant': approveRestaurant(id); break;
    case 'reject-restaurant': rejectRestaurant(id); break;
    case 'suspend-restaurant': suspendRestaurant(id); break;
    case 'approve-rider': approveRider(id); break;
    case 'reject-rider': rejectRider(id); break;
    case 'suspend-rider': suspendRider(id); break;
    case 'rider-kyc': openRiderKyc(id); break;
    case 'approve-rider-kyc': approveRider(id); closeDrawer(); break;
    case 'reject-rider-kyc': rejectRider(id); closeDrawer(); break;
    case 'save-price': savePrice(el.dataset.key); break;
    case 'coupon-edit': editCoupon(id); break;
    case 'coupon-toggle': toggleCoupon(id, el.dataset.active); break;
    case 'sett-filter':
      filters.settlementsRestaurant = ($('sett-filter-rid') || {}).value || '';
      renderSettlements();
      break;
    case 'sett-clear':
      filters.settlementsRestaurant = '';
      renderSettlements();
      break;
    case 'settlement-pay': markSettlementPaid(id); break;
    case 'ticket-view': openTicketDrawer(id); break;
    case 'ticket-cat':
      filters.ticketCategory = el.dataset.cat || '';
      renderTickets();
      break;
    case 'zone-add': zoneAdd(); break;
    case 'zone-save': zoneSave(id); break;
    case 'zone-default': zoneSetDefault(id); break;
    case 'zone-delete': zoneDelete(id); break;
    case 'run-report': runReport(); break;
  }
}

function onScreenChange(e) {
  var t = e.target;
  if (t && t.matches && t.matches('[data-filter]')) {
    filters[t.dataset.filter] = t.value;
    RENDER[t.dataset.screen]();
  }
}

function onDrawerClick(e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var action = el.dataset.action;
  var id = el.dataset.id;
  if (action === 'close-drawer') { closeDrawer(); return; }
  if (action === 'assign-rider') { assignRider(id); return; }
  if (action === 'cancel-order') { cancelOrder(id); return; }
  if (action === 'ticket-status') { updateTicketStatus(id); return; }
  if (action === 'coupon-save') { saveCouponEdit(id); return; }
  if (action === 'approve-rider-kyc') { approveRider(id); closeDrawer(); return; }
  if (action === 'reject-rider-kyc') { rejectRider(id); closeDrawer(); return; }
  if (action === 'approve-restaurant-d') { setRestaurantStatusFromDrawer(id, 'approved', 'Approve'); return; }
  if (action === 'reject-restaurant-d') { setRestaurantStatusFromDrawer(id, 'rejected', 'Reject'); return; }
  if (action === 'suspend-restaurant-d') { setRestaurantStatusFromDrawer(id, 'suspended', 'Suspend'); return; }
}

/* ---------------- auth ---------------- */

function doLogin(e) {
  e.preventDefault();
  var phone = $('login-phone').value.trim();
  var password = $('login-password').value;
  var errEl = $('login-error');
  var btn = $('login-btn');
  errEl.hidden = true;
  btn.disabled = true;
  api('/api/auth/admin-login', { method: 'POST', body: JSON.stringify({ phone: phone, password: password }) }).then(function (data) {
    try { localStorage.setItem(TOKEN_KEY, data.token); } catch (ex) { /* ignore */ }
    var u = data.user || {};
    $('admin-name').textContent = u.name || u.phone || 'Admin';
    $('login-password').value = '';
    showApp();
    navigate('dashboard');
  }).catch(function (ex) {
    errEl.textContent = ex.message || 'Sign in failed';
    errEl.hidden = false;
  }).then(function () {
    btn.disabled = false;
  });
}

function doLogout() {
  try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  $('admin-name').textContent = '';
  $('login-phone').value = '';
  $('login-password').value = '';
  $('login-error').hidden = true;
  showLogin();
}

/* ---------------- init ---------------- */

function init() {
  buildNav();
  $('login-form').addEventListener('submit', doLogin);
  $('logout-btn').addEventListener('click', doLogout);
  $('screen').addEventListener('click', onScreenClick);
  $('screen').addEventListener('change', onScreenChange);
  $('drawer').addEventListener('click', onDrawerClick);
  $('drawer-scrim').addEventListener('click', closeDrawer);
  $('menu-btn').addEventListener('click', function () {
    $('sidebar').classList.add('open');
    $('sidebar-scrim').classList.remove('hidden');
  });
  $('sidebar-scrim').addEventListener('click', closeSidebar);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeDrawer(); closeSidebar(); }
  });

  var token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  if (token) {
    showApp();
    navigate('dashboard'); // invalid token -> 401 -> back to login
  } else {
    showLogin();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
