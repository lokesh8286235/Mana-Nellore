// Customer order lifecycle: place, pay, track, cancel, rate.
// Pricing is computed server-side from pricing_config — clients never send totals.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireRole, ah } = require('../middleware/auth');
const { haversineKm, loadPricingConfig, computeQuote, computeTax, otwSecondaryFeePaise, tripPayoutPaise } = require('../lib/pricing');
const { resolveRestaurantCoords } = require('../lib/geocode');
const { pointToSegKm } = require('../lib/otw');
const { pushToUser } = require('../lib/fcm');

const router = express.Router();
router.use(authenticate, requireRole('customer'));

async function notify(userId, title, body) {
  await db.query('INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)', [
    userId, title, body
  ]);
}

// Customer snapshot (2026-11-27): freeze the ordering customer's name,
// phone and delivery address onto the order at placement. Account deletion
// anonymizes the live columns (recipient_*, delivery_*) but never touches
// these three, so the restaurant / rider / admin still know who ordered.
// `addressRow` may be null (dine-in/pickup); `pinLabel` is the confirmed
// pin label when the customer dragged the pin. Order-for-someone-else
// (recipient_name/phone) snapshots the recipient, not the account holder.
async function customerSnapshot(dbClient, userId, addressRow, pinLabel, recipientName, recipientPhone) {
  const u = await dbClient.query('SELECT name, phone FROM users WHERE id = $1', [userId]);
  const name = (recipientName && String(recipientName).trim()) || (u.rows[0] && u.rows[0].name) || null;
  const phone = (recipientPhone && String(recipientPhone).trim()) || (u.rows[0] && u.rows[0].phone) || null;
  let addr = pinLabel && String(pinLabel).trim() ? String(pinLabel).trim() : null;
  if (!addr && addressRow) {
    addr = [addressRow.line1, addressRow.line2, addressRow.city].filter(Boolean).join(', ') || null;
  }
  return { name, phone, address: addr };
}

async function transition(orderId, status, by) {
  const { rows } = await db.query('SELECT timeline FROM orders WHERE id = $1', [orderId]);
  const timeline = rows[0].timeline || [];
  timeline.push({ status, at: new Date().toISOString(), by });
  await db.query('UPDATE orders SET status = $1, timeline = $2::jsonb WHERE id = $3', [
    status, JSON.stringify(timeline), orderId
  ]);
}

// Transactional variant of transition(): same SELECT-then-UPDATE, but on a
// client already inside BEGIN so a multi-order cancel is atomic — a failure
// mid-loop rolls the whole trip back instead of leaving it half-cancelled.
async function transitionTx(client, orderId, status, by) {
  const { rows } = await client.query('SELECT timeline FROM orders WHERE id = $1', [orderId]);
  const timeline = (rows[0] && rows[0].timeline) || [];
  timeline.push({ status, at: new Date().toISOString(), by });
  await client.query('UPDATE orders SET status = $1, timeline = $2::jsonb WHERE id = $3', [
    status, JSON.stringify(timeline), orderId
  ]);
}

function newDeliveryOtp() {
  // Use cryptographically secure RNG (not Math.random which is predictable)
  const crypto = require('crypto');
  return String(crypto.randomInt(1000, 10000));
}

// Order numbers: 6 random digits, collision-checked against the DB.
async function newOrderNumber(dbClient) {
  const crypto = require('crypto');
  for (let i = 0; i < 12; i++) {
    const num = String(crypto.randomInt(100000, 1000000));
    const { rows } = await dbClient.query('SELECT 1 FROM orders WHERE order_number = $1', [num]);
    if (!rows.length) return num;
  }
  // Astronomically unlikely fallback: timestamp-derived, still 6 digits.
  return String(Date.now()).slice(-6);
}

// Generate a fresh delivery OTP and its bcrypt hash (hash is stored, plain code is returned to caller).
async function freshDeliveryOtp() {
  const code = newDeliveryOtp();
  const hash = await bcrypt.hash(code, 8);
  return { code, hash };
}

// Ratings are 1–5 integers only. Anything else (0, 6, -5, "great", 4.5) is a
// 400 — unvalidated values would flow straight into AVG() rating aggregates.
// Returns the validated integer, or null when the field was not supplied.
function validateRatingValue(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) return undefined;
  return n;
}

// Payment methods the apps actually offer. Free text is rejected — an
// invented value stored verbatim would break invoices, rider COD handling
// and payment reconciliation downstream. Returns the normalized value, or
// null when the input is not an allowed method ('online' is the generic
// label for a gateway payment; the server itself stores 'razorpay' once a
// gateway payment verifies — see razorpay-verify).
const ALLOWED_PAYMENT_METHODS = ['cod', 'upi', 'card', 'online'];
function normalizePaymentMethod(pm) {
  if (pm == null || pm === '') return 'upi';
  const v = String(pm).trim().toLowerCase();
  return ALLOWED_PAYMENT_METHODS.includes(v) ? v : null;
}

// Tip is capped at the configured tip_max_paise (default Rs 500 —
// pricing_config key 'tip_max_paise', same value GET /api/config exposes).
// An uncapped tip let a client attach an arbitrary amount to an order.
function capTip(rawTip, config) {
  const max = Number(config && config.tipMaxPaise != null ? config.tipMaxPaise : 50000);
  return Math.min(Math.max(0, Math.round(Number(rawTip) || 0)), max);
}

// Shared item validation + pricing — quote and place MUST agree.
// An unknown item, an unavailable item, or a non-positive-integer qty is a
// 400 (never silently skipped, never coerced). Returns { subtotal, snapshots }
// with customization extras priced in. Thrown { status, message } objects are
// answered by the central error handler.
async function validateItems(dbClient, menuById, items) {
  let subtotal = 0;
  const snapshots = [];
  for (const it of items) {
    const m = menuById[it.menu_item_id];
    const qty = Number(it.qty);
    if (!m) throw { status: 400, message: 'A menu item is not from this restaurant' };
    if (!m.available) throw { status: 400, message: `"${m.name}" is currently unavailable` };
    if (!Number.isInteger(qty) || qty <= 0 || qty > 99) throw { status: 400, message: 'Quantity must be between 1 and 99' };
    let custExtra = 0;
    const custNames = [];
    if (Array.isArray(it.customizations) && it.customizations.length) {
      const optIds = it.customizations.map((c) => c.option_id).filter(Boolean);
      if (optIds.length) {
        const oRes = await dbClient.query(
          `SELECT o.id, o.name, o.price_paise FROM customization_options o
           JOIN customization_groups g ON g.id = o.group_id
           WHERE o.id = ANY($1) AND g.menu_item_id = $2`,
          [optIds, m.id]
        );
        for (const o of oRes.rows) { custExtra += Number(o.price_paise) || 0; custNames.push(o.name); }
      }
    }
    subtotal += (m.price_paise + custExtra) * qty;
    snapshots.push({
      menu_item_id: m.id,
      name_snapshot: m.name + (custNames.length ? ' (' + custNames.join(', ') + ')' : ''),
      unit_price_paise: m.price_paise + custExtra,
      qty,
      instructions: it.instructions || null,
      person_name: (it.person_name ? String(it.person_name).trim().slice(0, 50) : null) || null
    });
  }
  return { subtotal, snapshots };
}

// Shared coupon validation — quote and place MUST agree. The code must exist,
// be active and in-window, meet the minimum, pass the student check, AND be
// issued to the caller (coupon_issuances). Coupons have no public flag, so
// issuance-only: a code issued to user A cannot be redeemed by user B.
// Returns { discount, couponId, error } — quote reports the error softly,
// place throws it.
async function validateCoupon(dbClient, couponCode, subtotal, userId) {
  const code = String(couponCode).toUpperCase();
  const cRes = await dbClient.query('SELECT * FROM coupons WHERE code = $1 AND active = true', [code]);
  const coupon = cRes.rows[0];
  const now = new Date();
  if (!coupon) return { discount: 0, couponId: null, error: 'Invalid coupon code' };
  if (coupon.valid_from && new Date(coupon.valid_from) > now) return { discount: 0, couponId: null, error: 'Coupon not yet valid' };
  if (coupon.valid_to && new Date(coupon.valid_to) < now) return { discount: 0, couponId: null, error: 'Coupon expired' };
  if (subtotal < coupon.min_order_paise) {
    return { discount: 0, couponId: null, error: `Coupon needs a minimum order of Rs ${(coupon.min_order_paise / 100).toFixed(0)}` };
  }
  if (coupon.requires_student) {
    const uRes = await dbClient.query('SELECT is_student FROM users WHERE id = $1', [userId]);
    if (!uRes.rows[0] || !uRes.rows[0].is_student) return { discount: 0, couponId: null, error: 'This coupon is for verified students only' };
  }
  const issued = await dbClient.query(
    'SELECT 1 FROM coupon_issuances WHERE user_id = $1 AND coupon_code = $2 LIMIT 1',
    [userId, code]
  );
  if (!issued.rows[0]) return { discount: 0, couponId: null, error: 'This coupon was not issued to you' };
  let discount =
    coupon.discount_type === 'flat'
      ? coupon.value
      : Math.round((subtotal * coupon.value) / 100);
  if (coupon.max_discount_paise != null) discount = Math.min(discount, coupon.max_discount_paise);
  discount = Math.min(discount, subtotal);
  return { discount, couponId: coupon.id, error: null };
}

// POST /api/orders/quote { restaurant_id, address_id?, lat?, lng?, items, coupon_code?, order_type?, table_id?, tip_paise? }
// b816: optional lat/lng = live delivery location (dragged pin / picked address).
// When valid they override the saved address row for the fee (distance).
// Read-only bill preview: returns the exact fee breakdown the customer will
// pay, computed with the same pricing engine as order placement. No order created.
router.post(
  '/quote',
  ah(async (req, res) => {
    const { restaurant_id, address_id, lat, lng, items, coupon_code, order_type, table_id, tip_paise } = req.body;
    const dineIn = order_type === 'dinein';
    // b848 pickup: customer collects at the counter — no address, no distance,
    // no delivery fee, no platform fee (and no GST on either). Tip is a rider
    // gratuity, so it is 0 for pickup too.
    const pickup = order_type === 'pickup';
    if (!restaurant_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'restaurant_id and items are required' });
    }
    // b816: live delivery location override — the dragged pin / picked location
    // (mn_lat/mn_lng) may differ from the saved address row. Valid coords are
    // the delivery location: the fee follows the pin, not the saved row.
    // Null Island (0,0) is never a real location — it is ignored.
    let overrideLat = null;
    let overrideLng = null;
    const qLat = Number(lat);
    const qLng = Number(lng);
    if (Number.isFinite(qLat) && Number.isFinite(qLng) && !(qLat === 0 && qLng === 0)) {
      overrideLat = qLat;
      overrideLng = qLng;
    }
    if (!dineIn && !pickup && !address_id && overrideLat == null) {
      return res.status(400).json({ error: 'address_id is required for delivery orders' });
    }
    const rRes = await db.query(
      "SELECT id, lat, lng, address, commission_pct, is_open FROM restaurants WHERE id = $1 AND status = 'approved' AND COALESCE(is_coming_soon, false) = false",
      [restaurant_id]
    );
    const restaurant = rRes.rows[0];
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not available' });
    if (!restaurant.is_open) return res.status(400).json({ error: 'Restaurant is currently closed' });

    let address = null;
    if (!dineIn && !pickup) {
      if (overrideLat != null) {
        // Live location wins for the fee; the saved row (if any) is only a label.
        // A stale address_id no longer 400s the quote when a live location exists.
        address = { lat: overrideLat, lng: overrideLng };
      } else {
        const aRes = await db.query('SELECT lat, lng FROM addresses WHERE id = $1 AND user_id = $2', [
          address_id,
          req.user.id
        ]);
        address = aRes.rows[0];
        if (!address) return res.status(400).json({ error: 'Delivery address not found' });
      }
    } else if (dineIn && table_id) {
      const tRes = await db.query('SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2', [
        table_id, restaurant_id
      ]);
      if (!tRes.rows[0]) return res.status(400).json({ error: 'Table not found for this restaurant' });
    }

    const ids = items.map((i) => i.menu_item_id);
    const mRes = await db.query(
      'SELECT id, name, price_paise, available FROM menu_items WHERE id = ANY($1) AND restaurant_id = $2',
      [ids, restaurant_id]
    );
    const menuById = Object.fromEntries(mRes.rows.map((m) => [m.id, m]));
    // First validation covers ONLY the primary restaurant's items. Items from
    // secondary restaurants are validated per-group below (groupsOut block);
    // validating ALL items against the primary's menu here would 400 any
    // multi-restaurant quote before the grouping is ever reached.
    const primaryItems = items.filter(
      (i) => String(i.restaurant_id || restaurant_id) === String(restaurant_id)
    );
    const { subtotal } = await validateItems(db, menuById, primaryItems);

    // Coupon (same checks as place; quote reports problems softly)
    let discount = 0;
    let couponError = null;
    if (coupon_code) {
      const checked = await validateCoupon(db, coupon_code, subtotal, req.user.id);
      discount = checked.discount;
      couponError = checked.error;
    }

    // b862: a restaurant without a pin still gets a real distance-based fee —
    // its typed address is geocoded (cached server-side). No pin and no usable
    // address keeps the existing base-fee fallback (distanceKm stays null).
    let distanceKm = null;
    let restCoords = null;
    if (!dineIn && !pickup && address && address.lat != null && address.lng != null) {
      restCoords = await resolveRestaurantCoords(restaurant);
      if (restCoords) {
        distanceKm = haversineKm(
          restCoords.lat,
          restCoords.lng,
          Number(address.lat),
          Number(address.lng)
        );
      }
    }
    const config = await loadPricingConfig(db);
    const tipPaise = pickup ? 0 : capTip(tip_paise, config);
    const quote = computeQuote({
      config,
      distanceKm: (dineIn || pickup) ? 0 : distanceKm,
      subtotalPaise: subtotal,
      discountPaise: discount,
      commissionPct: restaurant.commission_pct,
      deliveryFeePaiseOverride: (dineIn || pickup) ? 0 : undefined,
      platformFeePaiseOverride: pickup ? 0 : undefined
    });

    // Multi-restaurant on-the-way quote: group items by restaurant_id (item-level).
    // primary = cart.restaurant_id (100% fee).
    // Secondaries within 500m of the primary→customer route: flat on-the-way
    // fee (Rs 5 default, config-driven). Secondaries beyond 500m stay in the
    // order but pay their FULL normal delivery fee (never removed).
    let groupsOut = null;
    if (!dineIn && !pickup) {
      const byRest = {};
      for (const it of items) {
        const rid = String(it.restaurant_id || restaurant_id);
        (byRest[rid] = byRest[rid] || []).push(it);
      }
      const rids = Object.keys(byRest);
      if (rids.length > 1) {
        const primaryRid = String(restaurant_id);
        const ordered = [primaryRid, ...rids.filter((r) => r !== primaryRid)];
        const rAll = await db.query(
          "SELECT id, lat, lng, address, commission_pct FROM restaurants WHERE id = ANY($1) AND status = 'approved' AND COALESCE(is_coming_soon, false) = false",
          [ordered]
        );
        const rMap = Object.fromEntries(rAll.rows.map((r) => [String(r.id), r]));
        const pR = rMap[primaryRid];
        groupsOut = [];
        for (let gi = 0; gi < ordered.length; gi++) {
          const rid = ordered[gi];
          const rr = rMap[rid];
          if (!rr) continue;
          const gItems = byRest[rid];
          const gIds = gItems.map((i) => i.menu_item_id);
          const gmRes = await db.query(
            'SELECT id, name, price_paise, available FROM menu_items WHERE id = ANY($1) AND restaurant_id = $2',
            [gIds, rid]
          );
          const gmById = Object.fromEntries(gmRes.rows.map((m) => [m.id, m]));
          const { subtotal: gSub } = await validateItems(db, gmById, gItems);
          // b862: same geocoded-address fallback as the primary quote.
          const rrCoords = await resolveRestaurantCoords(rr);
          let gDist = null;
          if (rrCoords && address.lat != null && address.lng != null) {
            gDist = haversineKm(rrCoords.lat, rrCoords.lng, Number(address.lat), Number(address.lng));
          }
          const gQuote = computeQuote({
            config,
            distanceKm: gDist,
            subtotalPaise: gSub,
            discountPaise: gi === 0 ? discount : 0,
            commissionPct: rr.commission_pct
          });
          const isPrim = gi === 0;
          // On-the-way check: secondary within 500m of the primary→customer
          // route segment gets the flat fee; beyond 500m it stays at FULL fee.
          let onTheWay = isPrim;
          if (!isPrim && restCoords &&
              address.lat != null && address.lng != null &&
              rrCoords) {
            onTheWay = pointToSegKm(
              rrCoords.lng, rrCoords.lat,
              restCoords.lng, restCoords.lat,
              Number(address.lng), Number(address.lat)
            ) <= 0.5;
          }
          // Primary: 100% of its own normal fee.
          // Secondary on-the-way: flat fee (Rs 5 default, config-driven).
          // Secondary off-route: FULL normal fee (kept, not removed).
          const secFee = isPrim ? gQuote.deliveryFeePaise
            : onTheWay ? otwSecondaryFeePaise(gQuote.deliveryFeePaise, config)
            : gQuote.deliveryFeePaise;
          // GST is charged on the ACTUAL fee (flat Rs 5 for on-the-way
          // secondaries, full fee otherwise), not the normal fee.
          const gTax = computeTax(
            config.taxRates,
            gSub - (gi === 0 ? discount : 0),
            secFee,
            isPrim ? gQuote.platformFeePaise : 0
          );
          groupsOut.push({
            restaurant_id: rid,
            is_primary: isPrim,
            on_the_way: onTheWay,
            distance_km: gDist == null ? null : Math.round(gDist * 100) / 100,
            subtotal_paise: gSub,
            normal_fee_paise: gQuote.deliveryFeePaise,
            delivery_fee_paise: secFee,
            platform_fee_paise: isPrim ? gQuote.platformFeePaise : 0,
            tax_paise: gTax.taxPaise,
            tax_breakdown: gTax.breakdown,
          });
        }
      }
    }

    const billDelivery = (dineIn || pickup) ? 0 : quote.deliveryFeePaise;
    const billPlatform = quote.platformFeePaise;
    // When groups exist, the bill sums across ALL groups (not just the primary)
    let billSubtotal = subtotal, totalDelivery = billDelivery, totalPlatform = billPlatform;
    let billTax = quote.taxPaise;
    let billTaxBreakdown = quote.taxBreakdown;
    if (groupsOut) {
      billSubtotal = groupsOut.reduce((s, g) => s + g.subtotal_paise, 0);
      totalDelivery = groupsOut.reduce((s, g) => s + g.delivery_fee_paise, 0);
      totalPlatform = groupsOut.reduce((s, g) => s + g.platform_fee_paise, 0);
      billTax = groupsOut.reduce((s, g) => s + g.tax_paise, 0);
      billTaxBreakdown = groupsOut.reduce((acc, g) => ({
        food_paise: acc.food_paise + (g.tax_breakdown.food_paise || 0),
        delivery_paise: acc.delivery_paise + (g.tax_breakdown.delivery_paise || 0),
        platform_paise: acc.platform_paise + (g.tax_breakdown.platform_paise || 0)
      }), { food_paise: 0, delivery_paise: 0, platform_paise: 0 });
    }

    res.json({
      bill: {
        subtotal_paise: billSubtotal,
        discount_paise: discount,
        delivery_fee_paise: (dineIn || pickup) ? 0 : totalDelivery,
        platform_fee_paise: totalPlatform,
        tax_paise: billTax,
        tax_breakdown: billTaxBreakdown,
        tip_paise: tipPaise,
        total_paise: ((dineIn || pickup) ? 0 : totalDelivery) + totalPlatform + billTax + tipPaise + (billSubtotal - discount)
      },
      groups: groupsOut,
      coupon_error: couponError,
      distance_km: distanceKm == null ? null : Math.round(distanceKm * 100) / 100,
      eta_minutes: Number(config.etaMinutes) || 30
    });
  })
);

// POST /api/orders { restaurant_id, address_id?, order_type?, table_id?, items:[{menu_item_id, qty, instructions, customizations}], coupon_code?, payment_method?, delivery_note?, no_cutlery?, tip_paise?, recipient_name?, recipient_phone? }

// POST /api/orders with groups[] — on-the-way multi-restaurant checkout.
// groups[0] = primary (100% of its own normal delivery fee + platform fee).
// groups[1..] = secondaries: within 500m of route = flat on-the-way fee each
// (platform fee 0); beyond 500m = FULL normal fee (kept, not removed).
// Unavailable/closed restaurants are reported in removed_off_route.
async function placeMultiGroupOrder(req, res) {
  const { groups, address_id, coupon_code, payment_method, lat, lng, delivery_label,
          delivery_note, no_cutlery, tip_paise,
          recipient_name, recipient_phone, group_code } = req.body;
  const OFF_ROUTE_MSG = "You entered a new address, so the cart restaurants are not on the way and can't be delivered.";

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Reject invented payment methods before any order is written.
    const payMethod = normalizePaymentMethod(payment_method);
    if (payMethod === null) throw { status: 400, message: 'Invalid payment_method' };

    // Address (delivery only — groups path never handles dine-in)
    const aRes = await client.query(
      'SELECT * FROM addresses WHERE id = $1 AND user_id = $2',
      [address_id, req.user.id]
    );
    const address = aRes.rows[0];
    if (!address) throw { status: 400, message: 'Delivery address not found' };
    // b817: pinned delivery location (per-order override, confirmed on the checkout map).
    // Fee, rider destination and stored location all follow the pin. Saved address row untouched.
    const pinLat = Number(lat), pinLng = Number(lng);
    const pinValid = Number.isFinite(pinLat) && Number.isFinite(pinLng) && !(pinLat === 0 && pinLng === 0);
    const deliveryLoc = pinValid ? { lat: pinLat, lng: pinLng }
      : (address && address.lat != null && address.lng != null ? { lat: Number(address.lat), lng: Number(address.lng) } : null);

    // Validate + load all restaurants
    const restIds = groups.map((g) => g.restaurant_id).filter(Boolean);
    if (!restIds.length) throw { status: 400, message: 'groups with restaurant_id are required' };
    const rRes = await client.query(
      "SELECT * FROM restaurants WHERE id = ANY($1) AND status = 'approved' AND COALESCE(is_coming_soon, false) = false",
      [restIds]
    );
    const restById = Object.fromEntries(rRes.rows.map((r) => [String(r.id), r]));
    const primary = restById[String(groups[0].restaurant_id)];
    if (!primary) throw { status: 404, message: 'Primary restaurant not available' };
    if (!primary.is_open) throw { status: 400, message: 'Primary restaurant is currently closed' };

    // Route validation: marginal-cost on-the-way.
    // For each secondary Y: true_detour = road(X→Y→Z) − road(X→Z).
    // Y gets the flat on-the-way fee only if true_detour ≤ threshold (default 0.5km).
    // Beyond threshold — or missing coords, or API failure with no
    // haversine fallback — the secondary STAYS in the order but pays its FULL
    // normal delivery fee (never removed, never repriced to the flat fee).
    // b862: resolve restaurant coords (pin, else geocoded typed address)
    // once, so route validation and fees agree with the quote.
    const restCoordsById = {};
    {
      const _allR = [primary].concat(groups.slice(1).map((g) => restById[String(g.restaurant_id)]).filter(Boolean));
      for (const _rr of _allR) {
        restCoordsById[String(_rr.id)] = await resolveRestaurantCoords(_rr);
      }
    }
    const removed_off_route = [];
    const validGroups = [{ ...groups[0] }];
    const offRouteSet = new Set();
    // Route validation: only secondaries within 500m (straight-line) of the
    // primary→customer route segment get the flat on-the-way fee. Beyond 500m
    // — or missing coords — the secondary stays at FULL normal fee.
    for (let i = 1; i < groups.length; i++) {
      const g = groups[i];
      const r = restById[String(g.restaurant_id)];
      if (!r || !r.is_open) {
        removed_off_route.push({ restaurant_id: g.restaurant_id, name: (r && r.name) || 'Restaurant', reason: 'unavailable' });
        continue;
      }
      let onRoute = false;
      const _pC = restCoordsById[String(primary.id)];
      const _rC = restCoordsById[String(r.id)];
      if (_pC && deliveryLoc && _rC) {
        const distKm = pointToSegKm(
          _rC.lng, _rC.lat,
          _pC.lng, _pC.lat,
          Number(deliveryLoc.lng), Number(deliveryLoc.lat)
        );
        onRoute = distKm <= 0.5;
      }
      if (!onRoute) {
        offRouteSet.add(String(g.restaurant_id));
      }
      validGroups.push(g);
    }

    const config = await loadPricingConfig(client);
    const orders = [];

    // Trip grouping: one trip_id and ONE shared delivery OTP for all orders
    const crypto = require('crypto');
    const tripId = crypto.randomUUID();
    const groupCode = (typeof group_code === 'string' && group_code.trim()) ? group_code.trim().slice(0, 12) : null;
    const { code: sharedDeliveryOtp, hash: sharedDeliveryOtpHash } = await freshDeliveryOtp();
    // Customer snapshot (2026-11-27): same snapshot on every order in the trip.
    const snap = await customerSnapshot(client, req.user.id, address, pinValid ? delivery_label : null, recipient_name, recipient_phone);

    for (let gi = 0; gi < validGroups.length; gi++) {
      const g = validGroups[gi];
      const isPrimary = gi === 0;
      const restaurant = restById[String(g.restaurant_id)];
      const items = Array.isArray(g.items) ? g.items : [];
      if (!items.length) continue;

      // Menu validation + subtotal (same checks as quote)
      const ids = items.map((it) => it.menu_item_id);
      const mRes = await client.query(
        'SELECT id, name, price_paise, available FROM menu_items WHERE id = ANY($1) AND restaurant_id = $2',
        [ids, restaurant.id]
      );
      const menuById = Object.fromEntries(mRes.rows.map((m) => [m.id, m]));
      const { subtotal, snapshots } = await validateItems(client, menuById, items);

      // Coupon only on primary (same checks as quote; place enforces them)
      let discount = 0;
      if (isPrimary && coupon_code) {
        const checked = await validateCoupon(client, coupon_code, subtotal, req.user.id);
        if (checked.error) throw { status: 400, message: checked.error };
        discount = checked.discount;
      }

      // Fees: primary = 100% of its own normal fee, platform fee applies.
      // Secondary on-the-way (validated ≤500m above):
      // flat on-the-way fee (Rs 5 default, config-driven). Platform 0.
      // b862: geocoded typed address when the restaurant has no pin.
      let distanceKm = null;
      const _gC = restCoordsById[String(restaurant.id)];
      if (_gC && deliveryLoc) {
        distanceKm = haversineKm(_gC.lat, _gC.lng, Number(deliveryLoc.lat), Number(deliveryLoc.lng));
      }
      const quote = computeQuote({
        config,
        distanceKm,
        subtotalPaise: subtotal,
        discountPaise: discount,
        commissionPct: restaurant.commission_pct
      });
      const normalFee = quote.deliveryFeePaise;
      const isOffRoute = !isPrimary && offRouteSet.has(String(g.restaurant_id));
      // Primary: 100% of its own normal fee.
      // Secondary on-the-way: flat fee (Rs 5 default, config-driven).
      // Secondary off-route: full normal fee (kept, not removed).
      const deliveryFee = isPrimary ? normalFee
        : isOffRoute ? normalFee
        : otwSecondaryFeePaise(normalFee, config);
      const platformFee = isPrimary ? quote.platformFeePaise : 0;
      const tipPaise = isPrimary ? capTip(tip_paise, config) : 0;
      // GST on the fees actually charged (flat Rs 5 for on-the-way secondaries).
      const tax = computeTax(config.taxRates, subtotal - discount, deliveryFee, platformFee);
      const finalTotal = (subtotal - discount) + deliveryFee + platformFee + tipPaise + tax.taxPaise;

      const timeline = [{ status: 'placed', at: new Date().toISOString(), by: 'customer' }];
      const etaMinutes = Number(config.etaMinutes) || 30;
      const shareToken = require('crypto').randomBytes(6).toString('hex');
      const orderNumber = await newOrderNumber(client);
      // Use shared delivery OTP and trip_id for the trip (not per-order)

      const oRes = await client.query(
        `INSERT INTO orders
           (customer_id, restaurant_id, address_id, status, order_type,
            subtotal_paise, discount_paise, delivery_fee_paise, platform_fee_paise,
            tax_paise, commission_paise, total_paise, tip_paise,
            delivery_note, no_cutlery, recipient_name, recipient_phone,
            payment_method, payment_status, timeline, eta_at, share_token,
            order_number, delivery_otp_hash, delivery_otp_plain, delivery_lat, delivery_lng, delivery_label, trip_id, is_primary, group_code,
            customer_name, customer_phone, customer_address)
         VALUES ($1,$2,$3,'placed','delivery',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17::jsonb,
                 now() + ($18 || ' minutes')::interval, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
         RETURNING *`,
        [req.user.id, restaurant.id, address_id,
         subtotal, discount, deliveryFee, platformFee,
         tax.taxPaise, quote.commissionPaise, finalTotal, tipPaise,
         delivery_note || null, !!no_cutlery, recipient_name || null, recipient_phone || null,
         payMethod, JSON.stringify(timeline), String(etaMinutes), shareToken,
         orderNumber, sharedDeliveryOtpHash, sharedDeliveryOtp, pinValid ? pinLat : null, pinValid ? pinLng : null, pinValid ? (delivery_label || null) : null, tripId, isPrimary, groupCode,
         snap.name, snap.phone, snap.address]
      );
      const order = oRes.rows[0];
      for (const s of snapshots) {
        await client.query(
          `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, unit_price_paise, qty, instructions, person_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [order.id, s.menu_item_id, s.name_snapshot, s.unit_price_paise, s.qty, s.instructions, s.person_name]
        );
      }
      const { delivery_otp_hash: _h1, delivery_otp_plain: _p1, ...orderSafe } = order;
      orders.push({
        order: { ...orderSafe, items: snapshots, delivery_otp: sharedDeliveryOtp },
        group_index: gi,
        is_primary: isPrimary,
        delivery_fee_paise: deliveryFee,
        normal_fee_paise: normalFee,
        platform_fee_paise: platformFee
      });

      // Notify this restaurant owner (each sees only its own order)
      const ownerRes = await client.query('SELECT owner_id FROM restaurants WHERE id = $1', [restaurant.id]);
      if (ownerRes.rows[0] && ownerRes.rows[0].owner_id) {
        await notify(ownerRes.rows[0].owner_id, '🔔 New order!',
          `Delivery order worth Rs ${(subtotal / 100).toFixed(2)} — the kitchen needs you! 👨‍🍳`);
        // Push: items total only (restaurants see item prices, never fees).
        pushToUser(ownerRes.rows[0].owner_id, {
          title: `New order #${orderNumber}`,
          body: `${restaurant.name} — new delivery order worth Rs ${(subtotal / 100).toFixed(2)}`,
          data: { type: 'new_order', order_id: order.id, status: 'placed' },
        });
      }
    }

    // Trip-based rider payout (user 2026-10-15): calculate once per trip, store on all orders
    try {
      const tripRestaurants = [];
      for (const o of orders) {
        const rid = String(o.order.restaurant_id);
        const r = restById[rid];
        if (r && r.lat != null && r.lng != null) {
          tripRestaurants.push({
            id: rid,
            lat: Number(r.lat),
            lng: Number(r.lng),
            isPrimary: !!o.is_primary
          });
        }
      }
      // Primary first, then secondaries nearest-first from primary
      const primary = tripRestaurants.find(r => r.isPrimary) || tripRestaurants[0];
      const secondaries = tripRestaurants.filter(r => r !== primary);
      if (primary) {
        secondaries.sort((a, b) => {
          const da = haversineKm(primary.lat, primary.lng, a.lat, a.lng);
          const db = haversineKm(primary.lat, primary.lng, b.lat, b.lng);
          return da - db;
        });
      }
      // Build route: X -> Y1 -> Y2 -> ... -> Z (customer)
      const route = primary ? [primary, ...secondaries] : [];
      let totalKm = 0;
      if (address && address.lat != null && address.lng != null && route.length > 0) {
        let prevLat = route[0].lat, prevLng = route[0].lng;
        // X -> Y1 -> Y2 ... (between restaurants)
        for (let i = 1; i < route.length; i++) {
          totalKm += haversineKm(prevLat, prevLng, route[i].lat, route[i].lng);
          prevLat = route[i].lat; prevLng = route[i].lng;
        }
        // Last restaurant -> customer
        totalKm += haversineKm(prevLat, prevLng, Number(address.lat), Number(address.lng));
      }
      // Intermediate stops = secondaries count (not primary, not delivery)
      const intermediateStops = secondaries.length;
      const payout = tripPayoutPaise(config.tripPayout, totalKm, intermediateStops);
      // Store on all orders in the trip
      await client.query(
        `UPDATE orders SET trip_payout_paise = $1, trip_distance_km = $2,
         trip_intermediate_stops = $3, trip_payout_breakdown = $4::jsonb
         WHERE trip_id = $5`,
        [payout.payout_paise, Math.round(totalKm * 100) / 100, intermediateStops,
         JSON.stringify(payout.breakdown), tripId]
      );
    } catch (e) {
      console.error('[trip-payout] calculation failed:', e.message);
      // Non-fatal: orders are created, payout can be backfilled
    }

    await client.query('COMMIT');
    // The shared delivery OTP is returned once in each order's place response
    // below — never in a notification body.
    await notify(req.user.id, 'Order placed ✅',
      'Your restaurants got the orders and kitchens are firing up! 🔥');
    pushToUser(req.user.id, {
      title: 'Thanks for your order! 🙏',
      body: 'Your restaurants got the orders and kitchens are firing up! 🔥',
      data: { type: 'order_status', status: 'placed' },
    });

    res.status(201).json({
      orders,
      removed_off_route,
      off_route_message: removed_off_route.length ? OFF_ROUTE_MSG : null
    });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.status) return res.status(e.status).json({ error: e.message });
    throw e;
  } finally {
    client.release();
  }
}

router.post(
  '/',
  ah(async (req, res) => {
    /* Blocked customers cannot place orders */
    const _blockCheck = await db.query('SELECT is_blocked FROM users WHERE id = $1', [req.user.id]);
    if (_blockCheck.rows[0] && _blockCheck.rows[0].is_blocked) {
      return res.status(403).json({ error: 'Your account has been blocked. Please contact support.' });
    }
    const { restaurant_id, address_id, items, coupon_code, payment_method, lat, lng, delivery_label,
            order_type, table_id, delivery_note, no_cutlery, tip_paise,
            recipient_name, recipient_phone, groups, group_code } = req.body;
    // b848 pickup is chosen on one restaurant page: a multi-restaurant
    // pickup must fail loudly, never silently become a delivery order.
    if (order_type === 'pickup' && Array.isArray(groups) && groups.length > 1) {
      return res.status(400).json({ error: 'Pickup is available for one restaurant at a time' });
    }
    // Multi-restaurant on-the-way checkout: groups[0] = primary, rest = secondaries.
    if (Array.isArray(groups) && groups.length > 1 && order_type !== 'dinein') {
      return await placeMultiGroupOrder(req, res);
    }
    const dineIn = order_type === 'dinein';
    const pickup = order_type === 'pickup';
    if (!restaurant_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'restaurant_id and items are required' });
    }
    if (!dineIn && !pickup && !address_id) {
      return res.status(400).json({ error: 'address_id is required for delivery orders' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // Reject invented payment methods before any order is written.
      const payMethod = normalizePaymentMethod(payment_method);
      if (payMethod === null) throw { status: 400, message: 'Invalid payment_method' };

      const rRes = await client.query(
        "SELECT * FROM restaurants WHERE id = $1 AND status = 'approved' AND COALESCE(is_coming_soon, false) = false",
        [restaurant_id]
      );
      const restaurant = rRes.rows[0];
      if (!restaurant) throw { status: 404, message: 'Restaurant not available' };
      if (!restaurant.is_open) throw { status: 400, message: 'Restaurant is currently closed' };

      let address = null;
      if (dineIn) {
        if (!table_id) throw { status: 400, message: 'Table is required for dine-in orders' };
        const tRes = await client.query(
          'SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2', [table_id, restaurant_id]
        );
        if (!tRes.rows[0]) throw { status: 400, message: 'Table not found for this restaurant' };
      } else if (!pickup) {
        const aRes = await client.query(
          'SELECT * FROM addresses WHERE id = $1 AND user_id = $2',
          [address_id, req.user.id]
        );
        address = aRes.rows[0];
        if (!address) throw { status: 400, message: 'Delivery address not found' };
      }

      const ids = items.map((i) => i.menu_item_id);
      const mRes = await client.query(
        'SELECT id, name, price_paise, available FROM menu_items WHERE id = ANY($1) AND restaurant_id = $2',
        [ids, restaurant_id]
      );
      const menuById = Object.fromEntries(mRes.rows.map((m) => [m.id, m]));
      // Same item checks as quote (unavailable / bad qty is a 400, never skipped)
      const { subtotal, snapshots } = await validateItems(client, menuById, items);

      // Coupon (same checks as quote; place enforces them)
      let discount = 0;
      let couponId = null;
      if (coupon_code) {
        const checked = await validateCoupon(client, coupon_code, subtotal, req.user.id);
        if (checked.error) throw { status: 400, message: checked.error };
        discount = checked.discount;
        couponId = checked.couponId;
      }

    // b817: pinned delivery location (per-order override, confirmed on the checkout map).
    // When the customer drags the pin and confirms, the order delivers to the pin:
    // fee, rider destination and stored location all follow it. The saved address row is untouched.
    const pinLat = Number(lat), pinLng = Number(lng);
    const pinValid = !dineIn && !pickup && Number.isFinite(pinLat) && Number.isFinite(pinLng) && !(pinLat === 0 && pinLng === 0);
    const deliveryLoc = pinValid ? { lat: pinLat, lng: pinLng }
      : (address && address.lat != null && address.lng != null ? { lat: Number(address.lat), lng: Number(address.lng) } : null);
      // Distance + quote
      // b862: geocoded typed address when the restaurant has no pin.
      let distanceKm = null;
      if (!dineIn && !pickup && deliveryLoc) {
        const _pCoords = await resolveRestaurantCoords(restaurant);
        if (_pCoords) {
          distanceKm = haversineKm(_pCoords.lat, _pCoords.lng, deliveryLoc.lat, deliveryLoc.lng);
        }
      }
      const config = await loadPricingConfig(client);
      const tipPaise = pickup ? 0 : capTip(tip_paise, config);
      const quote = computeQuote({
        config,
        distanceKm: (dineIn || pickup) ? 0 : distanceKm,
        subtotalPaise: subtotal,
        discountPaise: discount,
        commissionPct: restaurant.commission_pct,
        deliveryFeePaiseOverride: (dineIn || pickup) ? 0 : undefined,
        platformFeePaiseOverride: pickup ? 0 : undefined
      });
      const deliveryFee = (dineIn || pickup) ? 0 : quote.deliveryFeePaise;
      const finalTotal = (subtotal - discount) + deliveryFee + quote.platformFeePaise + quote.taxPaise + tipPaise;

      const timeline = [{ status: 'placed', at: new Date().toISOString(), by: 'customer' }];
      const etaMinutes = Number(config.etaMinutes) || 30;
      const shareToken = require('crypto').randomBytes(6).toString('hex');
      const orderNumber = await newOrderNumber(client);
      const groupCode = (typeof group_code === 'string' && group_code.trim()) ? group_code.trim().slice(0, 12) : null;
      const { code: deliveryOtp, hash: deliveryOtpHash } = await freshDeliveryOtp();
      // Customer snapshot (2026-11-27): frozen at placement (see helper above).
      const snap = await customerSnapshot(client, req.user.id, address, pinValid ? delivery_label : null, recipient_name, recipient_phone);

      const oRes = await client.query(
        `INSERT INTO orders
           (customer_id, restaurant_id, address_id, status, order_type, table_id,
            subtotal_paise, discount_paise, delivery_fee_paise, platform_fee_paise,
            tax_paise, commission_paise, total_paise, tip_paise,
            delivery_note, no_cutlery, recipient_name, recipient_phone,
            payment_method, payment_status, timeline, eta_at, share_token,
            order_number, delivery_otp_hash, delivery_otp_plain, delivery_lat, delivery_lng, delivery_label, group_code,
            customer_name, customer_phone, customer_address)
         VALUES ($1,$2,$3,'placed',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending',$19::jsonb,
                 now() + ($20 || ' minutes')::interval, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
         RETURNING *`,
        [req.user.id, restaurant_id, (dineIn || pickup) ? null : address_id, dineIn ? 'dinein' : pickup ? 'pickup' : 'delivery',
         dineIn ? table_id : null,
         subtotal, discount, deliveryFee, quote.platformFeePaise,
         quote.taxPaise, quote.commissionPaise, finalTotal, tipPaise,
         delivery_note || null, !!no_cutlery, recipient_name || null, recipient_phone || null,
         payMethod, JSON.stringify(timeline), String(etaMinutes), shareToken,
         orderNumber, deliveryOtpHash, deliveryOtp, pinValid ? pinLat : null, pinValid ? pinLng : null, pinValid ? (delivery_label || null) : null, groupCode,
         snap.name, snap.phone, snap.address]
      );
      const order = oRes.rows[0];

      for (const s of snapshots) {
        await client.query(
          `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, unit_price_paise, qty, instructions, person_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [order.id, s.menu_item_id, s.name_snapshot, s.unit_price_paise, s.qty, s.instructions, s.person_name]
        );
      }
      await client.query('COMMIT');

      const ownerRes = await db.query('SELECT owner_id FROM restaurants WHERE id = $1', [restaurant_id]);
      if (ownerRes.rows[0] && ownerRes.rows[0].owner_id) {
        await notify(ownerRes.rows[0].owner_id, '🔔 New order!',
          `${dineIn ? 'Dine-in table order' : pickup ? 'Pickup order' : 'Delivery order'} worth Rs ${(subtotal / 100).toFixed(2)} — the kitchen needs you! 👨‍🍳`);
        // Push: items total only (restaurants see item prices, never fees).
        pushToUser(ownerRes.rows[0].owner_id, {
          title: `New order #${orderNumber}`,
          body: `${restaurant.name} — new ${dineIn ? 'dine-in' : pickup ? 'pickup' : 'delivery'} order worth Rs ${(subtotal / 100).toFixed(2)}`,
          data: { type: 'new_order', order_id: order.id, status: 'placed' },
        });
      }
      // The delivery OTP is returned once in the place response below —
      // never in a notification body.
      await notify(req.user.id, 'Order placed ✅',
        `${restaurant.name} (${orderNumber}) got your order and the kitchen is firing up! 🔥`);
      pushToUser(req.user.id, {
        title: 'Thanks for your order! 🙏',
        body: `${restaurant.name} (${orderNumber}) got your order and the kitchen is firing up! 🔥`,
        data: { type: 'order_status', status: 'placed', order_id: order.id },
      });

      const { delivery_otp_hash: _h2, delivery_otp_plain: _p2, ...orderSafe2 } = order;
      res.status(201).json({
        order: { ...orderSafe2, items: snapshots, ...(pickup ? {} : { delivery_otp: deliveryOtp }) },
        breakdown: {
          subtotal_paise: subtotal,
          discount_paise: discount,
          delivery_fee_paise: deliveryFee,
          platform_fee_paise: quote.platformFeePaise,
          tax_paise: quote.taxPaise,
          tax_breakdown: quote.taxBreakdown,
          tip_paise: tipPaise,
          total_paise: finalTotal,
          eta_minutes: etaMinutes,
          distance_km: distanceKm == null ? null : Math.round(distanceKm * 100) / 100,
          coupon_id: couponId,
          share_token: shareToken
        }
      });
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    } finally {
      client.release();
    }
  })
);

// POST /api/orders/:id/report-missing — "my food never arrived".
// Creates a missing_food ticket; admin resolves it with a refund or a reorder.
router.post(
  '/:id/report-missing',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (['delivered', 'cancelled', 'rejected'].includes(order.status)) {
      return res.status(409).json({ error: `This order is already ${order.status}` });
    }
    const dup = await db.query(
      `SELECT id FROM support_tickets WHERE order_id = $1 AND category = 'missing_food'
       AND status IN ('open','in_progress') LIMIT 1`, [order.id]
    );
    if (dup.rows[0]) return res.status(409).json({ error: 'You already reported this order', ticket_id: dup.rows[0].id });
    const t = await db.query(
      `INSERT INTO support_tickets (user_id, order_id, category, subject, message)
       VALUES ($1, $2, 'missing_food', 'Food never arrived',
               'Customer reports the food never arrived. Please resolve with a refund or a reorder.')
       RETURNING *`,
      [req.user.id, order.id]
    );
    res.status(201).json({ ticket: t.rows[0] });
  })
);

// GET /api/orders?status=
router.get(
  '/',
  ah(async (req, res) => {
    const params = [req.user.id];
    let where = 'o.customer_id = $1';
    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND o.status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT o.*, r.name AS restaurant_name, r.image_url AS restaurant_image,
              EXISTS (SELECT 1 FROM ratings rt WHERE rt.order_id = o.id) AS rated
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE ${where} ORDER BY o.placed_at DESC LIMIT 200`,
      params
    );
    // Never expose the delivery OTP (plain or hash) in list responses.
    for (const o of rows) { delete o.delivery_otp_hash; delete o.delivery_otp_plain; }
    res.json({ orders: rows });
  })
);

// GET /api/orders/:id
router.get(
  '/:id',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT o.*, r.name AS restaurant_name, r.image_url AS restaurant_image, r.phone AS restaurant_phone,
              r.verified AS restaurant_verified, r.lat AS rest_lat, r.lng AS rest_lng,
              rd.lat AS rider_lat, rd.lng AS rider_lng,
              COALESCE(o.delivery_label, a.line1) AS line1, a.line2, a.city,
              COALESCE(o.delivery_lat, a.lat) AS addr_lat, COALESCE(o.delivery_lng, a.lng) AS addr_lng,
              ru.name AS rider_name, ru.phone AS rider_phone,
              rd.profile_photo AS rider_photo, rd.rating_avg AS rider_rating,
              (SELECT COUNT(*) FROM orders od
               WHERE od.rider_id = rd.id AND od.status = 'delivered') AS rider_deliveries,
              EXISTS (SELECT 1 FROM ratings rt WHERE rt.order_id = o.id) AS rated
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       LEFT JOIN riders rd ON rd.id = o.rider_id
       LEFT JOIN users ru ON ru.id = rd.user_id
       WHERE o.id = $1 AND o.customer_id = $2`,
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    // The delivery OTP is returned to the requesting customer only (this
    // endpoint already enforces o.customer_id = $2). The place response
    // returns it once, but the tracking page reloads via this endpoint, so
    // the code must be readable here too — otherwise the customer has no
    // way to see the code they must share with the rider at handover.
    // The hash is never exposed. Pickup orders use pickup_otp instead.
    const deliveryOtp = order.delivery_otp_plain;
    delete order.delivery_otp_hash;
    delete order.delivery_otp_plain;
    if (deliveryOtp && order.order_type !== 'pickup') order.delivery_otp = deliveryOtp;
    const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    // Queue transparency: orders at this restaurant placed before mine, still active
    let queueAhead = 0;
    if (['placed', 'accepted', 'preparing'].includes(order.status)) {
      const qRes = await db.query(
        `SELECT COUNT(*) AS n FROM orders
         WHERE restaurant_id = $1 AND placed_at < $2
           AND status IN ('placed','accepted','preparing')`,
        [order.restaurant_id, order.placed_at]
      );
      queueAhead = Number(qRes.rows[0].n);
    }
    // Restaurant no-response: still 'placed' after 5 minutes -> flag + nudge the kitchen once.
    let noResponse = false;
    if (order.status === 'placed') {
      const minsWaiting = (Date.now() - new Date(order.placed_at).getTime()) / 60000;
      noResponse = minsWaiting >= 5;
      const nudged = (order.timeline || []).some((t) => t.status === 'no_response_nudge');
      if (noResponse && !nudged) {
        const rOwner = await db.query(
          'SELECT owner_id FROM restaurants WHERE id = $1', [order.restaurant_id]
        );
        if (rOwner.rows[0]) {
          await notify(rOwner.rows[0].owner_id, '⏰ Order waiting for your response!',
            'An order has been waiting 5 minutes — please accept it so the customer isn\u2019t left hanging.');
        }
        const timeline = order.timeline || [];
        timeline.push({ status: 'no_response_nudge', at: new Date().toISOString(), by: 'system' });
        await db.query('UPDATE orders SET timeline = $1::jsonb WHERE id = $2',
          [JSON.stringify(timeline), order.id]);
      }
    }
    // Multi-restaurant stops: other active orders from the same customer assigned to the same rider,
    // ordered by placed_at (first in cart = farthest = first pickup)
    let stops = [];
    if (order.rider_id) {
      const sRes = await db.query(
        `SELECT o.id, o.status, o.placed_at, r.name AS restaurant_name, r.lat AS rest_lat, r.lng AS rest_lng,
                (o.status IN ('picked_up','on_way')) AS picked_up,
                (o.status IN ('picked_up','on_way','delivered')) AS reached
         FROM orders o
         JOIN restaurants r ON r.id = o.restaurant_id
         WHERE o.customer_id = $1 AND o.rider_id = $2 AND o.id != $3
           AND o.status IN ('accepted','preparing','ready','picked_up','on_way')
         ORDER BY o.placed_at ASC`,
        [order.customer_id, order.rider_id, order.id]
      );
      stops = sRes.rows;
      // Include the current order as the first stop
      stops.unshift({
        id: order.id,
        status: order.status,
        placed_at: order.placed_at,
        restaurant_name: order.restaurant_name,
        rest_lat: order.rest_lat,
        rest_lng: order.rest_lng,
        picked_up: ['picked_up','on_way'].includes(order.status),
        reached: ['picked_up','on_way','delivered'].includes(order.status),
      });
    }
    // Live ETA: based on rider's real position (not the static estimate)
    let liveEta = null;
    let riderClose = false;
    if (order.rider_lat != null && order.rider_lng != null) {
      const rLat = Number(order.rider_lat), rLng = Number(order.rider_lng);
      let destLat = null, destLng = null;
      if (['picked_up', 'on_way'].includes(order.status) && (order.delivery_lat != null || order.addr_lat != null)) {
        // Heading to customer — a confirmed pin overrides the saved address
        destLat = Number(order.delivery_lat != null ? order.delivery_lat : order.addr_lat);
        destLng = Number(order.delivery_lng != null ? order.delivery_lng : order.addr_lng);
      } else if (['accepted', 'preparing', 'ready'].includes(order.status) && order.rest_lat != null && order.rest_lng != null) {
        // Heading to restaurant
        destLat = Number(order.rest_lat); destLng = Number(order.rest_lng);
      }
      if (destLat != null && destLng != null) {
        const distKm = haversineKm(rLat, rLng, destLat, destLng);
        // ~20 km/h average city speed
        liveEta = Math.max(1, Math.round((distKm / 20) * 60));
        // "Arriving now" when within 200m of the customer
        if (['picked_up', 'on_way'].includes(order.status) && distKm < 0.2) {
          riderClose = true;
        }
      }
    }
    res.json({ order: { ...order, items: items.rows, queue_ahead: queueAhead, no_response: noResponse, stops,
      live_eta_minutes: liveEta, rider_arriving: riderClose } });
  })
);

// POST /api/orders/:id/cancel { reason } — only before the restaurant accepts
// Trip cancels are ONE transaction: every order in the trip is cancelled
// together (transition + payment_status update per order). A failure
// mid-loop rolls the whole trip back — never a half-cancelled trip.
router.post(
  '/:id/cancel',
  ah(async (req, res) => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
        [req.params.id, req.user.id]
      );
      const order = rows[0];
      if (!order) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Order not found' });
      }
      if (order.status !== 'placed') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Order can no longer be cancelled' });
      }
      // Cancelled + never paid = terminal non-payable ('void'). A 'pending'
      // payment_status must not survive a cancel — it reads as an outstanding
      // payment to every other consumer (admin, reports, rider COD checks).
      // 'paid' still goes to 'refund_pending'; anything else keeps its value.
      const terminalPayment = (ps) => (ps === 'paid' ? 'refund_pending' : ps === 'pending' ? 'void' : ps);
      // For trips: cancel ALL orders in the trip (bulletproof - no partial trips)
      const cancelIds = [order.id];
      if (order.trip_id) {
        const tripRes = await client.query(
          "SELECT id, payment_status FROM orders WHERE trip_id = $1 AND status = 'placed'",
          [order.trip_id]
        );
        for (const to of tripRes.rows) {
          if (to.id !== order.id) {
            await transitionTx(client, to.id, 'cancelled', 'customer');
            // Paid orders go to refund_pending — 'refunded' is only set once a
            // real refund has happened (admin refund action).
            await client.query(
              'UPDATE orders SET cancel_reason = $1, payment_status = $2 WHERE id = $3',
              [req.body.reason || 'Cancelled by customer (trip)', terminalPayment(to.payment_status), to.id]
            );
            cancelIds.push(to.id);
          }
        }
      }
      await transitionTx(client, order.id, 'cancelled', 'customer');
      const refundPending = order.payment_status === 'paid';
      await client.query(
        'UPDATE orders SET cancel_reason = $1, payment_status = $2 WHERE id = $3',
        [req.body.reason || 'Cancelled by customer', terminalPayment(order.payment_status), order.id]
      );
      await client.query('COMMIT');
      // Bell notification: the customer must see the cancellation, not just "Order placed".
      await notify(req.user.id, 'Order cancelled',
        `Your order #${order.order_number || order.id} was cancelled.${refundPending ? ' Your refund is being processed.' : ''}`);
      pushToUser(req.user.id, {
        title: 'Order cancelled',
        body: `Your order #${order.order_number || order.id} was cancelled.${refundPending ? ' Your refund is being processed.' : ''}`,
        data: { type: 'order_status', status: 'cancelled', order_id: order.id },
      });
      // Owners learn of the cancel immediately, not only on the next 2.5s poll.
      try {
        const ownRes = await db.query(
          `SELECT r.owner_id, r.name, o.order_number FROM orders o
           JOIN restaurants r ON r.id = o.restaurant_id WHERE o.id = ANY($1)`,
          [cancelIds]
        );
        for (const ow of ownRes.rows) {
          if (!ow.owner_id) continue;
          await notify(ow.owner_id, 'Order cancelled',
            `Order #${ow.order_number || ''} at ${ow.name} was cancelled by the customer.`);
          pushToUser(ow.owner_id, {
            title: 'Order cancelled',
            body: `Order #${ow.order_number || ''} at ${ow.name} was cancelled by the customer.`,
            data: { type: 'order_status', status: 'cancelled' },
          });
        }
      } catch (e) { console.error('[cancel] owner notify failed', e.message); }
      res.json({ ok: true, refund_pending: refundPending, cancelled_orders: cancelIds.length });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  })
);

// POST /api/orders/:id/delivery-otp — re-issue the delivery OTP (active delivery only)
router.post(
  '/:id/delivery-otp',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!['picked_up', 'on_way'].includes(order.status)) {
      return res.status(409).json({ error: 'Delivery OTP is available only during delivery' });
    }
    const code = newDeliveryOtp();
    const hash = await bcrypt.hash(code, 8);
    await db.query('UPDATE orders SET delivery_otp_hash = $1, delivery_otp_plain = $2 WHERE id = $3', [hash, code, order.id]);
    await notify(req.user.id, 'Your delivery OTP', 'A new delivery OTP was generated for your order.');
    res.json({ ok: true, delivery_otp: code });
  })
);

// POST /api/orders/:id/rate { food_rating?, delivery_rating?, comment?, photo_url? }
router.post(
  '/:id/rate',
  ah(async (req, res) => {
    const { food_rating, delivery_rating, comment, photo_url } = req.body;
    // Food photos: client-resized data URLs only, capped to protect the DB.
    let photo = null;
    if (photo_url) {
      if (typeof photo_url !== 'string' || !photo_url.startsWith('data:image/') || photo_url.length > 600000) {
        return res.status(400).json({ error: 'Invalid photo' });
      }
      photo = photo_url;
    }
    // Ratings are 1-5 integers only. Unvalidated values (100, -5, "great")
    // would flow straight into AVG() and corrupt every restaurant/rider
    // rating the app shows.
    const foodRating = validateRatingValue(food_rating);
    const deliveryRating = validateRatingValue(delivery_rating);
    if (foodRating === undefined || deliveryRating === undefined) {
      return res.status(400).json({ error: 'Ratings must be integers from 1 to 5' });
    }
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'delivered') {
      return res.status(409).json({ error: 'You can rate only delivered orders' });
    }
    // All three writes (restaurant rating, rider rating, stored aggregates)
    // are ONE transaction: a failure anywhere rolls everything back instead
    // of leaving a half-rated order (the old code inserted the restaurant
    // rating, then threw on a missing rider user row before the rest).
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT id FROM ratings WHERE order_id = $1 AND rater_id = $2',
        [order.id, req.user.id]
      );
      if (existing.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Order already rated' });
      }

      await client.query(
        `INSERT INTO ratings (order_id, rater_id, ratee_type, ratee_id, food_rating, delivery_rating, comment, photo_url)
         VALUES ($1,$2,'restaurant',$3,$4,$5,$6,$7)`,
        [order.id, req.user.id, order.restaurant_id, foodRating, null, comment || null, photo]
      );
      if (order.rider_id && deliveryRating != null) {
        const rp = await client.query('SELECT user_id FROM riders WHERE id = $1', [order.rider_id]);
        if (rp.rows[0] && rp.rows[0].user_id) {
          await client.query(
            `INSERT INTO ratings (order_id, rater_id, ratee_type, ratee_id, food_rating, delivery_rating, comment)
             VALUES ($1,$2,'rider',$3,$4,$5,$6)`,
            [order.id, req.user.id, rp.rows[0].user_id, null, deliveryRating, comment || null]
          );
          await client.query(
            `UPDATE riders SET rating_avg = (
               SELECT COALESCE(AVG(delivery_rating), 0) FROM ratings
               WHERE ratee_type = 'rider' AND ratee_id = riders.user_id AND delivery_rating IS NOT NULL
             ) WHERE id = $1`,
            [order.rider_id]
          );
        } else {
          // Rider row exists on the order but its user row is gone: the
          // restaurant rating still counts; the rider rating is skipped
          // rather than crashing the whole rating.
          console.warn('[rate] rider user row missing for rider', order.rider_id, '- rider rating skipped');
        }
      }
      if (foodRating != null) {
        // Keep the stored columns in sync so nothing drifts from the live ratings table.
        // ROUND to 1 decimal, exactly like the live recompute on the
        // restaurant detail endpoint, so list and detail can never disagree.
        await client.query(
          `UPDATE restaurants SET
             rating_avg = (
               SELECT COALESCE(ROUND(AVG(food_rating)::numeric, 1), 0) FROM ratings
               WHERE ratee_type = 'restaurant' AND ratee_id = $1 AND food_rating IS NOT NULL
             ),
             rating_count = (
               SELECT COUNT(*) FROM ratings
               WHERE ratee_type = 'restaurant' AND ratee_id = $1 AND food_rating IS NOT NULL
             )
           WHERE id = $1`,
          [order.restaurant_id]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true });
  })
);

// POST /api/orders/:id/report { type, notes? } — one-tap issue report
// on a delivered order. Creates a support ticket for the ops team; no automatic
// credits — every case is reviewed by a human.
router.post(
  '/:id/report',
  ah(async (req, res) => {
    const { type, notes } = req.body;
    const allowed = ['cold_food', 'wrong_item', 'missing_item', 'late', 'other'];
    if (!allowed.includes(type)) return res.status(400).json({ error: 'Unknown report type' });
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'delivered') {
      return res.status(409).json({ error: 'You can report only delivered orders' });
    }
    const dup = await db.query(
      'SELECT id FROM support_tickets WHERE order_id = $1 AND category = $2',
      [order.id, type]
    );
    if (dup.rows[0]) return res.status(409).json({ error: 'This order was already reported' });

    const subjects = {
      cold_food: 'Food arrived cold',
      wrong_item: 'Wrong item delivered',
      missing_item: 'Item missing from order',
      late: 'Order arrived late',
      other: 'Issue with my order'
    };
    const ticket = await db.query(
      `INSERT INTO support_tickets (user_id, order_id, category, subject, message)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, order.id, type, subjects[type], notes || 'Customer reported an issue with this order.']
    );
    await notify(req.user.id, 'We got your report 🙏',
      'Our team is looking into it right now. We will make this right — thank you for telling us.');
    res.status(201).json({ ticket: ticket.rows[0] });
  })
);

// GET /api/orders/:id/invoice — GST invoice data for the customer
router.get(
  '/:id/invoice',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT o.*, r.name AS restaurant_name, r.address AS restaurant_address, r.gstin,
              r.phone AS restaurant_phone
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.id = $1 AND o.customer_id = $2`,
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    res.json({
      invoice: {
        invoice_no: 'MN-' + order.id.slice(0, 8).toUpperCase(),
        date: order.placed_at,
        restaurant: {
          name: order.restaurant_name,
          address: order.restaurant_address,
          phone: order.restaurant_phone,
          gstin: order.gstin
        },
        items: items.rows,
        subtotal_paise: order.subtotal_paise,
        discount_paise: order.discount_paise,
        delivery_fee_paise: order.delivery_fee_paise,
        platform_fee_paise: order.platform_fee_paise,
        tip_paise: order.tip_paise,
        total_paise: order.total_paise,
        payment_method: order.payment_method,
        payment_status: order.payment_status
      }
    });
  })
);

// ---- Razorpay (key-ready; dormant until RAZORPAY_KEY_ID/SECRET are set) ----
// POST /api/orders/:id/razorpay-order — create a Razorpay order for online payment
router.post(
  '/:id/razorpay-order',
  ah(async (req, res) => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
      return res.status(503).json({ error: 'Online payments are not configured yet' });
    }
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status !== 'pending') {
      return res.status(409).json({ error: `Payment already ${order.payment_status}` });
    }
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
    // 10s timeout — never hang checkout on gateway stall (receipt is idempotency key)
    const rpCtrl = new AbortController();
    const rpTimer = setTimeout(() => { try { rpCtrl.abort(); } catch (e) {} }, 10000);
    let rpRes;
    try {
      rpRes = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: order.total_paise,
          currency: 'INR',
          receipt: 'mn_' + order.id.slice(0, 24),
          notes: { mana_order_id: order.id }
        }),
        signal: rpCtrl.signal
      });
    } catch (e) {
      clearTimeout(rpTimer);
      return res.status(504).json({ error: 'Payment gateway timed out. Please try again.' });
    }
    clearTimeout(rpTimer);
    if (!rpRes.ok) {
      return res.status(502).json({ error: 'Payment gateway error. Please try again.' });
    }
    const rpOrder = await rpRes.json();
    res.json({ razorpay_order_id: rpOrder.id, amount_paise: order.total_paise, key_id: keyId });
  })
);

// POST /api/orders/:id/razorpay-verify { razorpay_payment_id, razorpay_order_id, razorpay_signature }
router.post(
  '/:id/razorpay-verify',
  ah(async (req, res) => {
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keySecret) return res.status(503).json({ error: 'Online payments are not configured yet' });
    const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body || {};
    if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment verification data' });
    }
    const crypto = require('crypto');
    const expected = crypto
      .createHmac('sha256', keySecret)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');
    if (expected !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }
    const { rows } = await db.query(
      "SELECT * FROM orders WHERE id = $1 AND customer_id = $2 AND payment_status = 'pending'",
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found or already paid' });
    await db.query("UPDATE orders SET payment_status = 'paid', payment_method = 'razorpay' WHERE id = $1", [order.id]);
    const timeline = order.timeline || [];
    timeline.push({ status: 'paid', at: new Date().toISOString(), by: 'razorpay' });
    await db.query('UPDATE orders SET timeline = $1::jsonb WHERE id = $2', [JSON.stringify(timeline), order.id]);
    await notify(order.customer_id, 'Payment successful ✅',
      `Rs ${(order.total_paise / 100).toFixed(2)} paid. The kitchen is firing up! 🔥`);
    res.json({ ok: true, payment_status: 'paid' });
  })
);

module.exports = router;
