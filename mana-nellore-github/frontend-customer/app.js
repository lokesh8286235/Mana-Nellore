'use strict';
/* Mana Nellore - Customer portal (static frontend, talks to live Railway API) */
var API = 'https://mana-nellore-mana-nellore.up.railway.app';
var LS_TOKEN = 'mana_customer_token';
var LS_USER = 'mana_customer_user';
var LS_FAV = 'mana_customer_favs';
var LS_NOTIF_SEEN = 'mana_customer_notif_seen';
var LS_CART = 'mn_cart';

var token = localStorage.getItem(LS_TOKEN) || null;
var user = null;
try { user = JSON.parse(localStorage.getItem(LS_USER) || 'null'); } catch (e) { user = null; }
var lang = 'en';
var favs = [];
try { favs = JSON.parse(localStorage.getItem(LS_FAV) || '[]'); } catch (e) { favs = []; }
var cart = { restaurant_id: null, restaurant_name: '', items: [] };
try {
  var _c = JSON.parse(localStorage.getItem(LS_CART) || 'null');
  if (_c && Array.isArray(_c.items)) cart = _c;
} catch (e) {}
function saveCart() {
  try { localStorage.setItem(LS_CART, JSON.stringify(cart)); } catch (e) {}
}
function clearCart() {
  cart = { restaurant_id: null, restaurant_name: '', items: [] };
  saveCart();
}
var wallet = null;
var V = {};
var homeState = { q: '', vegOnly: false, favOnly: false };
var trackTimer = null, cdTimer = null;
var MENU = {};

function $(s, r) { return (r || document).querySelector(s); }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function fmt(p) { return '\u20B9' + (Number(p || 0) / 100).toFixed(2).replace(/\.00$/, ''); }
function fmtDT(iso) {
  try { return new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); }
  catch (e) { return ''; }
}
function timeAgo(iso) {
  try {
    var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' hr ago';
    return Math.floor(s / 86400) + ' d ago';
  } catch (e) { return ''; }
}

function api(method, path, body) {
  var headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return fetch(API + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
    .then(function (res) {
      if (res.status === 401) { logout(); throw new Error('Session expired. Please login again.'); }
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) throw new Error((data && (data.error || data.message)) || ('Request failed (' + res.status + ')'));
        return data || {};
      });
    })
    .catch(function (e) {
      if (e.message === 'Session expired. Please login again.') throw e;
      if (e instanceof TypeError) throw new Error('Network error. Check your connection and retry.');
      throw e;
    });
}

function logout() {
  token = null; user = null; wallet = null;
  clearCart();
  localStorage.removeItem(LS_TOKEN); localStorage.removeItem(LS_USER);
  if (!location.hash.startsWith('#/login')) location.hash = '#/login';
  else router();
}

function toast(msg, isErr) {
  var root = $('#toast-root') || document.body;
  var d = document.createElement('div');
  d.className = 'toast' + (isErr ? ' err' : '');
  d.textContent = msg;
  root.appendChild(d);
  setTimeout(function () {
    d.style.opacity = '0'; d.style.transition = '.3s';
    setTimeout(function () { d.remove(); }, 320);
  }, 2600);
}

/* ---------------- icons (inline SVG, no emojis) ---------------- */
var ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  orders: '<path d="M6 7h12l1.5 13.5a1 1 0 0 1-1 1.1H5.5a1 1 0 0 1-1-1.1L6 7Z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/>',
  support: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1L3 20l1.1-4.3A8.5 8.5 0 1 1 21 11.5Z"/>',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
  wallet: '<path d="M20 7H5a2 2 0 0 1 0-4h14v4"/><path d="M20 7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5"/><circle cx="17" cy="14" r="1.4"/>',
  heart: '<path d="M12 20.7C6 16.6 3 13.3 3 9.6 3 7 5 5 7.5 5c1.8 0 3.4 1 4.5 2.6C13.1 6 14.7 5 16.5 5 19 5 21 7 21 9.6c0 3.7-3 7-9 11.1Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  bag: '<path d="M5.5 8h13l-1 12.5a1 1 0 0 1-1 .5h-9a1 1 0 0 1-1-.5L5.5 8Z"/><path d="M9 10V6.5a3 3 0 0 1 6 0V10"/>',
  star: '<path d="m12 2.5 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9 2.9-6Z"/>',
  back: '<path d="M19 12H5"/><path d="m11 18-6-6 6-6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.9.6 2.7a2 2 0 0 1-.5 2.1L8 9.7a16 16 0 0 0 6 6l1.2-1.2a2 2 0 0 1 2.1-.5c.8.3 1.8.5 2.7.6a2 2 0 0 1 1.7 2Z"/>',
  pin: '<path d="M20 10.5c0 6-8 11.5-8 11.5S4 16.5 4 10.5a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10.5" r="2.6"/>',
  check: '<path d="m4.5 12.5 5 5 10-11"/>',
  bike: '<circle cx="5.5" cy="17.5" r="3.2"/><circle cx="18.5" cy="17.5" r="3.2"/><path d="M5.5 17.5 9 9h4l4 8.5M9 9 7.5 5.5H4.5M14 5.5h3"/>',
  box: '<path d="M21 8.5v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11"/><path d="m2.5 8.5 2-4.7A1 1 0 0 1 5.4 3.2h13.2a1 1 0 0 1 .9.6l2 4.7"/><path d="M3 8.5h18"/>',
  card: '<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19M6 15h4"/>',
  cash: '<rect x="2.5" y="6.5" width="19" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 12h.01M18 12h.01"/>',
  upi: '<path d="M13 3 5 13.5h5L11 21l8-10.5h-5L13 3Z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  food: '<path d="M7 3v8M4.5 3v4.5a2.5 2.5 0 0 0 5 0V3"/><path d="M7 11v10M17 3c-2.5 0-3.5 2.5-3.5 6v3H17v9M17 3v18"/>',
  edit: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3Z"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7Z"/><path d="M22 2 11 13"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>'
};
function icon(n) { return '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[n] || '') + '</svg>'; }

/* ---------------- i18n ---------------- */
var I18N = {
  en: {
    home: 'Home', orders: 'Orders', support: 'Support', searchPh: 'Search restaurants or dishes...',
    vegOnly: 'Veg only', favs: 'Favourites', promise: '30-min promise', openNow: 'Open now', closed: 'Closed',
    loginTitle: 'Mana Nellore', loginSub: 'Nellore\u2019s own food delivery. Hot, fast, honest.',
    phoneLbl: 'Mobile number', sendOtp: 'Send OTP', otpLbl: 'Enter OTP', nameLbl: 'Your name',
    verify: 'Verify & Login', otpSent: 'OTP sent to', otpDev: 'Dev mode: OTP auto-filled below.',
    change: 'Change', add: 'Add', viewCart: 'View cart', checkout: 'Checkout', cart: 'Cart', cartEmpty: 'Your cart is empty. Add something tasty first!',
    deliveryAddr: 'Delivery address', addNewAddr: 'Add new address', editAddr: 'Edit address',
    label: 'Label', addrLine: 'Full address', city: 'City', pincode: 'Pincode',
    homeL: 'Home', workL: 'Work', otherL: 'Other', save: 'Save', cancel: 'Cancel', del: 'Delete',
    couponPh: 'Coupon code (optional)', useCredits: 'Use wallet credits', walletBal: 'Wallet balance',
    payMethod: 'Payment method', upi: 'UPI', upiSub: 'GPay / PhonePe / Paytm', card: 'Card', cardSub: 'Credit / debit card',
    cod: 'Cash on delivery', codSub: 'Pay at your doorstep', billDetails: 'Bill details', subtotal: 'Item total',
    toPay: 'To pay', placeOrder: 'Place order', payNow: 'Pay now', orderConfirmed: 'Order placed!',
    billLoading: 'Calculating your bill...', deliveryFee: 'Delivery fee', platformFee: 'Platform fee',
    tax: 'Tax', discount: 'Discount', creditsUsed: 'Wallet credits', couponInvalid: 'Coupon not applied', free: 'Free',
    promiseNote: 'If we are late, you get the delivery fee back as wallet credit.',
    trackOrder: 'Track order', arrivingIn: 'Arriving in', mins: 'min', runningLate: 'Running a little late - credit on its way',
    yourRider: 'Your rider', pickupPhoto: 'Pickup photo', otpNote: 'Share this delivery OTP with your rider at handover. Find it under the bell icon.',
    resendOtp: 'Resend OTP', otpResent: 'OTP re-sent. Check the bell icon.', otpResendFail: 'Could not resend OTP.',
    items: 'items', reorder: 'Reorder', cancelOrder: 'Cancel order', rateOrder: 'Rate order', coldFood: 'Food arrived cold?',
    coldTitle: 'Report cold food', coldMsg: 'We are sorry! Reporting creates a support ticket and credits an apology amount to your wallet instantly.',
    reportBtn: 'Report & get credit', foodQ: 'Food', deliveryQ: 'Delivery', commentPh: 'Tell us more (optional)', submit: 'Submit',
    tickets: 'Support tickets', newTicket: 'Raise a ticket', subjectPh: 'Subject', msgPh: 'Describe your issue...',
    noTickets: 'No tickets yet. We hope it stays that way.', noOrders: 'No orders yet. Hungry? Let\u2019s fix that.',
    noRestaurants: 'No restaurants found. Try another search.', noFavs: 'No favourites yet. Tap the heart on any restaurant.',
    noMenuItems: 'No menu items here yet. Please check back soon.',
    noNotif: 'No notifications yet.', loading: 'Loading...', retry: 'Retry', errLoad: 'Something went wrong.',
    needAddr: 'Please add a delivery address first.', logout: 'Logout', notifications: 'Notifications',
    wallet: 'Wallet', walletHistory: 'Wallet history', noHistory: 'No wallet activity yet.',
    orderId: 'Order', placedOn: 'Placed', delivered: 'Delivered', active: 'Active', past: 'Past',
    call: 'Call', deliveredMsg: 'Delivered. Enjoy your meal!', cancelledMsg: 'This order was cancelled.',
    payFor: 'Paying', clearCartT: 'Start a new cart?', clearCartM: 'Your current cart items will be removed.',
    yesClear: 'Yes, clear it', keepCart: 'Keep cart', emptyCart: 'Your cart is empty.', backToHome: 'Browse restaurants',
    selectAddr: 'Select a delivery address', delAddrQ: 'Delete this address?', confirmPay: 'Confirm payment',
    paySecure: 'Secured payment via Mana Nellore', rateThanks: 'Thanks for rating!', cancelQ: 'Cancel this order?',
    cancelDone: 'Order cancelled.', coldCredit: 'Apology credit added to your wallet.', reorderFail: 'Could not rebuild this order.', ticketDone: 'Ticket raised. We will get back soon.',
    addrSaved: 'Address saved.', addrDeleted: 'Address deleted.',
    rate: 'Rate', welcome: 'Welcome', all: 'All', preparing: 'Preparing your food',
    restNear: 'Restaurants near you', restNearSub: 'Handpicked kitchens across Nellore, delivering hot and fast.',
    menu: 'Menu', orderNow: 'Order now', min30: '30 min', promiseCap: 'delivery promise'
  }
};
function t(k) { return (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k; }

/* ---------------- shell ---------------- */
function brandMark() {
  return '<span class="brand-mark">' + icon('food') + '</span><span class="brand-name">Mana <span>Nellore</span></span>';
}
function shell(content, active) {
  var notifDot = hasUnreadNotif() ? '<span class="dot"></span>' : '';
  function navCls(k) { return active === k ? 'active' : ''; }
  return '' +
    '<header class="hdr">' +
      '<a class="brand" href="#/home">' + brandMark() + '</a>' +
      '<nav class="dnav">' +
        '<a href="#/home" class="' + navCls('home') + '">' + esc(t('home')) + '</a>' +
        '<a href="#/orders" class="' + navCls('orders') + '">' + esc(t('orders')) + '</a>' +
        '<a href="#/support" class="' + navCls('support') + '">' + esc(t('support')) + '</a>' +
      '</nav>' +
      '<div class="hdr-actions">' +
        '<button class="icon-btn cart-btn" data-act="cart-go" title="' + esc(t('cart')) + '">' + icon('bag') + '<span class="cbadge" id="cart-badge"' + (cartCount() ? '' : ' style="display:none"') + '>' + cartCount() + '</span></button>' +
        '<button class="wallet-pill" data-act="wallet" title="' + esc(t('wallet')) + '">' + icon('wallet') + '<span id="wallet-amt">' + (wallet == null ? '...' : fmt(wallet)) + '</span></button>' +
        '<button class="icon-btn" data-act="notif" title="' + esc(t('notifications')) + '">' + icon('bell') + notifDot + '</button>' +
        '<button class="icon-btn" data-act="logout" title="' + esc(t('logout')) + '">' + icon('logout') + '</button>' +
      '</div>' +
    '</header>' +
    '<main class="main">' + content + '</main>' +
    '<footer class="ftr"><div class="ftr-in">' +
      '<div class="ftr-brand"><span class="brand-mark">' + icon('food') + '</span><span>Mana <span style="color:var(--brand)">Nellore</span><small>' + esc(t('loginSub')) + '</small></span></div>' +
      '<nav class="ftr-nav">' +
        '<a href="#/home">' + esc(t('home')) + '</a>' +
        '<a href="#/orders">' + esc(t('orders')) + '</a>' +
        '<a href="#/support">' + esc(t('support')) + '</a>' +
      '</nav>' +
      '<div class="ftr-copy"><span>&copy; 2026 Mana Nellore. All rights reserved.</span><span>' + esc(t('promise')) + '</span></div>' +
    '</div></footer>' +
    '<div id="float-root"></div>' +
    '<nav class="bnav">' +
      '<a href="#/home" class="' + (active === 'home' ? 'active' : '') + '">' + icon('home') + '<span>' + esc(t('home')) + '</span></a>' +
      '<a href="#/orders" class="' + (active === 'orders' ? 'active' : '') + '">' + icon('orders') + '<span>' + esc(t('orders')) + '</span></a>' +
      '<a href="#/support" class="' + (active === 'support' ? 'active' : '') + '">' + icon('support') + '<span>' + esc(t('support')) + '</span></a>' +
    '</nav>' +
    '<div class="scrim" id="scrim" data-act="close-drawer"></div>' +
    '<aside class="drawer" id="drawer"><div class="dr-h"><b id="drawer-title"></b><button class="icon-btn" data-act="close-drawer">' + icon('close') + '</button></div><div class="dr-b" id="drawer-body"></div></aside>' +
    '<div class="modal-wrap" id="modal-wrap"><div class="modal" id="modal-box"></div></div>' +
    '<div id="toast-root"></div>';
}
function loginTitleHTML() {
  return 'Mana <span>Nellore</span>';
}
function loginShell(content) {
  return '<div class="login-wrap"><div class="login-card">' +
    '<div class="login-logo">' + icon('food') + '</div>' +
    '<h1>' + esc(t('loginTitle')).replace('Nellore', '<span>Nellore</span>') + '</h1>' +
    '<p class="login-sub">' + esc(t('loginSub')) + '</p>' + content +
    '</div></div><div id="toast-root"></div>';
}
function errBox(msg) {
  return '<div class="err">' + icon('alert') + '<p>' + esc(msg || t('errLoad')) + '</p>' +
    '<button class="btn btn-ghost btn-sm" data-act="retry">' + esc(t('retry')) + '</button></div>';
}
function emptyBox(ic, msg) {
  return '<div class="empty">' + icon(ic) + '<p>' + esc(msg) + '</p></div>';
}
function skel(h) {
  return '<div class="skel" style="height:' + (h || 120) + 'px;margin-bottom:12px"></div>';
}

/* ---------------- drawer / modal ---------------- */
function openDrawer(title, html) {
  $('#drawer-title').textContent = title;
  $('#drawer-body').innerHTML = html;
  $('#drawer').classList.add('show');
  $('#scrim').classList.add('show');
}
function closeDrawer() {
  var d = $('#drawer'); if (d) d.classList.remove('show');
  var s = $('#scrim'); if (s) s.classList.remove('show');
  closeModal();
}
function openModal(html) {
  $('#modal-box').innerHTML = html;
  $('#modal-wrap').classList.add('show');
  $('#scrim').classList.add('show');
}
function closeModal() {
  var m = $('#modal-wrap'); if (m) m.classList.remove('show');
  if (!$('#drawer') || !$('#drawer').classList.contains('show')) { var s = $('#scrim'); if (s) s.classList.remove('show'); }
}

/* ---------------- router ---------------- */
function clearTimers() {
  if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
  if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
}
function router() {
  clearTimers();
  V = {}; MENU = {};
  var hash = location.hash || '#/home';
  if (!token && hash !== '#/login') { location.hash = '#/login'; return; }
  if (token && hash === '#/login') { location.hash = '#/home'; return; }
  var m;
  if (hash === '#/login') return viewLogin();
  if (hash === '#/home' || hash === '#/' || hash === '') return viewHome();
  if ((m = hash.match(/^#\/restaurant\/([^\/]+)$/))) return viewRestaurant(m[1]);
  if (hash === '#/checkout') return viewCheckout();
  if (hash === '#/payment') return viewPayment();
  if ((m = hash.match(/^#\/tracking\/([^\/]+)$/))) return viewTracking(m[1]);
  if (hash === '#/orders') return viewOrders();
  if (hash === '#/support') return viewSupport();
  location.hash = '#/home';
}
window.addEventListener('hashchange', router);

/* ---------------- notifications / wallet ---------------- */
function hasUnreadNotif() {
  try {
    var seen = Number(localStorage.getItem(LS_NOTIF_SEEN) || 0);
    return (V.notifLatest || 0) > seen;
  } catch (e) { return false; }
}
function refreshWallet() {
  if (!token) return;
  api('GET', '/api/customer/credits').then(function (d) {
    wallet = Number(d.balance_paise || 0);
    var el = $('#wallet-amt'); if (el) el.textContent = fmt(wallet);
  }).catch(function () {});
}
function openNotifDrawer() {
  openDrawer(t('notifications'), '<p class="muted">' + esc(t('loading')) + '</p>');
  api('GET', '/api/customer/notifications').then(function (d) {
    var list = d.notifications || d.items || [];
    var latest = 0;
    list.forEach(function (n) {
      var ts = new Date(n.created_at || n.createdAt || 0).getTime();
      if (ts > latest) latest = ts;
    });
    try { localStorage.setItem(LS_NOTIF_SEEN, String(Date.now())); } catch (e) {}
    V.notifLatest = latest;
    var html = list.length ? list.map(function (n) {
      var body = n.title || n.message || n.body || n.text || JSON.stringify(n);
      return '<div class="n-item"><div>' + esc(body) + '</div><div class="t">' + esc(timeAgo(n.created_at || n.createdAt) + ' &middot; ' + fmtDT(n.created_at || n.createdAt)) + '</div></div>';
    }).join('') : emptyBox('bell', t('noNotif'));
    openDrawer(t('notifications'), html);
    var btn = $('[data-act="notif"] .dot'); if (btn) btn.remove();
  }).catch(function (e) { openDrawer(t('notifications'), errBox(e.message)); });
}
function openWalletDrawer() {
  openDrawer(t('wallet'), '<p class="muted">' + esc(t('loading')) + '</p>');
  api('GET', '/api/customer/credits').then(function (d) {
    wallet = Number(d.balance_paise || 0);
    var el = $('#wallet-amt'); if (el) el.textContent = fmt(wallet);
    var ledger = d.ledger || [];
    var html = '<div class="card mb"><div class="small muted">' + esc(t('walletBal')) + '</div>' +
      '<div style="font-size:30px;font-weight:800;color:var(--orange)">' + fmt(wallet) + '</div></div>' +
      '<div class="sec-title" style="margin-top:4px">' + esc(t('walletHistory')) + '</div>' +
      (ledger.length ? ledger.map(function (l) {
        var amt = Number(l.amount_paise || l.amount || 0);
        var note = l.reason || l.note || l.description || l.type || '';
        return '<div class="led"><div><div>' + esc(note) + '</div><div class="small muted">' + esc(fmtDT(l.created_at || l.createdAt)) + '</div></div>' +
          '<div class="' + (amt >= 0 ? 'pos' : 'neg') + '">' + (amt >= 0 ? '+' : '') + fmt(amt) + '</div></div>';
      }).join('') : '<p class="muted small">' + esc(t('noHistory')) + '</p>');
    openDrawer(t('wallet'), html);
  }).catch(function () {
    wallet = 0;
    var el = $('#wallet-amt'); if (el) el.textContent = fmt(wallet);
    openDrawer(t('wallet'),
      '<div class="card mb"><div class="small muted">' + esc(t('walletBal')) + '</div>' +
      '<div style="font-size:30px;font-weight:800;color:var(--orange)">' + fmt(0) + '</div></div>' +
      '<p class="muted small">' + esc(t('noHistory')) + '</p>');
  });
}

/* ---------------- login ---------------- */
function viewLogin() {
  V.phase = V.phase || 'phone';
  var body = '';
  if (V.phase === 'phone') {
    body = '<form id="f-phone">' +
      '<div class="lbl">' + esc(t('phoneLbl')) + '</div>' +
      '<div class="phone-wrap"><span class="country">+91</span>' +
      '<input class="inp" id="in-phone" inputmode="numeric" maxlength="13" placeholder="98765 43210" autocomplete="tel" required></div>' +
      '<button class="btn btn-primary btn-block mt" type="submit">' + esc(t('sendOtp')) + '</button></form>';
  } else {
    body = '<div class="small muted mb">' + esc(t('otpSent')) + ' <b>' + esc(V.phone) + '</b> ' +
      '<button data-act="to-phone" style="color:var(--orange);font-weight:700">(' + esc(t('change')) + ')</button></div>' +
      '<form id="f-otp">' +
      '<div class="lbl">' + esc(t('otpLbl')) + '</div>' +
      '<input class="inp otp-field" id="in-otp" inputmode="numeric" maxlength="6" placeholder="\u2022\u2022\u2022\u2022\u2022\u2022" required>' +
      (V.devCode ? '<div class="otp-hint">' + esc(t('otpDev')) + '</div>' : '') +
      '<div class="lbl">' + esc(t('nameLbl')) + '</div>' +
      '<input class="inp" id="in-name" maxlength="60" placeholder="' + esc(t('nameLbl')) + '" autocomplete="name">' +
      '<button class="btn btn-primary btn-block mt" type="submit">' + esc(t('verify')) + '</button></form>';
  }
  $('#app').innerHTML = loginShell(body);
  var fp = $('#f-phone');
  if (fp) fp.addEventListener('submit', function (e) {
    e.preventDefault();
    var phone = $('#in-phone').value.replace(/\D/g, '');
    if (phone.length < 10) { toast(t('phoneLbl'), true); return; }
    var btn = fp.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = t('loading');
    api('POST', '/api/auth/send-otp', { phone: phone }).then(function (d) {
      V.phone = phone; V.phase = 'otp'; V.devCode = d.dev_code || null;
      viewLogin();
      if (V.devCode) { var o = $('#in-otp'); if (o) o.value = V.devCode; }
    }).catch(function (err) { toast(err.message, true); btn.disabled = false; btn.textContent = t('sendOtp'); });
  });
  var fo = $('#f-otp');
  if (fo) fo.addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('#in-otp').value.trim(), name = $('#in-name').value.trim();
    if (!code) { toast(t('otpLbl'), true); return; }
    var btn = fo.querySelector('button[type=submit]');
    btn.disabled = true; btn.textContent = t('loading');
    api('POST', '/api/auth/verify-otp', { phone: V.phone, code: code, name: name, role: 'customer' }).then(function (d) {
      token = d.token; user = d.user || { name: name, phone: V.phone };
      try {
        localStorage.setItem(LS_TOKEN, token);
        localStorage.setItem(LS_USER, JSON.stringify(user));
      } catch (e) {}
      toast(t('welcome') + (user.name ? ', ' + user.name : '') + '!');
      location.hash = '#/home';
      refreshWallet();
    }).catch(function (err) { toast(err.message, true); btn.disabled = false; btn.textContent = t('verify'); });
  });
}

/* ---------------- home ---------------- */
function viewHome() {
  $('#app').innerHTML = shell(
    '<div class="hero"><div class="hero-copy">' +
      '<h1>Nellore\u2019s flavours, <em>delivered hot.</em></h1>' +
      '<p>' + esc(t('loginSub')) + ' ' + esc(t('promiseNote')) + '</p>' +
      '<div class="hero-cta"><button class="btn btn-primary" data-act="scroll-rest">' + esc(t('orderNow')) + '</button></div>' +
      '<div class="searchbar">' + icon('search') +
        '<input class="inp" id="q" placeholder="' + esc(t('searchPh')) + '" value="' + esc(homeState.q) + '" autocomplete="off"></div>' +
    '</div>' +
    '<div class="hero-media"></div>' +
    '<div class="hero-note"><strong>' + esc(t('min30')) + '</strong>' + esc(t('promiseCap')) + '</div>' +
    '</div>' +
    '<div class="section-head"><div><h2>' + esc(t('restNear')) + '</h2><p>' + esc(t('restNearSub')) + '</p></div></div>' +
    '<div class="chips mb">' +
      '<button class="chip veg-on' + (homeState.vegOnly ? ' active' : '') + '" data-act="veg">' + icon('check') + esc(t('vegOnly')) + '</button>' +
      '<button class="chip' + (homeState.favOnly ? ' active' : '') + '" data-act="favs">' + icon('heart') + esc(t('favs')) + '</button>' +
    '</div>' +
    '<div id="rest-list">' + skel(190) + skel(190) + skel(190) + '</div>',
    'home');
  var q = $('#q'), deb = null;
  q.addEventListener('input', function () {
    clearTimeout(deb);
    deb = setTimeout(function () { homeState.q = q.value.trim(); loadRestaurants(); }, 350);
  });
  loadRestaurants();
}
function restOpen(r) {
  if (r.is_open === false || r.open === false || r.isOpen === false) return false;
  return true;
}
function restCard(r) {
  var fav = favs.indexOf(String(r.id)) >= 0;
  var img = r.image_url
    ? '<img src="' + esc(r.image_url) + '" alt="" loading="lazy" onerror="this.remove()">'
    : '';
  var rating = (r.rating_avg != null)
    ? '<span class="rating">' + icon('star') + esc(Number(r.rating_avg).toFixed(1)) + '</span>' : '';
  return '<div class="r-card" data-act="rest" data-id="' + esc(r.id) + '">' +
    '<div class="r-img"><div class="ph">' + icon('food') + '</div>' + img +
      '<button class="fav-btn' + (fav ? ' on' : '') + '" data-act="fav" data-id="' + esc(r.id) + '" aria-label="favourite">' + icon('heart') + '</button></div>' +
    '<div class="r-body"><h3>' + esc(r.name) + '</h3>' +
      '<div class="r-meta">' + rating +
        (restOpen(r)
          ? '<span class="badge promise">' + icon('clock') + esc(t('promise')) + '</span>'
          : '<span class="badge closed">' + esc(t('closed')) + '</span>') +
      '</div></div></div>';
}
function loadRestaurants() {
  var box = $('#rest-list');
  if (!box) return;
  var qs = [];
  if (homeState.q) qs.push('q=' + encodeURIComponent(homeState.q));
  if (homeState.vegOnly) qs.push('veg=true');
  box.innerHTML = skel(150) + skel(150);
  api('GET', '/api/restaurants' + (qs.length ? '?' + qs.join('&') : '')).then(function (d) {
    if (!$('#rest-list')) return;
    var list = d.restaurants || [];
    if (homeState.favOnly) list = list.filter(function (r) { return favs.indexOf(String(r.id)) >= 0; });
    if (!list.length) {
      box.innerHTML = emptyBox('food', homeState.favOnly ? t('noFavs') : t('noRestaurants'));
      return;
    }
    box.innerHTML = list.map(restCard).join('');
  }).catch(function (e) { box.innerHTML = errBox(e.message); });
}
function toggleFav(id) {
  id = String(id);
  var i = favs.indexOf(id);
  if (i >= 0) favs.splice(i, 1); else favs.push(id);
  try { localStorage.setItem(LS_FAV, JSON.stringify(favs)); } catch (e) {}
  var btns = document.querySelectorAll('.fav-btn[data-id="' + id + '"]');
  btns.forEach(function (b) { b.classList.toggle('on', favs.indexOf(id) >= 0); });
  if (homeState.favOnly) loadRestaurants();
}

/* ---------------- restaurant page ---------------- */
function viewRestaurant(id) {
  V.restId = String(id); V.menuVeg = !!V.menuVeg;
  $('#app').innerHTML = shell('<div id="rest-body">' + skel(180) + skel(90) + skel(90) + '</div>', 'home');
  api('GET', '/api/restaurants/' + V.restId).then(function (d) {
    if (!$('#rest-body')) return;
    var r = d.restaurant || {};
    V.restName = r.name || '';
    V._cats = d.categories || [];
    MENU = {};
    (d.categories || []).forEach(function (c) {
      (c.items || []).forEach(function (it) { MENU[it.id] = it; });
    });
    renderRestaurantBody(r, d.categories || []);
  }).catch(function (e) { $('#rest-body').innerHTML = errBox(e.message); });
}
function cartQty(id) {
  var f = cart.items.find(function (x) { return String(x.id) === String(id); });
  return f ? f.qty : 0;
}
function itemCtl(it) {
  var q = cartQty(it.id);
  if (!it.available && q === 0) return '<button class="add-btn" disabled style="opacity:.4">' + esc(t('add')) + '</button>';
  if (q === 0) return '<button class="add-btn" data-act="add" data-id="' + esc(it.id) + '">' + esc(t('add')) + '</button>';
  return '<div class="stepper"><button data-act="dec" data-id="' + esc(it.id) + '" aria-label="less">\u2212</button>' +
    '<span>' + q + '</span><button data-act="inc" data-id="' + esc(it.id) + '" aria-label="more">+</button></div>';
}
function renderRestaurantBody(r, cats) {
  var photo = r.image_url
    ? '<img src="' + esc(r.image_url) + '" alt="" onerror="this.remove()">'
    : '';
  var html = '<button class="back-link" data-act="back">' + icon('back') + esc(t('home')) + '</button>' +
    '<div class="rest-hero"><div class="rest-info"><h2>' + esc(r.name) + '</h2>' +
      '<div class="r-meta">' +
        (r.rating_avg != null ? '<span class="rating">' + icon('star') + esc(Number(r.rating_avg).toFixed(1)) + '</span>' : '') +
        '<span class="badge promise">' + icon('clock') + esc(t('promise')) + '</span>' +
        (restOpen(r) ? '<span class="badge promise">' + esc(t('openNow')) + '</span>' : '<span class="badge closed">' + esc(t('closed')) + '</span>') +
      '</div>' +
      (r.address ? '<div class="small muted mt">' + esc(r.address) + '</div>' : '') +
    '</div>' +
    '<div class="restaurant-photo"><div class="ph">' + icon('food') + '</div>' + photo + '</div></div>' +
    '<div class="menu-toolbar"><h2>' + esc(t('menu')) + '</h2>' +
      '<div class="toggle-row">' + esc(t('vegOnly')) +
        '<button class="switch' + (V.menuVeg ? ' on' : '') + '" data-act="menuveg" role="switch" aria-checked="' + (V.menuVeg ? 'true' : 'false') + '"></button>' +
      '</div></div>' +
    '<div id="menu-list">' + menuListHTML(cats) + '</div>';
  $('#rest-body').innerHTML = html;
  renderCartBar();
}
function menuListHTML(cats) {
  return cats.map(function (c) {
    var items = (c.items || []).filter(function (it) { return !V.menuVeg || it.veg; });
    if (!items.length) return '';
    return '<div class="menu-cat"><h3>' + esc(c.name) + '</h3>' + items.map(function (it) {
      var unav = !it.available;
      return '<div class="mi' + (unav ? ' unav' : '') + '">' +
        '<div class="mi-info"><div class="mi-name"><span class="veg-dot ' + (it.veg ? 'v' : 'n') + '"><i></i></span>' + esc(it.name) + '</div>' +
        '<div class="mi-price">' + fmt(it.price_paise) + '</div>' +
        (it.description ? '<div class="mi-desc">' + esc(it.description) + '</div>' : '') +
        (unav ? '<div class="small" style="color:var(--danger);font-weight:700">Unavailable</div>' : '') + '</div>' +
        '<div class="mi-ctl">' + itemCtl(it) + '</div></div>';
    }).join('') + '</div>';
  }).join('') || emptyBox('food', t('noMenuItems'));
}
function refreshMenuControls() {
  var box = $('#menu-list'); if (!box || !V._cats) return;
  box.innerHTML = menuListHTML(V._cats);
  var sw = document.querySelector('[data-act="menuveg"]');
  if (sw) { sw.classList.toggle('on', !!V.menuVeg); sw.setAttribute('aria-checked', V.menuVeg ? 'true' : 'false'); }
  renderCartBar();
}
function cartCount() { return cart.items.reduce(function (a, x) { return a + x.qty; }, 0); }
function cartTotal() { return cart.items.reduce(function (a, x) { return a + x.qty * Number(x.price_paise || 0); }, 0); }
function renderCartBar() {
  var root = $('#float-root'); if (!root) return;
  var b = $('#cart-badge');
  if (b) { var n = cartCount(); b.textContent = n; b.style.display = n ? '' : 'none'; }
  if (cart.items.length && String(cart.restaurant_id) === String(V.restId)) {
    root.innerHTML = '<div class="cartbar" data-act="cart-go"><div><b>' + cartCount() + ' ' + esc(t('items')) + '</b>' +
      '<div style="font-size:13px;opacity:.85">' + fmt(cartTotal()) + '</div></div>' +
      '<div class="go">' + esc(t('viewCart')) + icon('back') + '</div></div>';
    var go = root.querySelector('.go svg'); if (go) go.style.transform = 'rotate(180deg)';
  } else root.innerHTML = '';
}
function addToCart(id) {
  var it = MENU[id];
  if (!it || !it.available) return;
  if (cart.restaurant_id && String(cart.restaurant_id) !== String(V.restId)) {
    V.pendingAdd = id;
    openModal('<h3 class="mb">' + esc(t('clearCartT')) + '</h3><p class="muted mb">' + esc(t('clearCartM')) + '</p>' +
      '<button class="btn btn-primary btn-block mb" data-act="clear-yes">' + esc(t('yesClear')) + '</button>' +
      '<button class="btn btn-ghost btn-block" data-act="close-modal">' + esc(t('keepCart')) + '</button>');
    return;
  }
  cart.restaurant_id = V.restId;
  cart.restaurant_name = V.restName || '';
  var f = cart.items.find(function (x) { return String(x.id) === String(id); });
  if (f) f.qty++;
  else cart.items.push({ id: it.id, name: it.name, price_paise: it.price_paise, veg: it.veg, qty: 1 });
  saveCart();
  refreshMenuControls();
}
function changeQty(id, d) {
  var f = cart.items.find(function (x) { return String(x.id) === String(id); });
  if (!f) return;
  f.qty += d;
  if (f.qty <= 0) cart.items = cart.items.filter(function (x) { return x !== f; });
  if (!cart.items.length) { cart.restaurant_id = null; cart.restaurant_name = ''; }
  saveCart();
  refreshMenuControls();
}

/* ---------------- checkout ---------------- */
function viewCheckout() {
  if (!cart.items.length) { location.hash = '#/home'; return; }
  V.payMethod = V.payMethod || 'upi';
  V.useCredits = !!V.useCredits;
  V.coupon = V.coupon || '';
  V.addrId = V.addrId || null;
  V.addrForm = null;
  $('#app').innerHTML = shell('<div id="co-body">' + skel(200) + skel(120) + '</div>', 'home');
  Promise.all([
    api('GET', '/api/customer/addresses'),
    api('GET', '/api/customer/credits').catch(function () { return { balance_paise: 0, history: [] }; })
  ]).then(function (res) {
    if (!$('#co-body')) return;
    V.addresses = res[0].addresses || res[0].items || [];
    wallet = Number((res[1] || {}).balance_paise || 0);
    var el = $('#wallet-amt'); if (el) el.textContent = fmt(wallet);
    if (!V.addrId && V.addresses.length) V.addrId = V.addresses[0].id;
    renderCheckoutBody();
  }).catch(function (e) { $('#co-body').innerHTML = errBox(e.message); });
}
function renderCheckoutBody() {
  var addrs = V.addresses || [];
  var addrHtml = '<div class="sec-title" style="margin-top:0">' + esc(t('deliveryAddr')) + '</div>';
  if (V.addrForm) {
    var f = V.addrForm.data || {};
    addrHtml += '<div class="form-card"><b>' + esc(V.addrForm.id ? t('editAddr') : t('addNewAddr')) + '</b>' +
      '<form id="f-addr" class="mt">' +
      '<div class="lbl">' + esc(t('label')) + '</div>' +
      '<select class="inp" id="a-label">' +
        ['Home', 'Work', 'Other'].map(function (l) {
          return '<option value="' + l + '"' + (f.label === l ? ' selected' : '') + '>' + esc(t(l === 'Home' ? 'homeL' : l === 'Work' ? 'workL' : 'otherL')) + '</option>';
        }).join('') + '</select>' +
      '<div class="lbl">' + esc(t('addrLine')) + '</div>' +
      '<textarea class="inp" id="a-line" required>' + esc(f.line1 || f.address_line || f.address || '') + '</textarea>' +
      '<div class="row"><div style="flex:1"><div class="lbl">' + esc(t('city')) + '</div>' +
      '<input class="inp" id="a-city" value="' + esc(f.city || 'Nellore') + '"></div>' +
      '<div style="flex:1"><div class="lbl">' + esc(t('pincode')) + '</div>' +
      '<input class="inp" id="a-pin" inputmode="numeric" maxlength="6" value="' + esc(String(f.line2 || f.pincode || '').replace(/^PIN\s*/, '')) + '"></div></div>' +
      '<div class="row mt"><button class="btn btn-primary" style="flex:1" type="submit">' + esc(t('save')) + '</button>' +
      '<button class="btn btn-ghost" type="button" data-act="addr-cancel">' + esc(t('cancel')) + '</button></div>' +
      '</form></div>';
  } else {
    addrHtml += addrs.map(function (a) {
      var sel = String(V.addrId) === String(a.id);
      return '<div class="addr-card' + (sel ? ' sel' : '') + '" data-act="addr-sel" data-id="' + esc(a.id) + '">' +
        '<div class="addr-top"><span class="radio"></span><span class="addr-label">' + esc(a.label || 'Home') + '</span>' +
        '<span class="addr-acts"><button data-act="addr-edit" data-id="' + esc(a.id) + '">' + esc(t('change')) + '</button>' +
        '<button class="del" data-act="addr-del" data-id="' + esc(a.id) + '">' + esc(t('del')) + '</button></span></div>' +
        '<div class="small mt">' + esc(a.line1 || a.address_line || a.address || '') + '</div>' +
        '<div class="small muted">' + esc([a.line2, a.city].filter(function (x) { return x; }).join(', ')) + '</div></div>';
    }).join('') +
    '<button class="btn btn-ghost btn-block btn-sm mb" data-act="addr-new">+ ' + esc(t('addNewAddr')) + '</button>';
  }
  var itemsHtml = cart.items.map(function (x) {
    return '<div class="bill-row"><span><span class="veg-dot ' + (x.veg ? 'v' : 'n') + '" style="margin-right:7px"><i></i></span>' +
      esc(x.name) + ' <span class="muted">x' + x.qty + '</span></span><span>' + fmt(x.qty * Number(x.price_paise || 0)) + '</span></div>';
  }).join('');
  var html = '<button class="back-link" data-act="back">' + icon('back') + esc(cart.restaurant_name || t('checkout')) + '</button>' +
    '<div class="checkout-grid"><div>' +
    addrHtml +
    '<div class="sec-title">' + esc(t('payMethod')) + '</div>' +
    [['upi', 'upi', t('upi'), t('upiSub')], ['card', 'card', t('card'), t('cardSub')], ['cod', 'cash', t('cod'), t('codSub')]].map(function (p) {
      return '<div class="pay-opt' + (V.payMethod === p[0] ? ' sel' : '') + '" data-act="pay" data-m="' + p[0] + '">' +
        '<span class="radio"></span>' + icon(p[1]) + '<div>' + esc(p[2]) + '<small>' + esc(p[3]) + '</small></div></div>';
    }).join('') +
    '<div class="otp-note">' + icon('clock') + ' ' + esc(t('promiseNote')) + '</div>' +
    '</div>' +
    '<div class="panel sticky"><h3>' + esc(t('billDetails')) + '</h3>' +
    '<div class="summary-list">' + itemsHtml +
      '<div class="bill-row"><span class="muted">' + esc(t('subtotal')) + '</span><span>' + fmt(cartTotal()) + '</span></div></div>' +
    '<div class="lbl">' + esc(t('couponPh')) + '</div>' +
    '<input class="inp" id="coupon" placeholder="' + esc(t('couponPh')) + '" value="' + esc(V.coupon) + '">' +
    '<div class="row mt mb" style="justify-content:space-between">' +
      '<div><b>' + esc(t('useCredits')) + '</b><div class="small muted">' + esc(t('walletBal')) + ': ' + fmt(wallet) + '</div></div>' +
      '<label class="switch"><input type="checkbox" id="creditsUse"' + (V.useCredits ? ' checked' : '') + (wallet > 0 ? '' : ' disabled') + '><span class="tr"></span></label>' +
    '</div>' +
    '<div id="bill-box"><div class="small muted mb">' + esc(t('billLoading')) + '</div></div>' +
    '<button class="btn btn-primary btn-block" data-act="place" style="font-size:16px">' + esc(t('placeOrder')) + '</button>' +
    '</div></div>';
  $('#co-body').innerHTML = html;
  var fa = $('#f-addr');
  if (fa) fa.addEventListener('submit', saveAddress);
  var cu = $('#creditsUse');
  if (cu) cu.addEventListener('change', function () { V.useCredits = cu.checked; refreshQuote(); });
  var cp = $('#coupon');
  if (cp) cp.addEventListener('change', function () { V.coupon = cp.value.trim(); refreshQuote(); });
  refreshQuote();
}
/* Fetch the exact bill from the backend quote endpoint and render it before
   the customer taps Place Order. Same pricing engine as order placement. */
function refreshQuote() {
  var box = $('#bill-box');
  if (!box || !cart.items.length) return;
  if (!V.addrId) {
    box.innerHTML = '<div class="small muted mb">' + esc(t('needAddr')) + '</div>';
    return;
  }
  var couponEl = $('#coupon');
  var coupon = couponEl ? couponEl.value.trim() : (V.coupon || '');
  api('POST', '/api/orders/quote', {
    restaurant_id: cart.restaurant_id,
    address_id: V.addrId,
    items: cart.items.map(function (x) { return { menu_item_id: x.id, qty: x.qty }; }),
    coupon_code: coupon || undefined,
    use_credits: !!V.useCredits
  }).then(function (d) {
    if (!$('#bill-box')) return;
    V.quote = d.bill || null;
    renderBillBox(d);
  }).catch(function (e) {
    var b2 = $('#bill-box');
    if (b2) b2.innerHTML = errBox(e.message);
  });
}
function renderBillBox(d) {
  var box = $('#bill-box');
  if (!box) return;
  var b = d.bill || {};
  var html = '<div class="summary-list">';
  html += '<div class="bill-row"><span class="muted">' + esc(t('subtotal')) + '</span><span>' + fmt(b.subtotal_paise) + '</span></div>';
  if (b.discount_paise) html += '<div class="bill-row disc"><span>' + esc(t('discount')) + '</span><span>&minus;' + fmt(b.discount_paise) + '</span></div>';
  html += '<div class="bill-row"><span class="muted">' + esc(t('deliveryFee')) + '</span><span>' + (b.delivery_fee_paise ? fmt(b.delivery_fee_paise) : t('free')) + '</span></div>';
  html += '<div class="bill-row"><span class="muted">' + esc(t('platformFee')) + '</span><span>' + fmt(b.platform_fee_paise) + '</span></div>';
  if (b.tax_paise) html += '<div class="bill-row"><span class="muted">' + esc(t('tax')) + '</span><span>' + fmt(b.tax_paise) + '</span></div>';
  if (b.credits_used_paise) html += '<div class="bill-row disc"><span>' + esc(t('creditsUsed')) + '</span><span>&minus;' + fmt(b.credits_used_paise) + '</span></div>';
  html += '<div class="bill-row total"><span>' + esc(t('toPay')) + '</span><span>' + fmt(b.total_paise) + '</span></div></div>';
  if (d.coupon_error) html += '<div class="small" style="color:var(--red)">' + esc(d.coupon_error) + '</div>';
  box.innerHTML = html;
  var btn = $('[data-act="place"]');
  if (btn) btn.innerHTML = esc(t('placeOrder')) + ' &middot; ' + fmt(b.total_paise);
}
function saveAddress(e) {
  e.preventDefault();
  var line1 = $('#a-line').value.trim();
  var pin = $('#a-pin').value.trim();
  var payload = {
    label: $('#a-label').value,
    line1: line1,
    line2: pin ? 'PIN ' + pin : null,
    city: $('#a-city').value.trim() || 'Nellore'
  };
  if (!payload.line1) return;
  var id = V.addrForm.id;
  var p = id ? api('PUT', '/api/customer/addresses/' + id, payload) : api('POST', '/api/customer/addresses', payload);
  p.then(function (d) {
    var saved = d.address || d;
    toast(t('addrSaved'));
    V.addrForm = null;
    return api('GET', '/api/customer/addresses').then(function (r) {
      V.addresses = r.addresses || r.items || [];
      if (saved && saved.id) V.addrId = saved.id;
      renderCheckoutBody();
    });
  }).catch(function (err) { toast(err.message, true); });
}
function placeOrder() {
  if (!V.addrId) { toast(t('needAddr'), true); return; }
  var couponEl = $('#coupon');
  var coupon = couponEl ? couponEl.value.trim() : '';
  var btn = $('[data-act="place"]');
  if (btn) { btn.disabled = true; btn.textContent = t('loading'); }
  api('POST', '/api/orders', {
    restaurant_id: cart.restaurant_id,
    address_id: V.addrId,
    items: cart.items.map(function (x) { return { menu_item_id: x.id, qty: x.qty }; }),
    coupon_code: coupon || undefined,
    payment_method: V.payMethod,
    use_credits: !!V.useCredits
  }).then(function (d) {
    var order = d.order || {};
    V.pending = { order: order, bill: d.bill || {}, promise_minutes: d.promise_minutes, payment_method: V.payMethod };
    if (V.payMethod === 'cod') {
      clearCart();
      V.pending = null;
      toast(t('orderConfirmed'));
      location.hash = '#/tracking/' + order.id;
    } else {
      location.hash = '#/payment';
    }
  }).catch(function (err) { toast(err.message, true); if (btn) { btn.disabled = false; renderCheckoutBody(); } });
}
function billRows(bill) {
  var rows = [];
  Object.keys(bill || {}).forEach(function (k) {
    var v = bill[k];
    if (/_paise$/i.test(k) && typeof v === 'number') {
      var lbl = k.replace(/_paise$/i, '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
      rows.push({ label: lbl, val: fmt(v), total: /^(grand_)?total_paise$/i.test(k), disc: /discount|credit|off/i.test(k) && v > 0 });
    }
  });
  return rows;
}
function viewPayment() {
  var p = V.pending;
  if (!p || !p.order || !p.order.id) { location.hash = '#/orders'; return; }
  var rows = billRows(p.bill);
  var totalRow = rows.find(function (r) { return r.total; });
  var otherRows = rows.filter(function (r) { return !r.total; });
  var totalPaise = p.bill.total_paise != null ? p.bill.total_paise : p.bill.grand_total_paise;
  $('#app').innerHTML = shell(
    '<div class="panel pay-hero mb">' +
      '<div class="lbl">' + esc(t('confirmPay')) + '</div>' +
      '<div class="amt">' + (totalPaise != null ? fmt(totalPaise) : (totalRow ? totalRow.val : '')) + '</div>' +
      '<div class="small muted">' + esc(t('paySecure')) + ' &middot; ' + esc(t(p.payment_method === 'card' ? 'card' : 'upi')) + '</div>' +
      (p.promise_minutes ? '<div class="mt"><span class="badge promise">' + icon('clock') + esc(t('promise')) + ' &middot; ' + esc(p.promise_minutes) + ' ' + esc(t('mins')) + '</span></div>' : '') +
    '</div>' +
    '<div class="sec-title">' + esc(t('billDetails')) + '</div><div class="card mb">' +
      otherRows.map(function (r) {
        return '<div class="bill-row' + (r.disc ? ' disc' : '') + '"><span>' + esc(r.label) + '</span><span>' + (r.disc ? '\u2212' : '') + esc(r.val) + '</span></div>';
      }).join('') +
      (totalRow ? '<div class="bill-row total"><span>' + esc(totalRow.label) + '</span><span>' + esc(totalRow.val) + '</span></div>' : '') +
    '</div>' +
    '<button class="btn btn-primary btn-block" data-act="paynow" style="font-size:16px">' + icon('upi') + esc(t('payNow')) + '</button>' +
    '<div class="otp-note mt">' + esc(t('promiseNote')) + '</div>',
    'home');
}
function payNow() {
  var p = V.pending;
  if (!p) return;
  var btn = $('[data-act="paynow"]');
  if (btn) { btn.disabled = true; btn.textContent = t('loading'); }
  api('POST', '/api/orders/' + p.order.id + '/pay').then(function () {
    clearCart();
    V.pending = null;
    refreshWallet();
    toast(t('orderConfirmed'));
    location.hash = '#/tracking/' + p.order.id;
  }).catch(function (err) { toast(err.message, true); if (btn) { btn.disabled = false; btn.innerHTML = icon('upi') + esc(t('payNow')); } });
}

/* ---------------- tracking ---------------- */
var STEPS = [
  ['placed', 'Order placed'], ['confirmed', 'Confirmed'], ['preparing', 'Preparing'],
  ['picked_up', 'Picked up'], ['delivered', 'Delivered']
];
var STEP_ALIAS = { on_the_way: 'picked_up', dispatched: 'picked_up', out_for_delivery: 'picked_up', ready: 'preparing', accepted: 'confirmed', cooking: 'preparing' };
function normStatus(s) {
  s = String(s || '').toLowerCase();
  return STEP_ALIAS[s] || s;
}
function viewTracking(id) {
  V.trackId = id;
  $('#app').innerHTML = shell('<div id="track-body">' + skel(120) + skel(200) + '</div>', 'orders');
  loadTracking(false);
  trackTimer = setInterval(function () { loadTracking(true); }, 15000);
}
function loadTracking(silent) {
  api('GET', '/api/orders/' + V.trackId).then(function (d) {
    var o = d.order || d;
    renderTrackingBody(o);
    if (String(normStatus(o.status)) === 'delivered' || String(normStatus(o.status)) === 'cancelled') {
      if (trackTimer) { clearInterval(trackTimer); trackTimer = null; }
    }
  }).catch(function (e) {
    if (!silent) $('#track-body').innerHTML = errBox(e.message);
  });
}
function renderTrackingBody(o) {
  var st = normStatus(o.status);
  var box = $('#track-body');
  if (!box) return;
  var main = '';
  if (st === 'cancelled') {
    main += '<div class="card mb" style="text-align:center"><b>' + esc(t('cancelledMsg')) + '</b></div>';
  } else if (st === 'delivered') {
    main += '<div class="cd-card"><div><div class="t">' + esc(t('orderId')) + ' #' + esc(o.id) + '</div><div class="v">' + esc(t('deliveredMsg')) + '</div></div></div>';
  } else if (o.promised_at) {
    main += '<div class="cd-card" id="cd-card">' + icon('clock') +
      '<div><div class="t">' + esc(t('arrivingIn')) + '</div><div class="v" id="cd-val">--</div></div></div>';
  }
  // timeline
  var idx = STEPS.findIndex(function (s) { return s[0] === st; });
  if (st !== 'cancelled' && st !== 'delivered') {
    main += '<div class="card mb"><div class="tl">' + STEPS.map(function (s, i) {
      var cls = i < idx ? 'done' : (i === idx ? 'cur' : '');
      var ic = i < idx ? 'check' : (s[0] === 'picked_up' ? 'bike' : s[0] === 'delivered' ? 'box' : 'clock');
      return '<div class="t-step ' + cls + '"><div class="t-dot">' + icon(ic) + '</div>' +
        '<div><div class="t-lbl">' + esc(s[1]) + '</div>' +
        (i === idx && o.status_display ? '<div class="t-sub">' + esc(o.status_display) + '</div>' : '') + '</div></div>';
    }).join('') + '</div></div>';
  }
  // rider
  if (o.rider_name || o.rider_phone) {
    main += '<div class="card mb"><div class="sec-title" style="margin:0 0 8px">' + esc(t('yourRider')) + '</div>' +
      '<div class="rider-card"><div class="rider-av">' + icon('bike') + '</div>' +
      '<div style="flex:1"><b>' + esc(o.rider_name || t('yourRider')) + '</b>' +
      (o.rider_phone ? '<div class="small muted">' + esc(o.rider_phone) + '</div>' : '') + '</div>' +
      (o.rider_phone ? '<a class="btn btn-ghost btn-sm" href="tel:' + esc(o.rider_phone.replace(/\s/g, '')) + '">' + icon('phone') + esc(t('call')) + '</a>' : '') +
      '</div></div>';
  }
  // pickup photo
  if (o.pickup_photo) {
    main += '<div class="card mb"><div class="sec-title" style="margin:0 0 4px">' + esc(t('pickupPhoto')) + '</div>' +
      '<div class="pickup-img"><img src="' + esc(o.pickup_photo) + '" alt="pickup" loading="lazy"></div></div>';
  }
  // items + bill (side panel)
  var items = o.items || [];
  var side = '<div class="panel sticky"><h3>' + esc(t('orderId')) + ' #' + esc(o.id) + '</h3><div class="summary-list">';
  side += items.map(function (x) {
    return '<div class="bill-row"><span>' + esc(x.name || x.menu_item_name || 'Item') + ' <span class="muted">x' + esc(x.qty || x.quantity || 1) + '</span></span>' +
      '<span>' + (x.price_paise != null ? fmt(Number(x.price_paise) * Number(x.qty || x.quantity || 1)) : '') + '</span></div>';
  }).join('');
  billRows(o.bill || {}).forEach(function (r) {
    side += '<div class="bill-row' + (r.total ? ' total' : r.disc ? ' disc' : '') + '"><span>' + esc(r.label) + '</span><span>' + esc(r.val) + '</span></div>';
  });
  if (o.total_paise != null) side += '<div class="bill-row total"><span>' + esc(t('toPay')) + '</span><span>' + fmt(o.total_paise) + '</span></div>';
  side += '</div><div class="small muted mt">' + esc(t('placedOn')) + ': ' + esc(fmtDT(o.created_at || o.placed_at)) + '</div></div>';
  side += '<div class="otp-note">' + esc(t('otpNote')) + '</div>';
  if (st === 'picked_up' || st === 'on_way') {
    side += '<button class="btn btn-ghost btn-block btn-sm mt" data-act="otp-resend" data-id="' + esc(o.id) + '">' + esc(t('resendOtp')) + '</button>';
  }
  box.innerHTML = '<div class="tracking-grid"><div>' + main + '</div><div>' + side + '</div></div>';
  startCountdown(o.promised_at, st);
}
function startCountdown(promisedAt, st) {
  if (cdTimer) { clearInterval(cdTimer); cdTimer = null; }
  if (!promisedAt || st === 'delivered' || st === 'cancelled') return;
  var target = new Date(promisedAt).getTime();
  var el = function () { return $('#cd-val'); };
  var card = function () { return $('#cd-card'); };
  function tick() {
    var v = el(); if (!v) { clearInterval(cdTimer); return; }
    var diff = target - Date.now();
    if (diff <= 0) {
      v.textContent = t('runningLate');
      var c = card(); if (c) c.classList.add('late');
      return;
    }
    var m = Math.floor(diff / 60000), s = Math.floor((diff % 60000) / 1000);
    v.textContent = m + ':' + (s < 10 ? '0' : '') + s + ' ' + t('mins');
  }
  tick();
  cdTimer = setInterval(tick, 1000);
}

/* ---------------- orders ---------------- */
function viewOrders() {
  $('#app').innerHTML = shell('<div id="orders-body">' + skel(120) + skel(120) + '</div>', 'orders');
  api('GET', '/api/orders').then(function (d) {
    if (!$('#orders-body')) return;
    var list = d.orders || [];
    if (!list.length) { $('#orders-body').innerHTML = emptyBox('orders', t('noOrders')); return; }
    var active = list.filter(function (o) { return ['placed', 'confirmed', 'preparing', 'picked_up'].indexOf(normStatus(o.status)) >= 0; });
    var past = list.filter(function (o) { return ['placed', 'confirmed', 'preparing', 'picked_up'].indexOf(normStatus(o.status)) < 0; });
    function card(o) {
      var st = normStatus(o.status);
      var items = (o.items || []).map(function (x) { return esc(x.name || x.menu_item_name || 'Item') + ' x' + esc(x.qty || x.quantity || 1); }).join(', ');
      var cancellable = ['placed', 'confirmed'].indexOf(st) >= 0;
      var delivered = st === 'delivered';
      var trackable = ['placed', 'confirmed', 'preparing', 'picked_up'].indexOf(st) >= 0;
      return '<div class="o-card"><div class="o-top"><b>' + esc(o.restaurant_name || t('orderId') + ' #' + o.id) + '</b>' +
        '<span class="st ' + esc(st) + '">' + esc(st.replace(/_/g, ' ')) + '</span></div>' +
        '<div class="small muted">#' + esc(o.id) + ' &middot; ' + esc(fmtDT(o.created_at || o.placed_at)) +
        (o.total_paise != null ? ' &middot; <b style="color:var(--ink)">' + fmt(o.total_paise) + '</b>' : '') + '</div>' +
        (items ? '<div class="small mt">' + items + '</div>' : '') +
        '<div class="o-acts">' +
        (trackable ? '<button class="btn btn-primary btn-sm" data-act="track" data-id="' + esc(o.id) + '">' + esc(t('trackOrder')) + '</button>' : '') +
        '<button class="btn btn-ghost btn-sm" data-act="reorder" data-id="' + esc(o.id) + '">' + esc(t('reorder')) + '</button>' +
        (cancellable ? '<button class="btn btn-danger btn-sm" data-act="cancel-order" data-id="' + esc(o.id) + '">' + esc(t('cancelOrder')) + '</button>' : '') +
        (delivered ? '<button class="btn btn-ghost btn-sm" data-act="rate" data-id="' + esc(o.id) + '">' + icon('star') + esc(t('rateOrder')) + '</button>' : '') +
        (delivered ? '<button class="btn btn-ghost btn-sm" data-act="cold" data-id="' + esc(o.id) + '">' + icon('alert') + esc(t('coldFood')) + '</button>' : '') +
        '</div></div>';
    }
    $('#orders-body').innerHTML =
      (active.length ? '<div class="sec-title" style="margin-top:0">' + esc(t('active')) + '</div>' + active.map(card).join('') : '') +
      (past.length ? '<div class="sec-title">' + esc(t('past')) + '</div>' + past.map(card).join('') : '');
  }).catch(function (e) { $('#orders-body').innerHTML = errBox(e.message); });
}
function doReorder(id) {
  api('GET', '/api/orders/' + id).then(function (d) {
    var o = d.order || d;
    var items = (o.items || []).map(function (x) {
      var mid = x.menu_item_id || x.menuItemId || x.item_id;
      if (!mid) return null;
      return { id: mid, name: x.name || x.menu_item_name || 'Item', price_paise: Number(x.price_paise || x.price || 0), veg: !!x.veg, qty: Number(x.qty || x.quantity || 1) };
    }).filter(Boolean);
    if (!items.length) { toast(t('reorderFail'), true); return; }
    cart = { restaurant_id: o.restaurant_id, restaurant_name: o.restaurant_name || '', items: items };
    location.hash = '#/checkout';
  }).catch(function (e) { toast(e.message, true); });
}
function openRateModal(id) {
  V.rating = { orderId: id, food: 0, delivery: 0 };
  function stars(group) {
    var html = '<div class="stars" id="stars-' + group + '">';
    for (var i = 1; i <= 5; i++) html += '<button data-act="star" data-g="' + group + '" data-v="' + i + '">' + icon('star') + '</button>';
    return html + '</div>';
  }
  openModal('<h3 class="mb" style="text-align:center">' + esc(t('rateOrder')) + '</h3>' +
    '<div class="lbl" style="text-align:center">' + esc(t('foodQ')) + '</div>' + stars('food') +
    '<div class="lbl" style="text-align:center">' + esc(t('deliveryQ')) + '</div>' + stars('delivery') +
    '<textarea class="inp mt" id="rate-comment" placeholder="' + esc(t('commentPh')) + '"></textarea>' +
    '<button class="btn btn-primary btn-block mt" data-act="rate-submit">' + esc(t('submit')) + '</button>' +
    '<button class="btn btn-ghost btn-block mt" data-act="close-modal">' + esc(t('cancel')) + '</button>');
}
function paintStars() {
  ['food', 'delivery'].forEach(function (g) {
    var box = $('#stars-' + g); if (!box) return;
    var btns = box.querySelectorAll('button');
    btns.forEach(function (b, i) { b.classList.toggle('on', i < V.rating[g]); });
  });
}
function submitRating() {
  var r = V.rating;
  if (!r.food || !r.delivery) { toast(t('rateOrder'), true); return; }
  var comment = ($('#rate-comment') || {}).value || '';
  api('POST', '/api/orders/' + r.orderId + '/rate', { food_rating: r.food, delivery_rating: r.delivery, comment: comment })
    .then(function () { closeModal(); toast(t('rateThanks')); router(); })
    .catch(function (e) { toast(e.message, true); });
}
function confirmCancelOrder(id) {
  openModal('<h3 class="mb">' + esc(t('cancelQ')) + '</h3>' +
    '<button class="btn btn-danger btn-block mb" data-act="cancel-yes" data-id="' + esc(id) + '">' + esc(t('cancelOrder')) + '</button>' +
    '<button class="btn btn-ghost btn-block" data-act="close-modal">' + esc(t('cancel')) + '</button>');
}
function openColdModal(id) {
  V.coldId = id;
  openModal('<h3 class="mb">' + esc(t('coldTitle')) + '</h3><p class="muted mb">' + esc(t('coldMsg')) + '</p>' +
    '<button class="btn btn-primary btn-block mb" data-act="cold-yes">' + esc(t('reportBtn')) + '</button>' +
    '<button class="btn btn-ghost btn-block" data-act="close-modal">' + esc(t('cancel')) + '</button>');
}

/* ---------------- support ---------------- */
function viewSupport() {
  $('#app').innerHTML = shell(
    '<div class="support-grid"><div><div class="form-card"><b>' + esc(t('newTicket')) + '</b>' +
      '<form id="f-ticket" class="mt"><div class="lbl">' + esc(t('subjectPh')) + '</div>' +
      '<input class="inp" id="tk-subject" maxlength="120" required>' +
      '<div class="lbl">' + esc(t('msgPh')) + '</div>' +
      '<textarea class="inp" id="tk-msg" required></textarea>' +
      '<button class="btn btn-primary btn-block mt" type="submit">' + icon('send') + esc(t('submit')) + '</button></form></div></div>' +
    '<div><div class="sec-title" style="margin-top:0">' + esc(t('tickets')) + '</div><div id="tickets-list">' + skel(80) + skel(80) + '</div></div></div>',
    'support');
  $('#f-ticket').addEventListener('submit', function (e) {
    e.preventDefault();
    var subject = $('#tk-subject').value.trim(), message = $('#tk-msg').value.trim();
    if (!subject || !message) return;
    var btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    api('POST', '/api/customer/support/tickets', { subject: subject, message: message })
      .then(function () { toast(t('ticketDone')); $('#tk-subject').value = ''; $('#tk-msg').value = ''; loadTickets(); })
      .catch(function (err) { toast(err.message, true); })
      .then(function () { btn.disabled = false; });
  });
  loadTickets();
}
function loadTickets() {
  var box = $('#tickets-list');
  if (!box) return;
  api('GET', '/api/customer/support/tickets').then(function (d) {
    var list = d.tickets || [];
    box.innerHTML = list.length ? list.map(function (x) {
      return '<div class="t-item"><div class="row"><b>' + esc(x.subject || 'Ticket') + '</b>' +
        '<span class="st-pill" style="margin-left:auto">' + esc(x.status || 'open') + '</span></div>' +
        '<div class="small mt">' + esc(x.message || '') + '</div>' +
        (x.reply || x.response ? '<div class="otp-note mt"><b>Support:</b> ' + esc(x.reply || x.response) + '</div>' : '') +
        '<div class="small muted mt">' + esc(fmtDT(x.created_at)) + '</div></div>';
    }).join('') : emptyBox('support', t('noTickets'));
  }).catch(function (e) { box.innerHTML = errBox(e.message); });
}

/* ---------------- global click delegation ---------------- */
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-act]');
  if (!el) return;
  var act = el.getAttribute('data-act');
  var id = el.getAttribute('data-id');
  switch (act) {
    case 'scroll-rest': { var rl = document.getElementById('rest-list'); if (rl) rl.scrollIntoView({ behavior: 'smooth', block: 'start' }); break; }
    case 'logout': logout(); toast(t('logout')); break;
    case 'notif': openNotifDrawer(); break;
    case 'wallet': openWalletDrawer(); break;
    case 'close-drawer': closeDrawer(); break;
    case 'close-modal': closeModal(); break;
    case 'back': e.preventDefault(); history.back(); break;
    case 'retry': router(); break;
    case 'to-phone': V.phase = 'phone'; viewLogin(); break;
    case 'fav': e.stopPropagation(); toggleFav(id); break;
    case 'rest': location.hash = '#/restaurant/' + id; break;
    case 'veg': homeState.vegOnly = !homeState.vegOnly; router(); break;
    case 'favs': homeState.favOnly = !homeState.favOnly; router(); break;
    case 'menuveg': V.menuVeg = !V.menuVeg; refreshMenuControls(); break;
    case 'add': addToCart(id); break;
    case 'inc': changeQty(id, 1); break;
    case 'dec': changeQty(id, -1); break;
    case 'clear-yes':
      closeModal();
      clearCart();
      if (V.pendingAdd) { var p = V.pendingAdd; V.pendingAdd = null; addToCart(p); }
      break;
    case 'cart-go': if (!cart.items.length) { toast(t('cartEmpty'), true); } else { location.hash = '#/checkout'; } break;
    case 'addr-sel': V.addrId = String(id); renderCheckoutBody(); break;
    case 'addr-new': V.addrForm = { id: null, data: {} }; renderCheckoutBody(); break;
    case 'addr-edit': {
      var a = (V.addresses || []).find(function (x) { return String(x.id) === String(id); });
      V.addrForm = { id: String(id), data: a || {} }; renderCheckoutBody(); break;
    }
    case 'addr-del':
      openModal('<h3 class="mb">' + esc(t('delAddrQ')) + '</h3>' +
        '<button class="btn btn-danger btn-block mb" data-act="addr-del-yes" data-id="' + esc(id) + '">' + esc(t('del')) + '</button>' +
        '<button class="btn btn-ghost btn-block" data-act="close-modal">' + esc(t('cancel')) + '</button>');
      break;
    case 'addr-del-yes':
      closeModal();
      api('DELETE', '/api/customer/addresses/' + id).then(function () {
        toast(t('addrDeleted'));
        return api('GET', '/api/customer/addresses');
      }).then(function (r) {
        V.addresses = r.addresses || r.items || [];
        if (String(V.addrId) === String(id)) V.addrId = V.addresses.length ? V.addresses[0].id : null;
        renderCheckoutBody();
      }).catch(function (err) { toast(err.message, true); });
      break;
    case 'addr-cancel': V.addrForm = null; renderCheckoutBody(); break;
    case 'pay': V.payMethod = el.getAttribute('data-m'); renderCheckoutBody(); break;
    case 'place': placeOrder(); break;
    case 'paynow': payNow(); break;
    case 'track': location.hash = '#/tracking/' + id; break;
    case 'reorder': doReorder(id); break;
    case 'cancel-order': confirmCancelOrder(id); break;
    case 'cancel-yes':
      closeModal();
      api('POST', '/api/orders/' + id + '/cancel').then(function () { toast(t('cancelDone')); router(); })
        .catch(function (err) { toast(err.message, true); });
      break;
    case 'rate': openRateModal(id); break;
    case 'star': V.rating[el.getAttribute('data-g')] = Number(el.getAttribute('data-v')); paintStars(); break;
    case 'rate-submit': submitRating(); break;
    case 'cold': openColdModal(id); break;
    case 'cold-yes':
      closeModal();
      api('POST', '/api/orders/' + V.coldId + '/report', { type: 'cold_food' })
        .then(function () { toast(t('coldCredit')); refreshWallet(); })
        .catch(function (err) { toast(err.message, true); });
      break;
    case 'otp-resend': {
      var rb = el; rb.disabled = true;
      api('POST', '/api/orders/' + id + '/delivery-otp')
        .then(function () { toast(t('otpResent')); })
        .catch(function (err) { toast(err.message || t('otpResendFail'), true); rb.disabled = false; });
      break;
    }
  }
});
// keep coupon input in sync when checkout re-renders
document.addEventListener('input', function (e) {
  if (e.target && e.target.id === 'coupon') V.coupon = e.target.value;
});

/* ---------------- init ---------------- */
document.addEventListener('DOMContentLoaded', function () {
  if (!location.hash) location.hash = token ? '#/home' : '#/login';
  router();
  if (token) refreshWallet();
});
