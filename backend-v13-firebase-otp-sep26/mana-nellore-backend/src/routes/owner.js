// Restaurant owner portal. Every query is scoped to the owner's own
// restaurant — an owner can never see or touch another restaurant's data.
const express = require('express');
const db = require('../db');
const { storeImageUrl } = require('../lib/images');
const { activateDueScheduledOrders } = require('../lib/scheduled');
const { authenticate, requireRole, ah } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireRole('restaurant_owner'));

async function ownRestaurantId(userId) {
  // Newest first: an owner test account can hold placeholder restaurants; the live one wins.
  const { rows } = await db.query('SELECT id FROM restaurants WHERE owner_id = $1 ORDER BY created_at DESC', [userId]);
  return rows[0] ? rows[0].id : null;
}

async function requireRestaurant(req, res) {
  const id = await ownRestaurantId(req.user.id);
  if (!id) {
    res.status(404).json({ error: 'No restaurant registered for this account yet' });
    return null;
  }
  return id;
}

/* Meal slots are multi-select: accepts a string or an array, returns a deduped array.
   Empty selection, ['all'], or anything invalid -> ['all'] (visible in every meal tab). */
function normSlots(v) {
  const arr = Array.isArray(v) ? v : (v == null ? [] : [v]);
  const ok = [];
  for (const s of arr) {
    const t = String(s || '').toLowerCase().trim();
    if (['breakfast', 'lunch', 'dinner'].includes(t) && !ok.includes(t)) ok.push(t);
  }
  return ok.length ? ok : ['all'];
}

async function notify(dbConn, userId, title, body, data) {
  await dbConn.query('INSERT INTO notifications (user_id, title, body, data) VALUES ($1, $2, $3, $4)', [
    userId, title, body, data ? JSON.stringify(data) : null
  ]);
}

async function transition(orderId, status, by) {
  // Single UPDATE with a jsonb append: concurrent transitions can no longer
  // silently drop each other's timeline entries (read-modify-write race).
  // "Packed fresh" stamp: the moment the kitchen taps Ready for pickup
  const packed = status === 'ready' ? ', packed_at = now()' : '';
  await db.query(
    `UPDATE orders SET status = $1,
       timeline = COALESCE(timeline, '[]'::jsonb)
                || jsonb_build_object('status', $1::text, 'at', $2::text, 'by', $3::text)${packed}
     WHERE id = $4`,
    [status, new Date().toISOString(), by, orderId]
  );
}

// ---- Restaurant profile ----

const { seedSuggestedCats } = require('../lib/suggested-cats');

// POST /api/owner/restaurant — register (one restaurant per owner)
router.post(
  '/restaurant',
  ah(async (req, res) => {
    const existing = await ownRestaurantId(req.user.id);
    if (existing) return res.status(409).json({ error: 'Restaurant already registered' });
    const { name, description, address, lat, lng, phone, image_url, fssai, opens_at, closes_at, opens_at_we, closes_at_we } = req.body;
    if (!name) return res.status(400).json({ error: 'Restaurant name is required' });
    const { rows } = await db.query(
      `INSERT INTO restaurants
         (owner_id, name, description, address, lat, lng, phone, image_url, fssai, opens_at, closes_at, opens_at_we, closes_at_we)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [req.user.id, name, description || null, address || null, lat || null, lng || null,
       phone || null, await storeImageUrl(db, image_url), fssai || null, opens_at || null, closes_at || null,
       opens_at_we || null, closes_at_we || null]
    );
    await seedSuggestedCats(db, rows[0].id);
    res.status(201).json({ restaurant: rows[0] });
  })
);

// GET /api/owner/restaurant
router.get(
  '/restaurant',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { rows } = await db.query('SELECT * FROM restaurants WHERE id = $1', [id]);
    res.json({ restaurant: rows[0] });
  })
);

// PUT /api/owner/restaurant
router.put(
  '/restaurant',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const fields = ['name', 'description', 'address', 'lat', 'lng', 'phone', 'image_url', 'fssai',
      'chef_name', 'chef_photo', 'chef_story', 'gstin', 'birthday_dessert',
      'cuisines', 'is_pure_veg',
      'opens_at', 'closes_at', 'opens_at_we', 'closes_at_we'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        let v = req.body[f];
        if (f === 'image_url' || f === 'chef_photo') v = await storeImageUrl(db, v);
        params.push(v);
        sets.push(`${f} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(id);
    const { rows } = await db.query(
      `UPDATE restaurants SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    res.json({ restaurant: rows[0] });
  })
);

// PUT /api/owner/hours { opens_at, closes_at, opens_at_we, closes_at_we }
router.put(
  '/hours',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { opens_at, closes_at, opens_at_we, closes_at_we } = req.body;
    const { rows } = await db.query(
      'UPDATE restaurants SET opens_at = $1, closes_at = $2, opens_at_we = $3, closes_at_we = $4 WHERE id = $5 RETURNING *',
      [opens_at || null, closes_at || null, opens_at_we || null, closes_at_we || null, id]
    );
    res.json({ restaurant: rows[0] });
  })
);

// PUT /api/owner/open { is_open, force? }
// Closing stops NEW orders only — active orders must still be fulfilled.
// If active orders exist and the kitchen tries to close, we refuse (409) with
// the count unless force=true, so the app can show the confirm warning.
router.put(
  '/open',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const wantOpen = !!req.body.is_open;
    if (!wantOpen && !req.body.force) {
      const active = await db.query(
        `SELECT COUNT(*) AS n FROM orders
         WHERE restaurant_id = $1 AND status IN ('placed','accepted','preparing','ready','picked_up','on_way')`,
        [id]
      );
      const n = Number(active.rows[0].n);
      if (n > 0) {
        return res.status(409).json({
          error: 'active_orders',
          active_orders: n,
          message: `You have ${n} active order${n > 1 ? 's' : ''} — they still need to be fulfilled.`
        });
      }
    }
    const was = await db.query('SELECT is_open FROM restaurants WHERE id = $1', [id]);
    const { rows } = await db.query(
      'UPDATE restaurants SET is_open = $1 WHERE id = $2 RETURNING *',
      [wantOpen, id]
    );
    // Reopening pings everyone waiting on "notify me when open"
    if (wantOpen && was.rows[0] && !was.rows[0].is_open) {
      const subs = await db.query(
        'SELECT user_id FROM restaurant_open_alerts WHERE restaurant_id = $1', [id]
      );
      for (const sub of subs.rows) {
        await notify(db, sub.user_id, `🔔 ${rows[0].name} is OPEN now!`,
          'Your favorites are waiting — order before the rush! 🍽️');
      }
      await db.query('DELETE FROM restaurant_open_alerts WHERE restaurant_id = $1', [id]);
    }
    res.json({ restaurant: rows[0] });
  })
);

// ---- Menu: categories ----
router.get(
  '/menu/categories',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { rows } = await db.query(
      'SELECT * FROM categories WHERE restaurant_id = $1 ORDER BY sort_order, name', [id]
    );
    res.json({ categories: rows });
  })
);

router.post(
  '/menu/categories',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { name, sort_order } = req.body;
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    const { rows } = await db.query(
      'INSERT INTO categories (restaurant_id, name, sort_order) VALUES ($1, $2, $3) RETURNING *',
      [id, name, sort_order || 0]
    );
    res.status(201).json({ category: rows[0] });
  })
);

router.put(
  '/menu/categories/:catId',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { name, sort_order } = req.body;
    const { rows } = await db.query(
      `UPDATE categories SET name = COALESCE($1, name), sort_order = COALESCE($2, sort_order)
       WHERE id = $3 AND restaurant_id = $4 RETURNING *`,
      [name || null, sort_order != null ? sort_order : null, req.params.catId, id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Category not found' });
    res.json({ category: rows[0] });
  })
);

router.delete(
  '/menu/categories/:catId',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    await db.query('DELETE FROM categories WHERE id = $1 AND restaurant_id = $2', [
      req.params.catId, id
    ]);
    res.json({ ok: true });
  })
);

// ---- Menu: items ----
router.get(
  '/menu/items',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { rows } = await db.query(
      'SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY sort_order, name', [id]
    );
    res.json({ items: rows });
  })
);

router.post(
  '/menu/items',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { category_id, name, description, image_url, price_paise, veg, available, prep_minutes, sort_order,
      meal_slot, is_combo, allergens } = req.body;
    if (!name || price_paise == null) {
      return res.status(400).json({ error: 'Name and price_paise are required' });
    }
    // Guard against NaN ("abc" -> 22P02 -> misleading 404) and negative prices
    // (a negative-priced item would shrink the customer's bill at checkout).
    const pricePaise = Math.round(Number(price_paise));
    if (!Number.isFinite(pricePaise) || pricePaise < 0) {
      return res.status(400).json({ error: 'price_paise must be a non-negative number' });
    }
    if (category_id) {
      const c = await db.query('SELECT id FROM categories WHERE id = $1 AND restaurant_id = $2', [
        category_id, id
      ]);
      if (!c.rows[0]) return res.status(400).json({ error: 'Category does not belong to this restaurant' });
    }
    const { rows } = await db.query(
      `INSERT INTO menu_items
         (restaurant_id, category_id, name, description, image_url, price_paise, veg, available, prep_minutes, sort_order,
          meal_slot, is_combo, allergens)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING *`,
      [id, category_id || null, name, description || null, await storeImageUrl(db, image_url),
       pricePaise, !!veg, available !== false,
       prep_minutes || 20, sort_order || 0,
       normSlots(meal_slot),
       !!is_combo, JSON.stringify(Array.isArray(allergens) ? allergens : [])]
    );
    res.status(201).json({ item: rows[0] });
  })
);

router.put(
  '/menu/items/:itemId',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const fields = ['category_id', 'name', 'description', 'image_url', 'price_paise', 'veg', 'available', 'prep_minutes', 'sort_order',
      'meal_slot', 'is_combo', 'allergens'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        let v = req.body[f];
        if (f === 'price_paise') {
          v = Math.round(Number(v));
          if (!Number.isFinite(v) || v < 0) {
            const err = new Error('price_paise must be a non-negative number');
            err.status = 400;
            throw err;
          }
        }
        if (f === 'meal_slot') v = normSlots(v);
        if (f === 'image_url') v = await storeImageUrl(db, v);
        params.push(v);
        sets.push(`${f} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    if (req.body.category_id) {
      const c = await db.query('SELECT id FROM categories WHERE id = $1 AND restaurant_id = $2', [
        req.body.category_id, id
      ]);
      if (!c.rows[0]) return res.status(400).json({ error: 'Category does not belong to this restaurant' });
    }
    params.push(req.params.itemId, id);
    const { rows } = await db.query(
      `UPDATE menu_items SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND restaurant_id = $${params.length} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Item not found' });
    res.json({ item: rows[0] });
  })
);

router.delete(
  '/menu/items/:itemId',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    await db.query('DELETE FROM menu_items WHERE id = $1 AND restaurant_id = $2', [
      req.params.itemId, id
    ]);
    res.json({ ok: true });
  })
);

// ---- Item customizations ----
router.get(
  '/menu/items/:itemId/customizations',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const groups = await db.query(
      `SELECT g.* FROM customization_groups g JOIN menu_items mi ON mi.id = g.menu_item_id
       WHERE g.menu_item_id = $1 AND mi.restaurant_id = $2 ORDER BY g.sort, g.name`,
      [req.params.itemId, id]
    );
    for (const g of groups.rows) {
      const opts = await db.query(
        'SELECT * FROM customization_options WHERE group_id = $1 ORDER BY sort, name',
        [g.id]
      );
      g.options = opts.rows;
    }
    res.json({ groups: groups.rows });
  })
);
router.post(
  '/menu/items/:itemId/customizations',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { name, required, max_select, options } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const chk = await db.query('SELECT id FROM menu_items WHERE id = $1 AND restaurant_id = $2', [req.params.itemId, id]);
    if (!chk.rows[0]) return res.status(404).json({ error: 'Item not found' });
    const g = await db.query(
      `INSERT INTO customization_groups (menu_item_id, name, required, max_select)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.itemId, name, !!required, max_select || 1]
    );
    const group = g.rows[0];
    if (Array.isArray(options)) {
      for (let i = 0; i < options.length; i++) {
        const o = options[i];
        await db.query(
          `INSERT INTO customization_options (group_id, name, price_paise, sort)
           VALUES ($1, $2, $3, $4)`,
          [group.id, o.name, o.price_paise || 0, i]
        );
      }
    }
    res.json({ group });
  })
);
router.delete(
  '/menu/customizations/:groupId',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    await db.query(
      `DELETE FROM customization_groups g USING menu_items mi
       WHERE g.id = $1 AND g.menu_item_id = mi.id AND mi.restaurant_id = $2`,
      [req.params.groupId, id]
    );
    res.json({ ok: true });
  })
);

// ---- Orders ----
function orderDetailQuery(where, params) {
  return db.query(
    `SELECT o.*, r.name AS restaurant_name,
            u.name AS customer_name, u.phone AS customer_phone,
            a.line1, a.line2, a.city, a.lat AS addr_lat, a.lng AS addr_lng,
            ru.name AS rider_name, ru.phone AS rider_phone
     FROM orders o
     JOIN restaurants r ON r.id = o.restaurant_id
     JOIN users u ON u.id = o.customer_id
     LEFT JOIN addresses a ON a.id = o.address_id
     LEFT JOIN riders rd ON rd.id = o.rider_id
     LEFT JOIN users ru ON ru.id = rd.user_id
     WHERE ${where}
     ORDER BY o.placed_at DESC`,
    params
  );
}

// GET /api/owner/orders?status=
router.get(
  '/orders',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    // Opportunistic activation: promote due scheduled orders so the
    // restaurant's Upcoming section goes live on time even between ticks.
    try { await activateDueScheduledOrders(); } catch (e) { console.error('scheduled activation failed:', e.message); }
    const params = [id];
    let where = 'o.restaurant_id = $1';
    if (req.query.status) {
      params.push(req.query.status);
      where += ` AND o.status = $${params.length}`;
    }
    const { rows } = await orderDetailQuery(where, params);
    for (const o of rows) {
      const items = await db.query('SELECT * FROM order_items WHERE order_id = $1', [o.id]);
      o.items = items.rows;
    }
    res.json({ orders: rows });
  })
);

const OWNER_TRANSITIONS = {
  accept: { from: ['placed'], to: 'accepted' },
  reject: { from: ['placed'], to: 'rejected' },
  // A pre-accepted scheduled order activates as 'confirmed' — the kitchen
  // skips 'accept' and goes straight to cooking.
  preparing: { from: ['accepted', 'confirmed'], to: 'preparing' },
  ready: { from: ['preparing'], to: 'ready' },
  // Dine-in orders finish at the table, not at a doorstep
  served: { from: ['ready'], to: 'delivered', dineinOnly: true }
};

// PUT /api/owner/orders/:id/pre-accept — kitchen confirms a scheduled order
// ahead of time. Sets pre_accepted=true; the order still goes live at
// activation (30 min before scheduled_for), landing in status 'confirmed'.
router.put(
  '/orders/:id/pre-accept',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'scheduled') {
      return res.status(409).json({ error: 'Only scheduled orders can be pre-accepted' });
    }
    await db.query(
      `UPDATE orders SET pre_accepted = true,
         timeline = COALESCE(timeline, '[]'::jsonb)
           || jsonb_build_object('status', 'pre_accepted', 'at', $1::text, 'by', 'restaurant_owner')
       WHERE id = $2`,
      [new Date().toISOString(), order.id]
    );
    const rName = (await db.query('SELECT name FROM restaurants WHERE id = $1', [id])).rows[0].name;
    const { formatKolkata } = require('../lib/scheduled');
    await notify(db, order.customer_id, 'Restaurant confirmed ✅',
      `${rName} confirmed your order scheduled for ${formatKolkata(order.scheduled_for)} — we'll start preparing 30 min before. 🎉`);
    res.json({ ok: true, pre_accepted: true });
  })
);

// PUT /api/owner/orders/:id/pre-reject { reason } — kitchen declines a
// scheduled order before it goes live. The customer is notified; paid orders
// are refunded.
router.put(
  '/orders/:id/pre-reject',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'scheduled') {
      return res.status(409).json({ error: 'Only scheduled orders can be pre-rejected' });
    }
    await transition(order.id, 'cancelled', 'restaurant_owner');
    const refunded = order.payment_status === 'paid';
    const reason = String((req.body && req.body.reason) || '').trim().slice(0, 280)
      || 'The restaurant could not take this order';
    await db.query(
      `UPDATE orders SET cancel_reason = $1, payment_status = $2,
         refunded_at = CASE WHEN $2 = 'refunded' THEN COALESCE(refunded_at, now()) ELSE refunded_at END
       WHERE id = $3`,
      [reason, refunded ? 'refunded' : order.payment_status, order.id]
    );
    const rName = (await db.query('SELECT name FROM restaurants WHERE id = $1', [id])).rows[0].name;
    // Late cancellation tracking: cancelled within 2 hours of scheduled time
    let isLate = false;
    if (order.scheduled_for) {
      const msUntil = new Date(order.scheduled_for).getTime() - Date.now();
      isLate = msUntil < 2 * 60 * 60 * 1000;
    }
    await db.query(
      `INSERT INTO scheduled_cancels (restaurant_id, order_id, scheduled_for, is_late)
       VALUES ($1, $2, $3, $4)`,
      [id, order.id, order.scheduled_for || null, isLate]
    );
    if (isLate) {
      await db.query('UPDATE restaurants SET late_cancels = late_cancels + 1 WHERE id = $1', [id]);
    }
    const { formatKolkata } = require('../lib/scheduled');
    const schedLabel = order.scheduled_for ? formatKolkata(order.scheduled_for) : 'your scheduled time';
    await notify(db, order.customer_id, "Restaurant couldn't take your scheduled order",
      `${rName} cancelled your order scheduled for ${schedLabel}: ${reason}${refunded ? ' Your payment will be refunded.' : ''} Tap Reorder to book again.`,
      { type: 'scheduled_cancelled', order_id: order.id, restaurant_id: id,
        restaurant_name: rName, scheduled_for: order.scheduled_for, is_late: isLate });
    // A rider had pre-accepted this scheduled order — tell them it's gone.
    if (order.scheduled_rider_id) {
      const rr = await db.query('SELECT user_id FROM riders WHERE id = $1', [order.scheduled_rider_id]);
      if (rr.rows[0]) {
        await notify(db, rr.rows[0].user_id, 'Scheduled delivery cancelled',
          `The scheduled delivery from ${rName} (${schedLabel}) you accepted was cancelled by the restaurant.`);
      }
    }
    res.json({ ok: true, status: 'cancelled', refunded, is_late: isLate });
  })
);

// PUT /api/owner/orders/:id/accept|reject|preparing|ready
router.put(
  '/orders/:id/:action',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const rule = OWNER_TRANSITIONS[req.params.action];
    if (!rule) return res.status(400).json({ error: 'Invalid action' });

    const { rows } = await db.query(
      'SELECT * FROM orders WHERE id = $1 AND restaurant_id = $2',
      [req.params.id, id]
    );
    const order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!rule.from.includes(order.status)) {
      return res.status(409).json({ error: `Cannot ${req.params.action} an order in status ${order.status}` });
    }
    if (rule.dineinOnly && order.order_type !== 'dinein') {
      return res.status(409).json({ error: 'Only dine-in orders can be marked served' });
    }

    await transition(order.id, rule.to, 'restaurant_owner');

    if (rule.to === 'rejected') {
      const reason = req.body.reason || 'Restaurant rejected the order';
      const refunded = order.payment_status === 'paid';
      await db.query(
        `UPDATE orders SET cancel_reason = $1, payment_status = $2,
           refunded_at = CASE WHEN $2 = 'refunded' THEN COALESCE(refunded_at, now()) ELSE refunded_at END
         WHERE id = $3`,
        [reason, refunded ? 'refunded' : order.payment_status, order.id]
      );
      await notify(db, order.customer_id, 'Order rejected',
        `Your order was rejected by the restaurant.${refunded ? ' Your payment will be refunded.' : ''}`);
    } else if (rule.to === 'delivered') {
      await db.query('UPDATE orders SET delivered_at = now() WHERE id = $1', [order.id]);
      await notify(db, order.customer_id, 'Enjoy your meal! 🍽️',
        'Your food is served fresh at your table. Loved it? Tap to rate ⭐');
    } else {
      const copy = {
        accepted: ['Order accepted ✅', `is firing up the kitchen for you! 🔥`],
        preparing: ['On the flame! 👨‍🍳', 'is preparing your food fresh right now.'],
        ready: ['Packed fresh! 📦', 'packed your order fresh — a rider is on the way to pick it up. 🛵']
      }[rule.to];
      await notify(db, order.customer_id, copy[0], `${(await db.query('SELECT name FROM restaurants WHERE id = $1', [id])).rows[0].name} ${copy[1]}`);
    }
    res.json({ ok: true, status: rule.to });
  })
);

// GET /api/owner/settlements
router.get(
  '/settlements',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { rows } = await db.query(
      'SELECT * FROM settlements WHERE restaurant_id = $1 ORDER BY period_start DESC', [id]
    );
    res.json({ settlements: rows });
  })
);

// GET /api/owner/ratings
router.get(
  '/ratings',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { rows } = await db.query(
      `SELECT rt.*, u.name AS rater_name FROM ratings rt
       JOIN users u ON u.id = rt.rater_id
       WHERE rt.ratee_type = 'restaurant' AND rt.ratee_id = $1
       ORDER BY rt.created_at DESC`,
      [id]
    );
    res.json({ ratings: rows });
  })
);

// ---- Dine-in tables (QR ordering) ----
router.get(
  '/tables',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { rows } = await db.query('SELECT * FROM tables WHERE restaurant_id = $1 ORDER BY label', [id]);
    res.json({ tables: rows });
  })
);

router.post(
  '/tables',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { label } = req.body;
    if (!label) return res.status(400).json({ error: 'Table label is required' });
    const qrToken = require('crypto').randomBytes(8).toString('hex');
    const { rows } = await db.query(
      'INSERT INTO tables (restaurant_id, label, qr_token) VALUES ($1, $2, $3) RETURNING *',
      [id, label, qrToken]
    );
    res.status(201).json({ table: rows[0] });
  })
);

router.delete(
  '/tables/:tableId',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    await db.query('DELETE FROM tables WHERE id = $1 AND restaurant_id = $2', [req.params.tableId, id]);
    res.json({ ok: true });
  })
);

// GET /api/owner/riders-approaching — active deliveries: rider distance + ETA to restaurant
router.get(
  '/riders-approaching',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { rows } = await db.query(
      `SELECT o.id AS order_id, u.name AS rider_name, rd.lat AS rider_lat, rd.lng AS rider_lng,
              r.lat AS rest_lat, r.lng AS rest_lng, o.status
       FROM orders o
       JOIN riders rd ON rd.id = o.rider_id
       JOIN users u ON u.id = rd.user_id
       JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.restaurant_id = $1 AND o.status IN ('ready','picked_up','on_way')`,
      [id]
    );
    const { haversineKm } = require('../lib/pricing');
    const list = rows.map((x) => {
      let etaMin = null;
      if (x.rider_lat != null && x.rider_lng != null && x.rest_lat != null && x.rest_lng != null) {
        const km = haversineKm(Number(x.rider_lat), Number(x.rider_lng), Number(x.rest_lat), Number(x.rest_lng));
        etaMin = Math.max(1, Math.round(km * 3)); // ~20 km/h city average
      }
      return { order_id: x.order_id, rider_name: x.rider_name, status: x.status, eta_minutes: etaMin };
    });
    res.json({ approaching: list });
  })
);

// GET /api/owner/restaurants/:id/photos — list gallery photos
router.get(
  '/restaurants/:id/photos',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT * FROM restaurant_photos WHERE restaurant_id = $1 ORDER BY sort_order ASC, created_at DESC`,
      [req.params.id]
    );
    res.json({ photos: rows });
  })
);

// POST /api/owner/restaurants/:id/photos { photo_url, caption? } — add photo
router.post(
  '/restaurants/:id/photos',
  ah(async (req, res) => {
    const { photo_url, caption } = req.body;
    if (!photo_url) return res.status(400).json({ error: 'photo_url required' });
    const { rows } = await db.query(
      `INSERT INTO restaurant_photos (restaurant_id, photo_url, caption) VALUES ($1, $2, $3) RETURNING *`,
      [req.params.id, photo_url, caption || null]
    );
    res.json({ photo: rows[0] });
  })
);

// DELETE /api/owner/restaurants/:id/photos/:photoId — remove photo
router.delete(
  '/restaurants/:id/photos/:photoId',
  ah(async (req, res) => {
    await db.query(`DELETE FROM restaurant_photos WHERE id = $1 AND restaurant_id = $2`,
      [req.params.photoId, req.params.id]);
    res.json({ ok: true });
  })
);

module.exports = router;
