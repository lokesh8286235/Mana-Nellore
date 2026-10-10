// Customer order lifecycle: place, pay, track, cancel, rate.
// Pricing is computed server-side from pricing_config — clients never send totals.
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authenticate, requireRole, ah } = require('../middleware/auth');
const { haversineKm, loadPricingConfig, computeQuote } = require('../lib/pricing');

const router = express.Router();
router.use(authenticate);

async function notify(userId, title, body) {
  await db.query('INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)', [
    userId, title, body
  ]);
}

async function transition(orderId, status, by) {
  const { rows } = await db.query('SELECT timeline FROM orders WHERE id = $1', [orderId]);
  const timeline = rows[0].timeline || [];
  timeline.push({ status, at: new Date().toISOString(), by });
  await db.query('UPDATE orders SET status = $1, timeline = $2::jsonb WHERE id = $3', [
    status, JSON.stringify(timeline), orderId
  ]);
}

function newDeliveryOtp() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Subtotal for a list of items against a menu lookup, including customization extras.
async function itemsSubtotal(db, menuById, items) {
  let sub = 0;
  for (const it of items) {
    const m = menuById[it.menu_item_id];
    if (!m || !m.available) continue;
    let custExtra = 0;
    if (Array.isArray(it.customizations) && it.customizations.length) {
      const optIds = it.customizations.map((c) => c.option_id).filter(Boolean);
      if (optIds.length) {
        const oRes = await db.query(
          `SELECT o.id, o.price_paise FROM customization_options o
           JOIN customization_groups g ON g.id = o.group_id
           WHERE o.id = ANY($1) AND g.menu_item_id = $2`,
          [optIds, m.id]
        );
        for (const o of oRes.rows) custExtra += Number(o.price_paise) || 0;
      }
    }
    sub += (m.price_paise + custExtra) * (Number(it.qty) || 1);
  }
  return sub;
}

// POST /api/orders/quote { restaurant_id, address_id?, items, coupon_code?, order_type?, table_id?, tip_paise? }
// Read-only bill preview: returns the exact fee breakdown the customer will
// pay, computed with the same pricing engine as order placement. No order created.
router.post(
  '/quote',
  ah(async (req, res) => {
    const { restaurant_id, address_id, items, coupon_code, order_type, table_id, tip_paise } = req.body;
    const dineIn = order_type === 'dinein';
    if (!restaurant_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'restaurant_id and items are required' });
    }
    if (!dineIn && !address_id) {
      return res.status(400).json({ error: 'address_id is required for delivery orders' });
    }
    const rRes = await db.query(
      "SELECT id, lat, lng, commission_pct FROM restaurants WHERE id = $1 AND status = 'approved'",
      [restaurant_id]
    );
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

    const ids = items.map((i) => i.menu_item_id);
    const mRes = await db.query(
      'SELECT id, price_paise, available FROM menu_items WHERE id = ANY($1) AND restaurant_id = $2',
      [ids, restaurant_id]
    );
    const menuById = Object.fromEntries(mRes.rows.map((m) => [m.id, m]));
    const subtotal = await itemsSubtotal(db, menuById, items);

    // Coupon
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
    const config = await loadPricingConfig(db);
    const tipPaise = Math.max(0, Math.round(Number(tip_paise) || 0));
    const quote = computeQuote({
      config,
      distanceKm: dineIn ? 0 : distanceKm,
      subtotalPaise: subtotal,
      discountPaise: discount,
      commissionPct: restaurant.commission_pct
    });

    // Multi-restaurant on-the-way quote: group items by restaurant_id (item-level),
    // primary = cart.restaurant_id (100% fee), others = 20% of their own normal fee.
    let groupsOut = null;
    if (!dineIn) {
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
          "SELECT id, lat, lng, commission_pct FROM restaurants WHERE id = ANY($1) AND status = 'approved'",
          [ordered]
        );
        const rMap = Object.fromEntries(rAll.rows.map((r) => [String(r.id), r]));
        groupsOut = [];
        for (let gi = 0; gi < ordered.length; gi++) {
          const rid = ordered[gi];
          const rr = rMap[rid];
          if (!rr) continue;
          const gItems = byRest[rid];
          const gIds = gItems.map((i) => i.menu_item_id);
          const gmRes = await db.query(
            'SELECT id, price_paise, available FROM menu_items WHERE id = ANY($1) AND restaurant_id = $2',
            [gIds, rid]
          );
          const gmById = Object.fromEntries(gmRes.rows.map((m) => [m.id, m]));
          const gSub = await itemsSubtotal(db, gmById, gItems);
          let gDist = null;
          if (rr.lat != null && rr.lng != null && address.lat != null && address.lng != null) {
            gDist = haversineKm(Number(rr.lat), Number(rr.lng), Number(address.lat), Number(address.lng));
          }
          const gQuote = computeQuote({
            config,
            distanceKm: gDist,
            subtotalPaise: gSub,
            discountPaise: gi === 0 ? discount : 0,
            commissionPct: rr.commission_pct
          });
          const isPrim = gi === 0;
          groupsOut.push({
            restaurant_id: rid,
            is_primary: isPrim,
            subtotal_paise: gSub,
            normal_fee_paise: gQuote.deliveryFeePaise,
            delivery_fee_paise: isPrim ? gQuote.deliveryFeePaise : Math.round(gQuote.deliveryFeePaise * 0.2),
            platform_fee_paise: isPrim ? gQuote.platformFeePaise : 0
          });
        }
      }
    }

    const billDelivery = dineIn ? 0 : quote.deliveryFeePaise;
    const billPlatform = quote.platformFeePaise;
    // When groups exist, the bill sums across ALL groups (not just the primary)
    let billSubtotal = subtotal, totalDelivery = billDelivery, totalPlatform = billPlatform;
    if (groupsOut) {
      billSubtotal = groupsOut.reduce((s, g) => s + g.subtotal_paise, 0);
      totalDelivery = groupsOut.reduce((s, g) => s + g.delivery_fee_paise, 0);
      totalPlatform = groupsOut.reduce((s, g) => s + g.platform_fee_paise, 0);
    }

    res.json({
      bill: {
        subtotal_paise: billSubtotal,
        discount_paise: discount,
        delivery_fee_paise: dineIn ? 0 : totalDelivery,
        platform_fee_paise: totalPlatform,
        tax_paise: quote.taxPaise,
        tip_paise: tipPaise,
        total_paise: (dineIn ? 0 : totalDelivery) + totalPlatform + tipPaise + (billSubtotal - discount)
      },
      groups: groupsOut,
      coupon_error: couponError,
      eta_minutes: Number(config.etaMinutes) || 30
    });
  })
);

// POST /api/orders { restaurant_id, address_id?, order_type?, table_id?, items:[{menu_item_id, qty, instructions, customizations}], coupon_code?, payment_method?, delivery_note?, no_cutlery?, tip_paise?, recipient_name?, recipient_phone? }

// POST /api/orders with groups[] — on-the-way multi-restaurant checkout.
// groups[0] = primary (100% of its own normal delivery fee + platform fee).
// groups[1..] = secondaries (20% of their OWN normal delivery fee each, platform fee 0).
// Off-route secondaries are REMOVED (never repriced) and reported in removed_off_route.
async function placeMultiGroupOrder(req, res) {
  const { groups, address_id, coupon_code, payment_method,
          delivery_note, no_cutlery, tip_paise,
          recipient_name, recipient_phone } = req.body;
  const OFF_ROUTE_MSG = "You entered a new address, so the cart restaurants are not on the way and can't be delivered.";

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Address (delivery only — groups path never handles dine-in)
    const aRes = await client.query(
      'SELECT * FROM addresses WHERE id = $1 AND user_id = $2',
      [address_id, req.user.id]
    );
    const address = aRes.rows[0];
    if (!address) throw { status: 400, message: 'Delivery address not found' };

    // Validate + load all restaurants
    const restIds = groups.map((g) => g.restaurant_id).filter(Boolean);
    if (!restIds.length) throw { status: 400, message: 'groups with restaurant_id are required' };
    const rRes = await client.query(
      "SELECT * FROM restaurants WHERE id = ANY($1) AND status = 'approved'",
      [restIds]
    );
    const restById = Object.fromEntries(rRes.rows.map((r) => [String(r.id), r]));
    const primary = restById[String(groups[0].restaurant_id)];
    if (!primary) throw { status: 404, message: 'Primary restaurant not available' };
    if (!primary.is_open) throw { status: 400, message: 'Primary restaurant is currently closed' };

    // Route validation: secondary must be within 1km of segment primary->address
    const removed_off_route = [];
    const validGroups = [groups[0]];
    for (let i = 1; i < groups.length; i++) {
      const g = groups[i];
      const r = restById[String(g.restaurant_id)];
      if (!r || !r.is_open) {
        removed_off_route.push({ restaurant_id: g.restaurant_id, name: (r && r.name) || 'Restaurant', reason: 'unavailable' });
        continue;
      }
      let onRoute = true;
      if (primary.lat != null && primary.lng != null && address.lat != null && address.lng != null &&
          r.lat != null && r.lng != null) {
        const d = otwPointToSegKm(Number(r.lng), Number(r.lat),
          Number(primary.lng), Number(primary.lat),
          Number(address.lng), Number(address.lat));
        onRoute = d <= 1.0;
      }
      if (!onRoute) {
        removed_off_route.push({ restaurant_id: g.restaurant_id, name: r.name, reason: 'off_route' });
      } else {
        validGroups.push(g);
      }
    }

    const config = await loadPricingConfig(client);
    const orders = [];

    for (let gi = 0; gi < validGroups.length; gi++) {
      const g = validGroups[gi];
      const isPrimary = gi === 0;
      const restaurant = restById[String(g.restaurant_id)];
      const items = Array.isArray(g.items) ? g.items : [];
      if (!items.length) continue;

      // Menu validation + subtotal
      const ids = items.map((it) => it.menu_item_id);
      const mRes = await client.query(
        'SELECT id, name, price_paise, available FROM menu_items WHERE id = ANY($1) AND restaurant_id = $2',
        [ids, restaurant.id]
      );
      const menuById = Object.fromEntries(mRes.rows.map((m) => [m.id, m]));
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
          const optIds = it.customizations.map((c) => c.option_id).filter(Boolean);
          if (optIds.length) {
            const oRes = await client.query(
              `SELECT o.id, o.name, o.price_paise FROM customization_options o
               JOIN customization_groups gg ON gg.id = o.group_id
               WHERE o.id = ANY($1) AND gg.menu_item_id = $2`,
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
          instructions: it.instructions || null
        });
      }

      // Coupon only on primary
      let discount = 0;
      if (isPrimary && coupon_code) {
        const cRes = await client.query('SELECT * FROM coupons WHERE code = $1 AND active = true',
          [String(coupon_code).toUpperCase()]);
        const coupon = cRes.rows[0];
        const now = new Date();
        if (coupon && !(coupon.valid_from && new Date(coupon.valid_from) > now) &&
            !(coupon.valid_to && new Date(coupon.valid_to) < now) &&
            subtotal >= coupon.min_order_paise) {
          let studentOk = true;
          if (coupon.requires_student) {
            const uRes = await client.query('SELECT is_student FROM users WHERE id = $1', [req.user.id]);
            studentOk = !!(uRes.rows[0] && uRes.rows[0].is_student);
          }
          if (studentOk) {
            discount = coupon.discount_type === 'flat' ? coupon.value : Math.round((subtotal * coupon.value) / 100);
            if (coupon.max_discount_paise != null) discount = Math.min(discount, coupon.max_discount_paise);
            discount = Math.min(discount, subtotal);
          }
        }
      }

      // Fees: primary = 100% of its own normal fee; secondary = 20% of its OWN normal fee, platform 0
      let distanceKm = null;
      if (restaurant.lat != null && restaurant.lng != null && address.lat != null && address.lng != null) {
        distanceKm = haversineKm(Number(restaurant.lat), Number(restaurant.lng), Number(address.lat), Number(address.lng));
      }
      const quote = computeQuote({
        config,
        distanceKm,
        subtotalPaise: subtotal,
        discountPaise: discount,
        commissionPct: restaurant.commission_pct
      });
      const normalFee = quote.deliveryFeePaise;
      const deliveryFee = isPrimary ? normalFee : Math.round(normalFee * 0.2);
      const platformFee = isPrimary ? quote.platformFeePaise : 0;
      const tipPaise = isPrimary ? Math.max(0, Math.round(Number(tip_paise) || 0)) : 0;
      const finalTotal = (subtotal - discount) + deliveryFee + platformFee + tipPaise;

      const timeline = [{ status: 'placed', at: new Date().toISOString(), by: 'customer' }];
      const etaMinutes = Number(config.etaMinutes) || 30;
      const shareToken = require('crypto').randomBytes(6).toString('hex');

      const oRes = await client.query(
        `INSERT INTO orders
           (customer_id, restaurant_id, address_id, status, order_type,
            subtotal_paise, discount_paise, delivery_fee_paise, platform_fee_paise,
            tax_paise, commission_paise, total_paise, tip_paise,
            delivery_note, no_cutlery, recipient_name, recipient_phone,
            payment_method, payment_status, timeline, eta_at, share_token)
         VALUES ($1,$2,$3,'placed','delivery',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending',$17::jsonb,
                 now() + ($18 || ' minutes')::interval, $19)
         RETURNING *`,
        [req.user.id, restaurant.id, address_id,
         subtotal, discount, deliveryFee, platformFee,
         quote.taxPaise, quote.commissionPaise, finalTotal, tipPaise,
         delivery_note || null, !!no_cutlery, recipient_name || null, recipient_phone || null,
         payment_method || 'upi', JSON.stringify(timeline), String(etaMinutes), shareToken]
      );
      const order = oRes.rows[0];
      for (const s of snapshots) {
        await client.query(
          `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, unit_price_paise, qty, instructions)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [order.id, s.menu_item_id, s.name_snapshot, s.unit_price_paise, s.qty, s.instructions]
        );
      }
      orders.push({
        order: { ...order, items: snapshots },
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
          `Delivery order worth Rs ${(finalTotal / 100).toFixed(2)} — the kitchen needs you! 👨‍🍳`);
      }
    }

    // Link the sub-orders as ONE delivery group (the "on the way" trip).
    // Only when 2+ orders were actually created — a lone survivor stays a
    // normal single order and all single-order flows are untouched.
    let deliveryGroupId = null;
    if (orders.length >= 2) {
      // Pickup order: farthest-from-customer first (the product rule; the
      // rider's next-stop uses this same sequence as the source of truth).
      const withDist = orders.map((o) => {
        const rest = restById[String(o.order.restaurant_id)];
        let km = null;
        if (rest && rest.lat != null && rest.lng != null &&
            address.lat != null && address.lng != null) {
          km = haversineKm(Number(rest.lat), Number(rest.lng),
                            Number(address.lat), Number(address.lng));
        }
        return { id: o.order.id, km, placed_at: o.order.placed_at };
      });
      withDist.sort((a, b) => {
        if (a.km != null && b.km != null) return b.km - a.km; // farthest first
        if (a.km != null) return -1;
        if (b.km != null) return 1;
        return new Date(a.placed_at) - new Date(b.placed_at); // oldest first
      });
      const pickupOrderIds = withDist.map((w) => w.id);
      const feeBreakdown = orders.map((o) => ({
        order_id: o.order.id,
        restaurant_id: o.order.restaurant_id,
        is_primary: o.is_primary,
        normal_fee_paise: o.normal_fee_paise,
        delivery_fee_paise: o.delivery_fee_paise,
        platform_fee_paise: o.platform_fee_paise
      }));
      const gRes = await client.query(
        `INSERT INTO delivery_groups
           (customer_id, address_id, primary_order_id, order_ids, pickup_order_ids, fee_breakdown)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING id`,
        [req.user.id, address_id, orders[0].order.id,
         orders.map((o) => o.order.id), pickupOrderIds, JSON.stringify(feeBreakdown)]
      );
      deliveryGroupId = gRes.rows[0].id;
      await client.query('UPDATE orders SET delivery_group_id = $1 WHERE id = ANY($2)',
        [deliveryGroupId, orders.map((o) => o.order.id)]);
      for (const o of orders) o.delivery_group_id = deliveryGroupId;
    }

    await client.query('COMMIT');
    await notify(req.user.id, 'Order placed ✅', 'Your restaurants got the orders and kitchens are firing up! 🔥');

    res.status(201).json({
      delivery_group_id: deliveryGroupId,
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

// ---- On-the-way helpers ----
function otwPointToSegKm(px, py, ax, ay, bx, by) {
  // Equirectangular km projection around mean lat
  const meanLat = ((ay + by) / 2) * Math.PI / 180;
  const kx = 111.32 * Math.cos(meanLat), ky = 110.57;
  const Ax = ax * kx, Ay = ay * ky, Bx = bx * kx, By = by * ky;
  const Px = px * kx, Py = py * ky;
  const dx = Bx - Ax, dy = By - Ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(Px - Ax, Py - Ay);
  const t = Math.max(0, Math.min(1, ((Px - Ax) * dx + (Py - Ay) * dy) / len2));
  return Math.hypot(Px - (Ax + t * dx), Py - (Ay + t * dy));
}

router.post(
  '/',
  ah(async (req, res) => {
    const { restaurant_id, address_id, items, coupon_code, payment_method,
            order_type, table_id, delivery_note, no_cutlery, tip_paise,
            recipient_name, recipient_phone, groups } = req.body;
    // Multi-restaurant on-the-way checkout: groups[0] = primary, rest = secondaries.
    if (Array.isArray(groups) && groups.length > 1 && order_type !== 'dinein') {
      return await placeMultiGroupOrder(req, res);
    }
    const dineIn = order_type === 'dinein';
    if (!restaurant_id || !Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'restaurant_id and items are required' });
    }
    if (!dineIn && !address_id) {
      return res.status(400).json({ error: 'address_id is required for delivery orders' });
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');

      const rRes = await client.query(
        "SELECT * FROM restaurants WHERE id = $1 AND status = 'approved'",
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
      } else {
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

      let subtotal = 0;
      const snapshots = [];
      for (const it of items) {
        const m = menuById[it.menu_item_id];
        const qty = Number(it.qty);
        if (!m) throw { status: 400, message: 'A menu item is not from this restaurant' };
        if (!m.available) throw { status: 400, message: `"${m.name}" is currently unavailable` };
        if (!Number.isInteger(qty) || qty <= 0) throw { status: 400, message: 'Quantity must be a positive integer' };
        // Customization price additions
        let custExtra = 0;
        let custNames = [];
        if (Array.isArray(it.customizations) && it.customizations.length) {
          const optIds = it.customizations.map((c) => c.option_id).filter(Boolean);
          if (optIds.length) {
            const oRes = await client.query(
              `SELECT o.id, o.name, o.price_paise FROM customization_options o
               JOIN customization_groups g ON g.id = o.group_id
               WHERE o.id = ANY($1) AND g.menu_item_id = $2`,
              [optIds, m.id]
            );
            for (const o of oRes.rows) {
              custExtra += Number(o.price_paise) || 0;
              custNames.push(o.name);
            }
          }
        }
        subtotal += (m.price_paise + custExtra) * qty;
        snapshots.push({
          menu_item_id: m.id,
          name_snapshot: m.name + (custNames.length ? ' (' + custNames.join(', ') + ')' : ''),
          unit_price_paise: m.price_paise + custExtra,
          qty,
          instructions: it.instructions || null
        });
      }

      // Coupon
      let discount = 0;
      let couponId = null;
      if (coupon_code) {
        const cRes = await client.query(
          'SELECT * FROM coupons WHERE code = $1 AND active = true',
          [String(coupon_code).toUpperCase()]
        );
        const coupon = cRes.rows[0];
        const now = new Date();
        if (!coupon) throw { status: 400, message: 'Invalid coupon code' };
        if (coupon.valid_from && new Date(coupon.valid_from) > now) throw { status: 400, message: 'Coupon not yet valid' };
        if (coupon.valid_to && new Date(coupon.valid_to) < now) throw { status: 400, message: 'Coupon expired' };
        if (subtotal < coupon.min_order_paise) {
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
            : Math.round((subtotal * coupon.value) / 100);
        if (coupon.max_discount_paise != null) discount = Math.min(discount, coupon.max_discount_paise);
        discount = Math.min(discount, subtotal);
        couponId = coupon.id;
      }

      // Distance + quote
      let distanceKm = null;
      if (!dineIn && restaurant.lat != null && restaurant.lng != null && address.lat != null && address.lng != null) {
        distanceKm = haversineKm(restaurant.lat, restaurant.lng, address.lat, address.lng);
      }
      const config = await loadPricingConfig(client);
      const tipPaise = Math.max(0, Math.round(Number(tip_paise) || 0));
      const quote = computeQuote({
        config,
        distanceKm: dineIn ? 0 : distanceKm,
        subtotalPaise: subtotal,
        discountPaise: discount,
        commissionPct: restaurant.commission_pct
      });
      const deliveryFee = dineIn ? 0 : quote.deliveryFeePaise;
      const finalTotal = (subtotal - discount) + deliveryFee + quote.platformFeePaise + tipPaise;

      const timeline = [{ status: 'placed', at: new Date().toISOString(), by: 'customer' }];
      const etaMinutes = Number(config.etaMinutes) || 30;
      const shareToken = require('crypto').randomBytes(6).toString('hex');

      const oRes = await client.query(
        `INSERT INTO orders
           (customer_id, restaurant_id, address_id, status, order_type, table_id,
            subtotal_paise, discount_paise, delivery_fee_paise, platform_fee_paise,
            tax_paise, commission_paise, total_paise, tip_paise,
            delivery_note, no_cutlery, recipient_name, recipient_phone,
            payment_method, payment_status, timeline, eta_at, share_token)
         VALUES ($1,$2,$3,'placed',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'pending',$19::jsonb,
                 now() + ($20 || ' minutes')::interval, $21)
         RETURNING *`,
        [req.user.id, restaurant_id, dineIn ? null : address_id, dineIn ? 'dinein' : 'delivery',
         dineIn ? table_id : null,
         subtotal, discount, deliveryFee, quote.platformFeePaise,
         quote.taxPaise, quote.commissionPaise, finalTotal, tipPaise,
         delivery_note || null, !!no_cutlery, recipient_name || null, recipient_phone || null,
         payment_method || 'upi', JSON.stringify(timeline), String(etaMinutes), shareToken]
      );
      const order = oRes.rows[0];

      for (const s of snapshots) {
        await client.query(
          `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, unit_price_paise, qty, instructions)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [order.id, s.menu_item_id, s.name_snapshot, s.unit_price_paise, s.qty, s.instructions]
        );
      }
      await client.query('COMMIT');

      const ownerRes = await db.query('SELECT owner_id FROM restaurants WHERE id = $1', [restaurant_id]);
      if (ownerRes.rows[0] && ownerRes.rows[0].owner_id) {
        await notify(ownerRes.rows[0].owner_id, '🔔 New order!',
          `${dineIn ? 'Dine-in table order' : 'Delivery order'} worth Rs ${(order.total_paise / 100).toFixed(2)} — the kitchen needs you! 👨‍🍳`);
      }
      await notify(req.user.id, 'Order placed ✅',
        `${restaurant.name} got your order and the kitchen is firing up! 🔥`);

      res.status(201).json({
        order: { ...order, items: snapshots },
        breakdown: {
          subtotal_paise: subtotal,
          discount_paise: discount,
          delivery_fee_paise: deliveryFee,
          platform_fee_paise: quote.platformFeePaise,
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
    const timeline = order.timeline || [];
    timeline.push({ status: 'paid', at: new Date().toISOString(), by: 'customer' });
    await db.query('UPDATE orders SET timeline = $1::jsonb WHERE id = $2', [
      JSON.stringify(timeline), order.id
    ]);
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
    for (const o of rows) { delete o.pickup_photo; delete o.pickup_otp; } // never expose to customers
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
              a.line1, a.line2, a.city,
              ru.name AS rider_name, ru.phone AS rider_phone,
              rd.profile_photo AS rider_photo, rd.rating_avg AS rider_rating,
              (SELECT COUNT(*) FROM orders od
               WHERE od.rider_id = rd.id AND od.status = 'delivered') AS rider_deliveries
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
    delete order.delivery_otp_hash; // never expose to clients
    delete order.pickup_photo; // no photos anywhere in the customer flow
    delete order.pickup_otp; // never expose to clients
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
    res.json({ order: { ...order, items: items.rows, queue_ahead: queueAhead, no_response: noResponse, stops } });
  })
);

// POST /api/orders/:id/cancel { reason } — only before the restaurant accepts
router.post(
  '/:id/cancel',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'placed') {
      return res.status(409).json({ error: 'Order can no longer be cancelled' });
    }
    await transition(order.id, 'cancelled', 'customer');
    const refunded = order.payment_status === 'paid';
    await db.query(
      'UPDATE orders SET cancel_reason = $1, payment_status = $2 WHERE id = $3',
      [req.body.reason || 'Cancelled by customer', refunded ? 'refunded' : order.payment_status, order.id]
    );
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
    await db.query('UPDATE orders SET delivery_otp_hash = $1 WHERE id = $2', [hash, order.id]);
    // Grouped trip: the OTP is shared — re-issuing updates the group and
    // mirrors to every sub-order so the rider's complete check keeps working.
    if (order.delivery_group_id) {
      await db.query('UPDATE delivery_groups SET delivery_otp_hash = $1 WHERE id = $2',
        [hash, order.delivery_group_id]);
      await db.query('UPDATE orders SET delivery_otp_hash = $1 WHERE delivery_group_id = $2',
        [hash, order.delivery_group_id]);
    }
    await notify(req.user.id, 'Your delivery OTP', `Share this OTP with your rider to receive the order: ${code}`);
    res.json({ ok: true, message: 'OTP re-sent to your notifications' });
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

    await db.query(
      `INSERT INTO ratings (order_id, rater_id, ratee_type, ratee_id, food_rating, delivery_rating, comment, photo_url)
       VALUES ($1,$2,'restaurant',$3,$4,$5,$6,$7)`,
      [order.id, req.user.id, order.restaurant_id, food_rating || null, null, comment || null, photo]
    );
    if (order.rider_id && delivery_rating) {
      const rp = await db.query('SELECT user_id FROM riders WHERE id = $1', [order.rider_id]);
      await db.query(
        `INSERT INTO ratings (order_id, rater_id, ratee_type, ratee_id, food_rating, delivery_rating, comment)
         VALUES ($1,$2,'rider',$3,$4,$5,$6)`,
        [order.id, req.user.id, rp.rows[0].user_id, null, delivery_rating, comment || null]
      );
      await db.query(
        `UPDATE riders SET rating_avg = (
           SELECT COALESCE(AVG(delivery_rating), 0) FROM ratings
           WHERE ratee_type = 'rider' AND ratee_id = riders.user_id AND delivery_rating IS NOT NULL
         ) WHERE id = $1`,
        [order.rider_id]
      );
    }
    if (food_rating) {
      await db.query(
        `UPDATE restaurants SET rating_avg = (
           SELECT COALESCE(AVG(food_rating), 0) FROM ratings
           WHERE ratee_type = 'restaurant' AND ratee_id = $1 AND food_rating IS NOT NULL
         ) WHERE id = $1`,
        [order.restaurant_id]
      );
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
