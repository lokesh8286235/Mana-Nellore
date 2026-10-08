// Customer order lifecycle: place, pay, track, cancel, rate.
// Pricing is computed server-side from pricing_config — clients never send totals.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireRole, ah } = require('../middleware/auth');
const { haversineKm, loadPricingConfig, computeQuote, computeGstPaise, deliveryFeePaise } = require('../lib/pricing');
const { idempotency } = require('../lib/idempotency');
const { getRouteDuration } = require('../lib/routesApi');
const { isInServiceArea, otwDiscountDecision } = require('../lib/onetheway');

const router = express.Router();
router.use(authenticate);

async function notify(userId, title, body) {
  await db.query('INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)', [
    userId, title, body
  ]);
}

async function transition(orderId, status, by) {
  // Single UPDATE with a jsonb append: concurrent transitions can no longer
  // silently drop each other's timeline entries (read-modify-write race).
  await db.query(
    `UPDATE orders SET status = $1,
       timeline = COALESCE(timeline, '[]'::jsonb)
                || jsonb_build_object('status', $1::text, 'at', $2::text, 'by', $3::text)
     WHERE id = $4`,
    [status, new Date().toISOString(), by, orderId]
  );
}

function newDeliveryOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Scheduled ordering: validate an ISO 8601 scheduled_for. Must be strictly
// in the future, more than 30 minutes out and less than 48 hours out.
function parseScheduledFor(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return { ok: false, error: 'scheduled_for must be a valid ISO 8601 date-time' };
  const now = Date.now();
  if (d.getTime() <= now + 30 * 60 * 1000) {
    return { ok: false, error: 'Scheduled orders must be placed at least 30 minutes in advance' };
  }
  if (d.getTime() >= now + 48 * 3600 * 1000) {
    return { ok: false, error: 'Scheduled orders can be placed up to 48 hours in advance' };
  }
  return { ok: true, date: d };
}

// ---------- On-the-way helpers (server-side anti-scam) ----------

// Best-effort audit insert. Audit must never break ordering, so failures are swallowed.
async function otwAudit(event, fields) {
  try {
    const f = fields || {};
    await db.query(
      `INSERT INTO otw_audit_log (event, order_id, customer_id, primary_restaurant_id,
        secondary_restaurant_id, address_id, fee_charged_paise, fee_full_paise, reason, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [event, f.order_id || null, f.customer_id || null, f.primary_restaurant_id || null,
       f.secondary_restaurant_id || null, f.address_id || null,
       f.fee_charged_paise != null ? f.fee_charged_paise : null,
       f.fee_full_paise != null ? f.fee_full_paise : null,
       f.reason || null, JSON.stringify(f.meta || {})]
    );
  } catch (e) { /* ignore */ }
}

// Split request items into per-restaurant groups. Returns an array, or
// { error } on malformed input. The body restaurant_id's group is primary.
// Items are NEVER silently dropped: a mixed-restaurant request becomes
// multiple groups (priced or rejected per group — never ignored).
function buildGroupDefs({ bodyGroups, items, restaurant_id, dineIn }) {
  if (!dineIn && Array.isArray(bodyGroups) && bodyGroups.length) {
    const defs = bodyGroups.map((g, i) => ({
      restaurant_id: g && g.restaurant_id,
      items: g && Array.isArray(g.items) ? g.items : [],
      primary: i === 0
    }));
    for (const d of defs) {
      if (!d.restaurant_id || !d.items.length) {
        return { error: 'Each restaurant group needs a restaurant_id and items' };
      }
    }
    return defs;
  }
  if (!restaurant_id || !Array.isArray(items) || !items.length) {
    return { error: 'restaurant_id and items are required' };
  }
  if (!dineIn) {
    const byRest = new Map();
    for (const it of items) {
      const rid = String((it && it.restaurant_id) || restaurant_id);
      if (!byRest.has(rid)) byRest.set(rid, []);
      byRest.get(rid).push(it);
    }
    if (byRest.size > 1) {
      const rids = [...byRest.keys()].sort((a, b) =>
        a === String(restaurant_id) ? -1 : b === String(restaurant_id) ? 1 : 0);
      return rids.map((rid) => ({
        restaurant_id: rid,
        items: byRest.get(rid),
        primary: String(rid) === String(restaurant_id)
      }));
    }
  }
  return [{ restaurant_id, items, primary: true }];
}

// Batch-fetch customization option prices/names for many items in ONE query
// (fixes N+1: previously one query per item with customizations).
// Returns Map "<menu_item_id>::<option_id>" -> { price_paise, name }.
async function batchCustomizationOptions(q, items) {
  const map = new Map();
  const pairs = [];
  for (const it of items) {
    if (!Array.isArray(it.customizations) || !it.customizations.length) continue;
    const seen = new Set();
    for (const c of it.customizations) {
      const oid = c && c.option_id;
      if (!oid || seen.has(String(oid))) continue;
      seen.add(String(oid));
      pairs.push([it.menu_item_id, oid]);
    }
  }
  if (!pairs.length) return map;
  const optIds = [...new Set(pairs.map((x) => x[1]))];
  const menuIds = [...new Set(pairs.map((x) => x[0]))];
  const oRes = await q(
    `SELECT o.id, o.name, o.price_paise, g.menu_item_id FROM customization_options o
     JOIN customization_groups g ON g.id = o.group_id
     WHERE o.id = ANY($1) AND g.menu_item_id = ANY($2)`,
    [optIds, menuIds]
  );
  for (const o of oRes.rows) {
    map.set(String(o.menu_item_id) + '::' + String(o.id), {
      price_paise: Number(o.price_paise) || 0,
      name: o.name
    });
  }
  return map;
}

// Lenient item pricer for quotes: foreign/unavailable items are skipped (never priced).
async function priceQuoteItems(q, items, restaurantId) {
  const ids = items.map((i) => i.menu_item_id);
  const mRes = await q(
    'SELECT id, price_paise, available FROM menu_items WHERE id = ANY($1) AND restaurant_id = $2',
    [ids, restaurantId]
  );
  const menuById = Object.fromEntries(mRes.rows.map((m) => [m.id, m]));
  const custMap = await batchCustomizationOptions(q, items);
  let subtotal = 0;
  for (const it of items) {
    const m = menuById[it.menu_item_id];
    if (!m || !m.available) continue;
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty <= 0) return { error: 'Quantity must be a positive integer' };
    let custExtra = 0;
    if (Array.isArray(it.customizations) && it.customizations.length) {
      const seen = new Set();
      for (const c of it.customizations) {
        const oid = c && c.option_id;
        if (!oid || seen.has(String(oid))) continue;
        seen.add(String(oid));
        const hit = custMap.get(String(m.id) + '::' + String(oid));
        if (hit) custExtra += hit.price_paise;
      }
    }
    subtotal += (m.price_paise + custExtra) * qty;
  }
  return { subtotal };
}

// Strict item pricer for placement: any foreign/unavailable item rejects the order.
async function pricePlacementItems(client, items, restaurantId) {
  const ids = items.map((i) => i.menu_item_id);
  const mRes = await client.query(
    'SELECT id, name, price_paise, available FROM menu_items WHERE id = ANY($1) AND restaurant_id = $2',
    [ids, restaurantId]
  );
  const menuById = Object.fromEntries(mRes.rows.map((m) => [m.id, m]));
  const custMap = await batchCustomizationOptions((...a) => client.query(...a), items);
  let subtotal = 0;
  const snapshots = [];
  for (const it of items) {
    const m = menuById[it.menu_item_id];
    const qty = Number(it.qty);
    if (!m) throw { status: 400, message: 'A menu item is not from this restaurant' };
    if (!m.available) throw { status: 400, message: `"${m.name}" is currently unavailable` };
    if (!Number.isInteger(qty) || qty <= 0) throw { status: 400, message: 'Quantity must be a positive integer' };
    let custExtra = 0;
    const custNames = [];
    if (Array.isArray(it.customizations) && it.customizations.length) {
      const seen = new Set();
      for (const c of it.customizations) {
        const oid = c && c.option_id;
        if (!oid || seen.has(String(oid))) continue;
        seen.add(String(oid));
        const hit = custMap.get(String(m.id) + '::' + String(oid));
        if (hit) {
          custExtra += hit.price_paise;
          custNames.push(hit.name);
        }
      }
    }
    subtotal += (m.price_paise + custExtra) * qty;
    snapshots.push({
      menu_item_id: m.id,
      name_snapshot: m.name + (custNames.length ? ' (' + custNames.join(', ') + ')' : ''),
      unit_price_paise: m.price_paise + custExtra,
      qty,
      instructions: it.instructions || it.note || null
    });
  }
  return { subtotal, snapshots };
}

// Coupon validation for multi-group flows. Returns { discount, couponId, couponError }
// (never throws for coupon problems — callers decide).
async function resolveCoupon(q, couponCode, subtotalPaise, userId) {
  if (!couponCode) return { discount: 0, couponId: null, couponError: null };
  const cRes = await q('SELECT * FROM coupons WHERE code = $1 AND active = true', [String(couponCode).toUpperCase()]);
  const coupon = cRes.rows[0];
  const now = new Date();
  if (!coupon) return { discount: 0, couponId: null, couponError: 'Invalid coupon code' };
  if (coupon.valid_from && new Date(coupon.valid_from) > now) return { discount: 0, couponId: null, couponError: 'Coupon not yet valid' };
  if (coupon.valid_to && new Date(coupon.valid_to) < now) return { discount: 0, couponId: null, couponError: 'Coupon expired' };
  if (subtotalPaise < coupon.min_order_paise) {
    return { discount: 0, couponId: null, couponError: `Coupon needs a minimum order of Rs ${(coupon.min_order_paise / 100).toFixed(0)}` };
  }
  if (coupon.requires_student) {
    const uRes = await q('SELECT is_student FROM users WHERE id = $1', [userId]);
    if (!uRes.rows[0] || !uRes.rows[0].is_student) {
      return { discount: 0, couponId: null, couponError: 'This coupon is for verified students only' };
    }
  }
  let discount = coupon.discount_type === 'flat' ? coupon.value : Math.round((subtotalPaise * coupon.value) / 100);
  if (coupon.max_discount_paise != null) discount = Math.min(discount, coupon.max_discount_paise);
  discount = Math.min(discount, subtotalPaise);
  return { discount, couponId: coupon.id, couponError: null };
}

// Most recent open on-the-way primary for this customer+address whose group
// still has room for another secondary. Null => this call starts a new group.
async function findOtwPrimary(client, customerId, addressId) {
  const { rows } = await client.query(
    `SELECT o.id, o.restaurant_id, o.otw_group_size, o.status, o.scheduled_for,
            (SELECT COUNT(*) FROM orders s WHERE s.otw_primary_order_id = o.id) AS sec_count
     FROM orders o
     WHERE o.customer_id = $1 AND o.otw_role = 'primary' AND o.address_id = $2
       AND o.placed_at > now() - interval '15 minutes'
       AND o.status NOT IN ('cancelled', 'rejected', 'delivered')
     ORDER BY o.placed_at DESC
     LIMIT 1`,
    [customerId, addressId]
  );
  const p = rows[0];
  if (!p) return null;
  const size = Number(p.otw_group_size) || 2;
  if (1 + Number(p.sec_count) >= size) return null; // group complete
  return p;
}

// Multi-restaurant quote: primary at 100%, on-route secondaries at 20% of
// their own distance-based fee, off-route secondaries EXCLUDED (listed under
// excluded_off_route — never repriced, never silently dropped).
async function multiGroupQuote(req, res, { groupDefs, dineIn, address_id, coupon_code, tip_paise }) {
  const q = (...a) => db.query(...a);
  const primDef = groupDefs.find((g) => g.primary) || groupDefs[0];

  // Independent reads run together: primary restaurant + address + pricing config.
  const [rRes, aRes, config] = await Promise.all([
    q(
      "SELECT id, name, lat, lng, commission_pct FROM restaurants WHERE id = $1 AND status = 'approved'",
      [primDef.restaurant_id]
    ),
    dineIn
      ? Promise.resolve({ rows: [{}] })
      : q('SELECT lat, lng FROM addresses WHERE id = $1 AND user_id = $2', [address_id, req.user.id]),
    loadPricingConfig(db)
  ]);
  const primRest = rRes.rows[0];
  if (!primRest) return res.status(404).json({ error: 'Restaurant not available' });

  let address = null;
  if (!dineIn) {
    address = aRes.rows[0];
    if (!address) return res.status(400).json({ error: 'Delivery address not found' });
  }
  const tipPaise = Math.max(0, Math.round(Number(tip_paise) || 0));

  // Primary group (coupon lives here, as the app sends it)
  const pq = await priceQuoteItems(q, primDef.items, primRest.id);
  if (pq.error) return res.status(400).json({ error: pq.error });
  const rc = await resolveCoupon(q, coupon_code, pq.subtotal, req.user.id);
  let primDist = null;
  if (!dineIn && primRest.lat != null && primRest.lng != null && address.lat != null && address.lng != null) {
    primDist = haversineKm(Number(primRest.lat), Number(primRest.lng), Number(address.lat), Number(address.lng));
  }
  const primQuote = computeQuote({
    config, distanceKm: dineIn ? 0 : primDist,
    subtotalPaise: pq.subtotal, discountPaise: rc.discount,
    commissionPct: primRest.commission_pct,
    taxRates: config.taxRates, gstFoodBasePaise: pq.subtotal
  });
  const primDelivery = dineIn ? 0 : primQuote.deliveryFeePaise;

  const groupsOut = [{
    restaurant_id: primRest.id, name: primRest.name, primary: true,
    subtotal_paise: pq.subtotal, discount_paise: rc.discount,
    delivery_fee_paise: primDelivery, platform_fee_paise: primQuote.platformFeePaise,
    tax_paise: primQuote.taxPaise,
    total_paise: (pq.subtotal - rc.discount) + primDelivery + primQuote.platformFeePaise + primQuote.taxPaise
  }];
  const excludedOffRoute = [];
  let secFood = 0, secDelivery = 0;

  // Secondary restaurant rows are independent — fetch them together, then
  // process in order (preserves exact behavior, just fewer round trips).
  const secDefs = groupDefs.filter((g) => !g.primary);
  const secRows = await Promise.all(
    secDefs.map((def) =>
      q(
        "SELECT id, name, lat, lng, is_open, is_coming_soon FROM restaurants WHERE id = $1 AND status = 'approved'",
        [def.restaurant_id]
      )
    )
  );
  for (let si = 0; si < secDefs.length; si++) {
    const def = secDefs[si];
    const sRest = secRows[si].rows[0];
    if (!sRest) { excludedOffRoute.push({ restaurant_id: def.restaurant_id, name: null, reason: 'not_found' }); continue; }
    if (sRest.is_coming_soon || !sRest.is_open) {
      excludedOffRoute.push({ restaurant_id: sRest.id, name: sRest.name, reason: 'unavailable' });
      continue;
    }
    const routeDec = await otwDiscountDecision(sRest, primRest, address || {});
    if (routeDec.decision === 'deny') {
      excludedOffRoute.push({ restaurant_id: sRest.id, name: sRest.name, reason: routeDec.reason });
      continue;
    }
    // 'grant' (verified on-route) or 'grant_unverifiable' (coords missing —
    // matches the app's current permissive behavior; audit-flagged later).
    const sq = await priceQuoteItems(q, def.items, sRest.id);
    if (sq.error) return res.status(400).json({ error: sq.error });
    if (!sq.subtotal) { excludedOffRoute.push({ restaurant_id: sRest.id, name: sRest.name, reason: 'no_valid_items' }); continue; }
    let secDist = null;
    if (sRest.lat != null && sRest.lng != null && address.lat != null && address.lng != null) {
      secDist = haversineKm(Number(sRest.lat), Number(sRest.lng), Number(address.lat), Number(address.lng));
    }
    const ownFee = deliveryFeePaise(config.deliveryTiers, secDist == null ? (Number(config.fallbackDistanceKm) || 5) : secDist, sq.subtotal, config.freeDeliveryRules);
    const chargedFee = Math.round(ownFee * 0.2);
    secFood += sq.subtotal;
    secDelivery += chargedFee;
    const secGst = computeGstPaise(config.taxRates, { foodPaise: sq.subtotal, deliveryPaise: chargedFee, platformPaise: 0 });
    groupsOut.push({
      restaurant_id: sRest.id, name: sRest.name, primary: false,
      subtotal_paise: sq.subtotal, discount_paise: 0,
      delivery_fee_paise: chargedFee, delivery_fee_full_paise: ownFee,
      platform_fee_paise: 0, tax_paise: secGst.total,
      total_paise: sq.subtotal + chargedFee + secGst.total,
      otw_discount_applied: true
    });
  }

  const gst = computeGstPaise(config.taxRates, {
    foodPaise: pq.subtotal + secFood,
    deliveryPaise: primDelivery + secDelivery,
    platformPaise: primQuote.platformFeePaise
  });
  const grandSubtotal = pq.subtotal + secFood;
  res.json({
    groups: groupsOut,
    excluded_off_route: excludedOffRoute,
    bill: {
      subtotal_paise: grandSubtotal,
      discount_paise: rc.discount,
      delivery_fee_paise: primDelivery + secDelivery,
      platform_fee_paise: primQuote.platformFeePaise,
      tax_paise: gst.total,
      gst_breakdown: gst,
      tip_paise: tipPaise,
      total_paise: (grandSubtotal - rc.discount) + primDelivery + secDelivery + primQuote.platformFeePaise + gst.total + tipPaise
    },
    coupon_error: rc.couponError,
    eta_minutes: Number(config.etaMinutes) || 30
  });
}


// POST /api/orders/quote { restaurant_id, address_id?, items, coupon_code?, order_type?, table_id?, tip_paise? }
// Read-only bill preview: returns the exact fee breakdown the customer will
// pay, computed with the same pricing engine as order placement. No order created.
router.post(
  '/quote',
  ah(async (req, res) => {
    const { restaurant_id, address_id, items, coupon_code, order_type, table_id, tip_paise } = req.body;
    const dineIn = order_type === 'dinein';

    const groupDefs = buildGroupDefs({ bodyGroups: req.body.groups, items, restaurant_id, dineIn });
    if (!Array.isArray(groupDefs)) return res.status(400).json({ error: groupDefs.error });
    if (!dineIn && !address_id) {
      return res.status(400).json({ error: 'address_id is required for delivery orders' });
    }
    if (groupDefs.length > 1) {
      return multiGroupQuote(req, res, { groupDefs, dineIn, address_id, coupon_code, tip_paise });
    }
    // Independent reads run together: restaurant row + pricing config.
    // (Address/table check stays sequential to preserve error precedence.)
    const [rRes, config] = await Promise.all([
      db.query(
        "SELECT id, lat, lng, commission_pct FROM restaurants WHERE id = $1 AND status = 'approved'",
        [restaurant_id]
      ),
      loadPricingConfig(db)
    ]);
    const restaurant = rRes.rows[0];
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not available' });

    let address = null;
    if (!dineIn) {
      const aRes = await db.query('SELECT lat, lng FROM addresses WHERE id = $1 AND user_id = $2', [
        address_id,
        req.user.id
      ]);
      address = aRes.rows[0];
      if (!address) return res.status(400).json({ error: 'Delivery address not found' });
    } else if (table_id) {
      const tRes = await db.query('SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2', [
        table_id, restaurant_id
      ]);
      if (!tRes.rows[0]) return res.status(400).json({ error: 'Table not found for this restaurant' });
    }

    const pq = await priceQuoteItems((...a) => db.query(...a), items, restaurant_id);
    if (pq.error) return res.status(400).json({ error: pq.error });
    const subtotal = pq.subtotal;

    // Coupon (quote only — placement re-validates everything inside its transaction)
    let discount = 0;
    let couponError = null;
    if (coupon_code) {
      const cRes = await db.query(
        'SELECT * FROM coupons WHERE code = $1 AND active = true',
        [String(coupon_code).toUpperCase()]
      );
      const coupon = cRes.rows[0];
      const now = new Date();
      if (!coupon) couponError = 'Invalid coupon code';
      else if (coupon.valid_from && new Date(coupon.valid_from) > now) couponError = 'Coupon not yet valid';
      else if (coupon.valid_to && new Date(coupon.valid_to) < now) couponError = 'Coupon expired';
      else if (subtotal < coupon.min_order_paise) {
        couponError = `Coupon needs a minimum order of Rs ${(coupon.min_order_paise / 100).toFixed(0)}`;
      } else if (coupon.requires_student) {
        const uRes = await db.query('SELECT is_student FROM users WHERE id = $1', [req.user.id]);
        if (!uRes.rows[0] || !uRes.rows[0].is_student) couponError = 'This coupon is for verified students only';
      }
      if (!couponError) {
        discount =
          coupon.discount_type === 'flat'
            ? coupon.value
            : Math.round((subtotal * coupon.value) / 100);
        if (coupon.max_discount_paise != null) discount = Math.min(discount, coupon.max_discount_paise);
        discount = Math.min(discount, subtotal);
      }
    }

    let distanceKm = null;
    if (!dineIn && restaurant.lat != null && restaurant.lng != null && address.lat != null && address.lng != null) {
      distanceKm = haversineKm(
        Number(restaurant.lat),
        Number(restaurant.lng),
        Number(address.lat),
        Number(address.lng)
      );
    }
    const tipPaise = Math.max(0, Math.round(Number(tip_paise) || 0));
    const quote = computeQuote({
      config,
      distanceKm: dineIn ? 0 : distanceKm,
      subtotalPaise: subtotal,
      discountPaise: discount,
      commissionPct: restaurant.commission_pct,
      taxRates: config.taxRates,
      gstFoodBasePaise: subtotal
    });

    res.json({
      bill: {
        subtotal_paise: subtotal,
        discount_paise: discount,
        delivery_fee_paise: dineIn ? 0 : quote.deliveryFeePaise,
        platform_fee_paise: quote.platformFeePaise,
        tax_paise: quote.taxPaise,
        tip_paise: tipPaise,
        total_paise: (dineIn ? 0 : quote.deliveryFeePaise) + quote.platformFeePaise + tipPaise + (subtotal - discount) + quote.taxPaise,
        gst_breakdown: quote.gstBreakdown
      },
      coupon_error: couponError,
      eta_minutes: Number(config.etaMinutes) || 30
    });
  })
);

// POST /api/orders { restaurant_id, address_id?, order_type?, table_id?, items, coupon_code?, payment_method?, delivery_note?, no_cutlery?, tip_paise?, recipient_name?, recipient_phone?, is_on_the_way?, group_size?, client_total_paise?, groups? }
// The backend recomputes EVERYTHING server-side: item prices, per-restaurant
// delivery fees, GST, coupon. Client-supplied totals/fees/discounts are ignored.
// Primary pays the full distance-based delivery fee. A secondary pays 20% of
// its own distance-based fee ONLY when on the primary -> address route;
// off-route secondaries are STRIPPED (never delivered, never repriced).
// Secondary orders never carry an extra platform fee.
// Deliverability (founder rule): every restaurant delivers everywhere in
// Nellore — placement is rejected ONLY when the address is clearly OUTSIDE
// the Nellore service area.
router.post(
  '/',
  idempotency('orders:create'),
  ah(async (req, res) => {
    const { restaurant_id, address_id, items, coupon_code, payment_method,
            order_type, table_id, delivery_note, no_cutlery, tip_paise,
            recipient_name, recipient_phone,
            is_on_the_way, group_size, client_total_paise } = req.body;
    const dineIn = order_type === 'dinein';

    // Scheduled ordering is delivery-only.
    const scheduledRaw = req.body.scheduled_for;
    if (dineIn && scheduledRaw != null && scheduledRaw !== '') {
      return res.status(400).json({ error: 'Scheduled ordering is available for delivery orders only' });
    }
    let scheduledAt = null;
    if (!dineIn && scheduledRaw != null && scheduledRaw !== '') {
      const v = parseScheduledFor(scheduledRaw);
      if (!v.ok) return res.status(400).json({ error: v.error });
      scheduledAt = v.date;
    }

    const groupDefs = buildGroupDefs({ bodyGroups: req.body.groups, items, restaurant_id, dineIn });
    if (!Array.isArray(groupDefs)) return res.status(400).json({ error: groupDefs.error });

    // Block scheduling for restaurants suspended by admin for late cancellations.
    // Checks ALL restaurants in the group (primary + on-the-way secondaries).
    if (scheduledAt) {
      const suspIds = [...new Set(groupDefs.map((g) => String(g.restaurant_id)))];
      const { rows: suspRows } = await db.query(
        `SELECT r.name FROM restaurants r
         WHERE r.id = ANY($1) AND r.scheduling_suspended = true LIMIT 1`,
        [suspIds]
      );
      if (suspRows.length) {
        const sName = suspRows[0].name || 'this restaurant';
        return res.status(403).json({ error: `Scheduled ordering is temporarily unavailable for ${sName}` });
      }
    }
    if (!dineIn && !address_id) {
      return res.status(400).json({ error: 'address_id is required for delivery orders' });
    }

    const declaredOtw = !dineIn && !!is_on_the_way && Number(group_size) > 1;
    const multiGroup = !dineIn && groupDefs.length > 1;

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      // ---- founder rule: ONE scheduled order per restaurant (strict) ----
      // A customer can have only ONE active scheduled order from a given
      // restaurant at a time, regardless of time slot — even two different
      // times or two different dishes are not allowed. Different restaurants
      // may each have their own scheduled order. Checked inside the
      // transaction so double-taps cannot both slip through.
      if (scheduledAt) {
        const restIds = [...new Set(groupDefs.map((g) => String(g.restaurant_id)))];
        const dup = await client.query(
          `SELECT r.name AS restaurant_name
             FROM orders o
             JOIN restaurants r ON r.id = o.restaurant_id
            WHERE o.customer_id = $1
              AND o.restaurant_id = ANY($2)
              AND o.status = 'scheduled'
            LIMIT 1`,
          [req.user.id, restIds]
        );
        if (dup.rows.length) {
          const rName = dup.rows[0].restaurant_name || 'this restaurant';
          throw {
            status: 400,
            message: `You already have a scheduled order from ${rName}.`
          };
        }
      }

      // ---- address + Nellore service-area gate ----
      // Independent reads (address/table row, pricing config, primary
      // restaurant row) run together inside the transaction. Validation
      // order is preserved exactly: address first, then restaurant.
      const primDef = groupDefs.find((g) => g.primary) || groupDefs[0];
      const addrQuery = dineIn
        ? (table_id
          ? client.query('SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2', [table_id, restaurant_id])
          : Promise.resolve({ rows: [{}] }))
        : client.query('SELECT * FROM addresses WHERE id = $1 AND user_id = $2', [address_id, req.user.id]);
      const [aRes, config, rRes] = await Promise.all([
        addrQuery,
        loadPricingConfig(client),
        client.query("SELECT * FROM restaurants WHERE id = $1 AND status = 'approved'", [primDef.restaurant_id])
      ]);
      const tipPaise = Math.max(0, Math.round(Number(tip_paise) || 0));

      let address = null;
      if (dineIn) {
        if (!table_id) throw { status: 400, message: 'Table is required for dine-in orders' };
        if (!aRes.rows[0]) throw { status: 400, message: 'Table not found for this restaurant' };
      } else {
        address = aRes.rows[0];
        if (!address) throw { status: 400, message: 'Delivery address not found' };
        const area = isInServiceArea(address);
        if (area === 'outside') {
          await client.query('ROLLBACK');
          await otwAudit('service_area_rejected', {
            customer_id: req.user.id, address_id,
            reason: 'outside_nellore', meta: { city: address.city }
          });
          return res.status(400).json({
            error: 'We currently deliver only within Nellore.',
            code: 'OUTSIDE_SERVICE_AREA'
          });
        }
        if (area === 'unknown') {
          otwAudit('service_area_undetermined', {
            customer_id: req.user.id, address_id,
            reason: 'undeterminable', meta: { city: address.city }
          });
        }
      }

      // ---- primary restaurant (validated for every order) ----
      const primRest = rRes.rows[0];
      if (!primRest) throw { status: 404, message: 'Restaurant not available' };
      if (primRest.is_coming_soon) throw { status: 400, message: 'Restaurant is opening soon — not accepting orders yet' };
      // Scheduled orders may be placed while the kitchen is closed — the
      // restaurant pre-accepts (or pre-rejects) before activation.
      if (!primRest.is_open && !scheduledAt) throw { status: 400, message: 'Restaurant is currently closed' };

      // ---- on-the-way role resolution ----
      // Split-call flow (today's app): one restaurant per call. A call flagged
      // is_on_the_way joins the customer's recent open primary group as a
      // secondary; otherwise it starts a new primary group. Fail closed: no
      // resolvable primary => full-fee primary, never a free discount.
      let otwRole = null; // null | 'primary' | 'secondary'
      let otwPrimaryOrderId = null;
      let otwGroupSize = null;
      let otwPrimaryRest = primRest;
      // Split-call secondary joining a still-scheduled primary inherits its
      // scheduled slot (goes live with the group at activation).
      let inheritScheduledAt = null;
      if (!multiGroup && declaredOtw) {
        const cand = await findOtwPrimary(client, req.user.id, address_id);
        if (cand && String(cand.restaurant_id) !== String(primRest.id)) {
          const pRes = await client.query(
            'SELECT id, name, lat, lng FROM restaurants WHERE id = $1', [cand.restaurant_id]);
          const pRest = pRes.rows[0];
          if (!pRest) throw { status: 400, message: 'The main restaurant for this order is no longer available' };
          const routeDec = await otwDiscountDecision(primRest, pRest, address);
          if (routeDec.decision === 'deny') {
            const reason = routeDec.reason;
            await client.query('ROLLBACK');
            await otwAudit('secondary_stripped', {
              customer_id: req.user.id, primary_restaurant_id: pRest.id,
              secondary_restaurant_id: primRest.id, address_id,
              fee_charged_paise: 0, reason, meta: { via: 'split_call' }
            });
            return res.status(400).json({
              error: `"${primRest.name}" is not on the way to your delivery address, so it was removed from your order.`,
              code: 'OTW_OFF_ROUTE',
              removed_off_route: [{ restaurant_id: primRest.id, name: primRest.name, reason }]
            });
          }
          // 'grant' (verified on-route) or 'grant_unverifiable' (coords missing;
          // the app lists such restaurants as on-the-way — flagged in audit).
          otwRole = 'secondary';
          otwPrimaryOrderId = cand.id;
          otwPrimaryRest = pRest;
          if (cand.status === 'scheduled' && cand.scheduled_for) {
            inheritScheduledAt = new Date(cand.scheduled_for);
          }
          if (routeDec.decision === 'grant_unverifiable') {
            await otwAudit('secondary_discount_unverifiable', {
              customer_id: req.user.id, primary_restaurant_id: pRest.id,
              secondary_restaurant_id: primRest.id, address_id,
              fee_charged_paise: null, reason: 'unverifiable_granted',
              meta: { via: 'split_call' }
            });
          }
        } else {
          otwRole = 'primary';
          otwGroupSize = Number(group_size) || 2;
        }
      } else if (multiGroup) {
        otwRole = 'primary';
        otwGroupSize = groupDefs.length;
      }

      // ---- price the primary (or single) group ----
      const primPriced = await pricePlacementItems(client, primDef.items, primRest.id);

      let discount = 0;
      let couponId = null;
      if (otwRole !== 'secondary' && coupon_code) {
        const cRes = await client.query(
          'SELECT * FROM coupons WHERE code = $1 AND active = true',
          [String(coupon_code).toUpperCase()]
        );
        const coupon = cRes.rows[0];
        const now = new Date();
        if (!coupon) throw { status: 400, message: 'Invalid coupon code' };
        if (coupon.valid_from && new Date(coupon.valid_from) > now) throw { status: 400, message: 'Coupon not yet valid' };
        if (coupon.valid_to && new Date(coupon.valid_to) < now) throw { status: 400, message: 'Coupon expired' };
        if (primPriced.subtotal < coupon.min_order_paise) {
          throw { status: 400, message: `Coupon needs a minimum order of Rs ${(coupon.min_order_paise / 100).toFixed(0)}` };
        }
        if (coupon.requires_student) {
          const uRes = await client.query('SELECT is_student FROM users WHERE id = $1', [req.user.id]);
          if (!uRes.rows[0] || !uRes.rows[0].is_student) {
            throw { status: 400, message: 'This coupon is for verified students only' };
          }
        }
        discount =
          coupon.discount_type === 'flat'
            ? coupon.value
            : Math.round((primPriced.subtotal * coupon.value) / 100);
        if (coupon.max_discount_paise != null) discount = Math.min(discount, coupon.max_discount_paise);
        discount = Math.min(discount, primPriced.subtotal);
        couponId = coupon.id;
      }

      let distanceKm = null;
      if (!dineIn && primRest.lat != null && primRest.lng != null && address.lat != null && address.lng != null) {
        distanceKm = haversineKm(Number(primRest.lat), Number(primRest.lng), Number(address.lat), Number(address.lng));
      }

      let deliveryFee, platformFee, gst, commissionPaise, deliveryFeeFull = null;
      if (otwRole === 'secondary') {
        const ownFee = deliveryFeePaise(config.deliveryTiers, distanceKm == null ? (Number(config.fallbackDistanceKm) || 5) : distanceKm, primPriced.subtotal - discount, config.freeDeliveryRules);
        deliveryFeeFull = ownFee;
        deliveryFee = Math.round(ownFee * 0.2);
        platformFee = 0; // no additional platform fee for secondaries
        gst = computeGstPaise(config.taxRates, {
          foodPaise: primPriced.subtotal, deliveryPaise: deliveryFee, platformPaise: 0
        });
        const pct = primRest.commission_pct != null ? Number(primRest.commission_pct) : Number(config.defaultCommissionPct);
        commissionPaise = Math.round(((primPriced.subtotal - discount) * pct) / 100);
      } else {
        const quote = computeQuote({
          config,
          distanceKm: dineIn ? 0 : distanceKm,
          subtotalPaise: primPriced.subtotal,
          discountPaise: discount,
          commissionPct: primRest.commission_pct,
          taxRates: config.taxRates,
          gstFoodBasePaise: primPriced.subtotal
        });
        deliveryFee = dineIn ? 0 : quote.deliveryFeePaise;
        platformFee = quote.platformFeePaise;
        gst = quote.gstBreakdown;
        commissionPaise = quote.commissionPaise;
      }

      // ---- multi-group single call: price secondaries, strip off-route ones ----
      const removedOffRoute = [];
      const extraSpecs = [];
      if (multiGroup) {
        // Secondary restaurant rows are independent — fetch together, then
        // process in order (same behavior, fewer round trips).
        const secDefs = groupDefs.filter((g) => !g.primary);
        const secRows = await Promise.all(
          secDefs.map((def) =>
            client.query("SELECT * FROM restaurants WHERE id = $1 AND status = 'approved'", [def.restaurant_id])
          )
        );
        for (let si = 0; si < secDefs.length; si++) {
          const def = secDefs[si];
          const sRest = secRows[si].rows[0];
          if (!sRest) { removedOffRoute.push({ restaurant_id: def.restaurant_id, name: null, reason: 'not_found' }); continue; }
          // Closed kitchens are stripped from ASAP orders only — a scheduled
          // order may still be pre-accepted before its slot.
          if (sRest.is_coming_soon || (!sRest.is_open && !scheduledAt)) {
            removedOffRoute.push({ restaurant_id: sRest.id, name: sRest.name, reason: 'unavailable' });
            continue;
          }
          const routeDec = await otwDiscountDecision(sRest, primRest, address);
          if (routeDec.decision === 'deny') {
            const reason = routeDec.reason;
            removedOffRoute.push({ restaurant_id: sRest.id, name: sRest.name, reason });
            otwAudit('secondary_stripped', {
              customer_id: req.user.id, primary_restaurant_id: primRest.id,
              secondary_restaurant_id: sRest.id, address_id,
              fee_charged_paise: 0, reason, meta: { via: 'single_call' }
            });
            continue;
          }
          if (routeDec.decision === 'grant_unverifiable') {
            otwAudit('secondary_discount_unverifiable', {
              customer_id: req.user.id, primary_restaurant_id: primRest.id,
              secondary_restaurant_id: sRest.id, address_id,
              fee_charged_paise: null, reason: 'unverifiable_granted',
              meta: { via: 'single_call' }
            });
          }
          const priced = await pricePlacementItems(client, def.items, sRest.id);
          let secDist = null;
          if (sRest.lat != null && sRest.lng != null && address.lat != null && address.lng != null) {
            secDist = haversineKm(Number(sRest.lat), Number(sRest.lng), Number(address.lat), Number(address.lng));
          }
          const ownFee = deliveryFeePaise(config.deliveryTiers, secDist == null ? (Number(config.fallbackDistanceKm) || 5) : secDist, priced.subtotal, config.freeDeliveryRules);
          const chargedFee = Math.round(ownFee * 0.2);
          const secGst = computeGstPaise(config.taxRates, {
            foodPaise: priced.subtotal, deliveryPaise: chargedFee, platformPaise: 0
          });
          const pct = sRest.commission_pct != null ? Number(sRest.commission_pct) : Number(config.defaultCommissionPct);
          extraSpecs.push({
            restaurant: sRest, priced, discount: 0, couponId: null,
            deliveryFee: chargedFee, deliveryFeeFull: ownFee, platformFee: 0,
            gst: secGst, commissionPaise: Math.round((priced.subtotal * pct) / 100),
            tipPaise: 0, role: 'secondary', discountApplied: true,
            primaryOrderId: null, groupSize: null, distanceKm: secDist
          });
        }
      }

      // ---- create the order row(s) ----
      const specs = [{
        restaurant: primRest, priced: primPriced, discount, couponId,
        deliveryFee, deliveryFeeFull, platformFee, gst, commissionPaise,
        tipPaise, role: otwRole, discountApplied: otwRole === 'secondary',
        primaryOrderId: otwPrimaryOrderId, groupSize: otwGroupSize, distanceKm
      }];
      for (const s of extraSpecs) specs.push(s);

      // Initial status: scheduled orders wait for activation; everything else
      // is placed immediately (existing ASAP flow, untouched).
      const scheduledForValue = scheduledAt || inheritScheduledAt || null;
      const initialStatus = scheduledForValue ? 'scheduled' : 'placed';

      const timeline = [{ status: initialStatus, at: new Date().toISOString(), by: 'customer' }];
      const etaMinutes = Number(config.etaMinutes) || 30;
      // Scheduled orders promise the customer's chosen slot, not now()+30m.
      const etaAt = scheduledForValue || new Date(Date.now() + etaMinutes * 60000);
      const created = [];
      let primaryOrderId = null;

      for (let idx = 0; idx < specs.length; idx++) {
        const spec = specs[idx];
        if (idx > 0 && spec.role === 'secondary' && !spec.primaryOrderId) {
          spec.primaryOrderId = primaryOrderId;
        }
        const specTotal = (spec.priced.subtotal - spec.discount) + spec.deliveryFee + spec.platformFee + spec.gst.total + spec.tipPaise;
        const shareToken = require('crypto').randomBytes(6).toString('hex');
        // Delivery OTP: generated at order placement so the customer sees it
        // immediately. Dine-in orders don't need one.
        let otpPlain = null, otpHash = null;
        if (!dineIn) {
          otpPlain = newDeliveryOtp();
          otpHash = await bcrypt.hash(otpPlain, 8);
        }
        const oRes = await client.query(
          `INSERT INTO orders
             (customer_id, restaurant_id, address_id, status, order_type, table_id,
              subtotal_paise, discount_paise, delivery_fee_paise, platform_fee_paise,
              tax_paise, commission_paise, total_paise, tip_paise,
              delivery_note, no_cutlery, recipient_name, recipient_phone,
              payment_method, payment_status, timeline, eta_at, share_token,
              otw_role, otw_primary_order_id, otw_group_size, otw_discount_denied,
              delivery_otp, delivery_otp_hash, scheduled_for)
           VALUES ($1,$2,$3,$28,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending',$19::jsonb,
                   $20, $21, $22, $23, $24, $25, $26, $27, $29)
           RETURNING *`,
          [req.user.id, spec.restaurant.id, dineIn ? null : address_id, dineIn ? 'dinein' : 'delivery',
           dineIn ? table_id : null,
           spec.priced.subtotal, spec.discount, spec.deliveryFee, spec.platformFee,
           spec.gst.total, spec.commissionPaise, specTotal, spec.tipPaise,
           delivery_note || null, !!no_cutlery, recipient_name || null, recipient_phone || null,
           payment_method || 'upi', JSON.stringify(timeline), etaAt, shareToken,
           spec.role, spec.primaryOrderId, spec.role === 'primary' ? spec.groupSize : null, false,
           otpPlain, otpHash, initialStatus, scheduledForValue]
        );
        const order = oRes.rows[0];
        if (idx === 0) primaryOrderId = order.id;
        if (spec.priced.snapshots.length) {
          const iv = [];
          const ip = [];
          spec.priced.snapshots.forEach((s, k) => {
            const b = k * 6;
            iv.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
            ip.push(order.id, s.menu_item_id, s.name_snapshot, s.unit_price_paise, s.qty, s.instructions);
          });
          await client.query(
            `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, unit_price_paise, qty, instructions)
             VALUES ${iv.join(',')}`,
            ip
          );
        }
        if (spec.role === 'secondary') {
          otwAudit('discount_granted', {
            order_id: order.id, customer_id: req.user.id,
            primary_restaurant_id: (idx === 0 ? otwPrimaryRest : primRest).id,
            secondary_restaurant_id: spec.restaurant.id, address_id,
            fee_charged_paise: spec.deliveryFee, fee_full_paise: spec.deliveryFeeFull,
            reason: 'on_route', meta: { via: multiGroup ? 'single_call' : 'split_call' }
          });
        }
        created.push({ order, spec, total: specTotal, shareToken });
      }

      // Single-use referral coupons: burn after applying so "Rs 50 off your
      // next order" can't be replayed on every order. Generic admin coupons
      // (no issuance record) stay multi-use as before.
      if (specs[0].couponId) {
        const iss = await client.query(
          `SELECT 1 FROM coupon_issuances
           WHERE user_id = $1 AND coupon_code = $2 AND source = 'referral'`,
          [req.user.id, String(coupon_code).toUpperCase()]
        );
        if (iss.rows[0]) {
          await client.query('UPDATE coupons SET active = false WHERE id = $1', [specs[0].couponId]);
        }
      }
      await client.query('COMMIT');

      if (initialStatus === 'scheduled') {
        // Scheduled orders stay invisible to kitchens and riders until
        // activation (30 min before scheduled_for). Only the customer is told.
        const { formatKolkata } = require('../lib/scheduled');
        await notify(req.user.id, 'Order scheduled ✅',
          `Order scheduled for ${formatKolkata(scheduledForValue)} — we'll start preparing 30 min before.`);
      } else {
        for (const c of created) {
          const ownerRes = await db.query('SELECT owner_id FROM restaurants WHERE id = $1', [c.spec.restaurant.id]);
          if (ownerRes.rows[0] && ownerRes.rows[0].owner_id) {
            await notify(ownerRes.rows[0].owner_id, '🔔 New order!',
              `${dineIn ? 'Dine-in table order' : 'Delivery order'} worth Rs ${(c.total / 100).toFixed(2)} — the kitchen needs you! 👨‍🍳`);
          }
        }
        const firstName = created[0].spec.restaurant.name;
        const _otp0 = !dineIn && created[0] && created[0].order ? created[0].order.delivery_otp : null;
        await notify(req.user.id, 'Order placed ✅',
          `${firstName}${created.length > 1 ? ` (+${created.length - 1} more)` : ''} got your order and the kitchen is firing up! 🔥` +
          (_otp0 ? ` Your delivery OTP is ${_otp0} — share it with your rider at handover.` : ''));
      }

      const buildBreakdown = (c) => ({
        subtotal_paise: c.spec.priced.subtotal,
        discount_paise: c.spec.discount,
        delivery_fee_paise: c.spec.deliveryFee,
        platform_fee_paise: c.spec.platformFee,
        tax_paise: c.spec.gst.total,
        gst_breakdown: c.spec.gst,
        tip_paise: c.spec.tipPaise,
        total_paise: c.total,
        eta_minutes: etaMinutes,
        distance_km: c.spec.distanceKm == null ? null : Math.round(c.spec.distanceKm * 100) / 100,
        coupon_id: c.spec.couponId,
        share_token: c.shareToken
      });
      const buildOtw = (c) => {
        if (!c.spec.role) return undefined;
        if (c.spec.role === 'secondary') {
          return {
            role: 'secondary',
            primary_order_id: c.spec.primaryOrderId,
            delivery_fee_full_paise: c.spec.deliveryFeeFull,
            discount_applied: true
          };
        }
        return { role: 'primary', group_size: c.spec.groupSize };
      };

      if (created.length === 1) {
        const c = created[0];
        const resp = {
          order: { ...c.order, items: c.spec.priced.snapshots },
          breakdown: buildBreakdown(c)
        };
        const otw = buildOtw(c);
        if (otw) resp.otw = otw;
        if (removedOffRoute.length) resp.removed_off_route = removedOffRoute;
        if (client_total_paise != null && Number(client_total_paise) !== c.total) {
          resp.bill_adjusted = true;
        }
        return res.status(201).json(resp);
      }
      const grandTotal = created.reduce((a, c) => a + c.total, 0);
      const resp = {
        orders: created.map((c) => ({
          order: { ...c.order, items: c.spec.priced.snapshots },
          breakdown: buildBreakdown(c),
          otw: buildOtw(c)
        })),
        removed_off_route: removedOffRoute
      };
      if (client_total_paise != null && Number(client_total_paise) !== grandTotal) {
        resp.bill_adjusted = true;
      }
      return res.status(201).json(resp);
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    } finally {
      client.release();
    }
  })
);
// POST /api/orders/:id/pay — simulates gateway success (replace with webhook later)
router.post(
  '/:id/pay',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.payment_status !== 'pending') {
      return res.status(409).json({ error: `Payment already ${order.payment_status}` });
    }
    await db.query("UPDATE orders SET payment_status = 'paid' WHERE id = $1", [order.id]);
    await db.query(
      `UPDATE orders SET timeline = COALESCE(timeline, '[]'::jsonb)
         || jsonb_build_object('status', 'paid', 'at', $1::text, 'by', 'customer')
       WHERE id = $2`,
      [new Date().toISOString(), order.id]
    );
    res.json({ ok: true, payment_status: 'paid' });
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
      `SELECT o.*, r.name AS restaurant_name, r.image_url AS restaurant_image
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE ${where} ORDER BY o.placed_at DESC LIMIT 50`,
      params
    );
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
              a.line1, a.line2, a.city, a.lat AS addr_lat, a.lng AS addr_lng,
              ru.name AS rider_name, ru.phone AS rider_phone,
              rd.profile_photo AS rider_photo, rd.rating_avg AS rider_rating,
              COALESCE(rdc.cnt, 0) AS rider_deliveries
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       LEFT JOIN addresses a ON a.id = o.address_id
       LEFT JOIN riders rd ON rd.id = o.rider_id
       LEFT JOIN users ru ON ru.id = rd.user_id
       LEFT JOIN (
         SELECT rider_id, COUNT(*) AS cnt FROM orders
         WHERE status = 'delivered' GROUP BY rider_id
       ) rdc ON rdc.rider_id = rd.id
       WHERE o.id = $1 AND o.customer_id = $2`,
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    delete order.delivery_otp_hash; // never expose to clients
    const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [order.id]);
    // Queue transparency: orders at this restaurant placed before mine, still active
    let queueAhead = 0;
    if (['placed', 'accepted', 'confirmed', 'preparing'].includes(order.status)) {
      const qRes = await db.query(
        `SELECT COUNT(*) AS n FROM orders
         WHERE restaurant_id = $1 AND placed_at < $2
           AND status IN ('placed','accepted','confirmed','preparing')`,
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
        await db.query(
          `UPDATE orders SET timeline = COALESCE(timeline, '[]'::jsonb)
             || jsonb_build_object('status', 'no_response_nudge', 'at', $1::text, 'by', 'system')
           WHERE id = $2 AND NOT (COALESCE(timeline, '[]'::jsonb) @> '[{"status":"no_response_nudge"}]')`,
          [new Date().toISOString(), order.id]);
      }
    }
    // Multi-stop (on-the-way) groups: expose per-stop rider progress so the
    // customer tracking screen can show "Rider reached {name}" / "Picked up
    // from {name}" per restaurant in route order. Single-restaurant orders
    // get an empty stops array and render exactly as before.
    let stops = [];
    {
      const primaryId = order.otw_role === 'secondary' && order.otw_primary_order_id
        ? String(order.otw_primary_order_id) : String(order.id);
      const g = await db.query(
        `SELECT o.id, o.status, o.timeline, r.name AS restaurant_name, r.lat AS rest_lat, r.lng AS rest_lng
         FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
         WHERE (o.id = $1 OR o.otw_primary_order_id = $1) AND o.customer_id = $2
         ORDER BY CASE WHEN o.otw_role = 'primary' THEN 0 ELSE 1 END, o.placed_at ASC, o.id ASC`,
        [primaryId, req.user.id]
      );
      if (g.rows.length > 1) {
        stops = g.rows
          .filter((r) => String(r.status).toLowerCase() !== 'cancelled')
          .map((r) => {
            const tl = Array.isArray(r.timeline) ? r.timeline : [];
            const ev = (s) => tl.some((t) => String(t.status || '').toLowerCase() === s);
            const picked = String(r.status).toLowerCase() === 'picked_up' || ev('picked_up');
            return {
              order_id: r.id,
              restaurant_name: r.restaurant_name || 'Restaurant',
              reached: ev('arrived_restaurant') || picked,
              picked_up: picked,
            };
          });
      }
    }
    // Live ETA: real driving time from rider's current position to customer.
    // Only when rider is on the way with known GPS; cached 60s server-side.
    // Falls back to null (frontend uses existing estimate).
    let live_eta_minutes = null;
    {
      const riderOnWay = ['picked_up', 'on_the_way', 'out_for_delivery', 'dispatched']
        .includes(String(order.status || '').toLowerCase());
      const rLat = Number(order.rider_lat);
      const rLng = Number(order.rider_lng);
      const aLat = Number(order.addr_lat);
      const aLng = Number(order.addr_lng);
      if (riderOnWay && Number.isFinite(rLat) && Number.isFinite(rLng) &&
          Number.isFinite(aLat) && Number.isFinite(aLng)) {
        try {
          const route = await getRouteDuration(rLat, rLng, aLat, aLng);
          if (route && route.durationSec != null) {
            live_eta_minutes = Math.max(1, Math.ceil(route.durationSec / 60));
          }
        } catch (e) {
          console.error('Live ETA failed:', e.message);
        }
      }
    }
    res.json({ order: { ...order, items: items.rows, queue_ahead: queueAhead, no_response: noResponse, stops, live_eta_minutes } });
  })
);

// POST /api/orders/:id/cancel { reason } — only before the restaurant accepts.
// Scheduled orders can be cancelled any time before activation.
router.post(
  '/:id/cancel',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!['placed', 'scheduled'].includes(order.status)) {
      return res.status(409).json({ error: 'Order can no longer be cancelled' });
    }
    const wasScheduled = order.status === 'scheduled';
    const wasPreAccepted = order.pre_accepted;
    const scheduledFor = order.scheduled_for;
    await transition(order.id, 'cancelled', 'customer');
    const refunded = order.payment_status === 'paid';
    await db.query(
      `UPDATE orders SET cancel_reason = $1, payment_status = $2,
         refunded_at = CASE WHEN $2 = 'refunded' THEN COALESCE(refunded_at, now()) ELSE refunded_at END
       WHERE id = $3`,
      [req.body.reason || 'Cancelled by customer', refunded ? 'refunded' : order.payment_status, order.id]
    );
    await notify(req.user.id, 'Order cancelled',
      `Your ${wasScheduled ? 'scheduled ' : ''}order has been cancelled.` +
      (refunded ? ' Your payment will be refunded.' : ''));
    // A pre-accepted scheduled order was already on the kitchen's radar —
    // tell the restaurant it's gone. (Non-pre-accepted scheduled orders were
    // never shown as active, so the kitchen gets nothing.)
    if (wasScheduled && wasPreAccepted) {
      const ownerRes = await db.query('SELECT owner_id FROM restaurants WHERE id = $1', [order.restaurant_id]);
      if (ownerRes.rows[0] && ownerRes.rows[0].owner_id) {
        const { formatKolkata } = require('../lib/scheduled');
        await notify(ownerRes.rows[0].owner_id, 'Scheduled order cancelled',
          `The customer cancelled a scheduled order` +
          (scheduledFor ? ` for ${formatKolkata(scheduledFor)}` : '') + `.`);
      }
    }
    // A rider had pre-accepted this scheduled order — tell them it's gone.
    if (wasScheduled && order.scheduled_rider_id) {
      const rr = await db.query('SELECT user_id FROM riders WHERE id = $1', [order.scheduled_rider_id]);
      if (rr.rows[0]) {
        await notify(rr.rows[0].user_id, 'Scheduled delivery cancelled',
          'A scheduled delivery you accepted was cancelled by the customer.');
      }
    }
    res.json({ ok: true, refunded });
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
    await db.query('UPDATE orders SET delivery_otp = $1, delivery_otp_hash = $2 WHERE id = $3', [code, hash, order.id]);
    await notify(req.user.id, 'Your delivery OTP', `Share this OTP with your rider to receive the order: ${code}`);
    res.json({ ok: true, message: 'OTP re-sent to your notifications' });
  })
);

// POST /api/orders/:id/rate { food_rating?, delivery_rating?, comment?, photo_url? }
router.post(
  '/:id/rate',
  ah(async (req, res) => {
    const { food_rating, delivery_rating, comment, photo_url } = req.body;
    // Ratings must be whole stars 1-5. Without this, out-of-range values hit
    // the DB CHECK constraint and surface as raw 500s (or a misleading 404
    // for non-numeric input via the 22P02 handler) instead of a clean 400.
    const normRating = (v) => {
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
    };
    const foodRating = normRating(food_rating);
    const deliveryRating = normRating(delivery_rating);
    if (foodRating === undefined || deliveryRating === undefined) {
      return res.status(400).json({ error: 'Ratings must be whole numbers from 1 to 5' });
    }
    // Food photos: client-resized data URLs only, capped to protect the DB.
    let photo = null;
    if (photo_url) {
      if (typeof photo_url !== 'string' || !photo_url.startsWith('data:image/') || photo_url.length > 600000) {
        return res.status(400).json({ error: 'Invalid photo' });
      }
      photo = photo_url;
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
    const existing = await db.query(
      'SELECT id FROM ratings WHERE order_id = $1 AND rater_id = $2',
      [order.id, req.user.id]
    );
    if (existing.rows[0]) return res.status(409).json({ error: 'Order already rated' });

    // Wrap the rating insert + aggregate recalculations in a transaction so
    // a crash can never leave a rating recorded but aggregates stale.
    // Each aggregate is a full recalculation from the ratings table (not an
    // increment), so concurrent raters cannot lose each other's votes — the
    // last commit simply recomputes from all committed rows.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const qx = (text, params) => client.query(text, params);

      await qx(
        `INSERT INTO ratings (order_id, rater_id, ratee_type, ratee_id, food_rating, delivery_rating, comment, photo_url)
         VALUES ($1,$2,'restaurant',$3,$4,$5,$6,$7)`,
        [order.id, req.user.id, order.restaurant_id, foodRating, null, comment || null, photo]
      );
      if (order.rider_id && deliveryRating != null) {
        const rp = await qx('SELECT user_id FROM riders WHERE id = $1', [order.rider_id]);
        await qx(
          `INSERT INTO ratings (order_id, rater_id, ratee_type, ratee_id, food_rating, delivery_rating, comment)
           VALUES ($1,$2,'rider',$3,$4,$5,$6)`,
          [order.id, req.user.id, rp.rows[0].user_id, null, deliveryRating, comment || null]
        );
        await qx(
          `UPDATE riders SET rating_avg = (
             SELECT COALESCE(AVG(delivery_rating), 0) FROM ratings
             WHERE ratee_type = 'rider' AND ratee_id = riders.user_id AND delivery_rating IS NOT NULL
           ) WHERE id = $1`,
          [order.rider_id]
        );
      }
      if (foodRating != null) {
        await qx(
          `UPDATE restaurants SET
             rating_avg = (
               SELECT COALESCE(AVG(food_rating), 0) FROM ratings
               WHERE ratee_type = 'restaurant' AND ratee_id = $1 AND food_rating IS NOT NULL
             ),
             rating_count = (
               SELECT COUNT(*) FROM ratings
               WHERE ratee_type = 'restaurant' AND ratee_id = $1 AND food_rating IS NOT NULL
             )
           WHERE id = $1`,
          [order.restaurant_id]
        );
        // Dish-level ratings: each dish in this order gets one vote at the
        // order's food_rating. Powers "Recommended dishes" (top-rated per restaurant).
        await qx(
          `UPDATE menu_items mi SET
             rating_count = sub.cnt,
             rating_avg = sub.avg
           FROM (
             SELECT oi.menu_item_id AS mid, COUNT(*) AS cnt, AVG(r.food_rating)::numeric AS avg
             FROM ratings r
             JOIN order_items oi ON oi.order_id = r.order_id
             WHERE r.ratee_type = 'restaurant' AND r.food_rating IS NOT NULL
               AND oi.menu_item_id IS NOT NULL
               AND oi.menu_item_id IN (SELECT menu_item_id FROM order_items WHERE order_id = $1)
             GROUP BY oi.menu_item_id
           ) sub
           WHERE mi.id = sub.mid`,
          [order.id]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
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
        tax_paise: order.tax_paise,
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
    const rpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: order.total_paise,
        currency: 'INR',
        receipt: 'mn_' + order.id.slice(0, 24),
        notes: { mana_order_id: order.id }
      })
    });
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
      .digest();
    // Timing-safe compare: never short-circuit on the attacker-controlled value.
    const sigBuf = Buffer.from(String(razorpay_signature), 'hex');
    if (expected.length !== sigBuf.length || !crypto.timingSafeEqual(expected, sigBuf)) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }
    const { rows } = await db.query(
      "SELECT * FROM orders WHERE id = $1 AND customer_id = $2 AND payment_status = 'pending'",
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found or already paid' });
    await db.query("UPDATE orders SET payment_status = 'paid', payment_method = 'razorpay' WHERE id = $1", [order.id]);
    await db.query(
      `UPDATE orders SET timeline = COALESCE(timeline, '[]'::jsonb)
         || jsonb_build_object('status', 'paid', 'at', $1::text, 'by', 'razorpay')
       WHERE id = $2`,
      [new Date().toISOString(), order.id]
    );
    await notify(order.customer_id, 'Payment successful ✅',
      `Rs ${(order.total_paise / 100).toFixed(2)} paid. The kitchen is firing up! 🔥`);
    res.json({ ok: true, payment_status: 'paid' });
  })
);

module.exports = router;
