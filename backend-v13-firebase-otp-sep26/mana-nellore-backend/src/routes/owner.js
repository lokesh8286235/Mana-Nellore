// Restaurant owner portal. Every query is scoped to the owner's own
// restaurant — an owner can never see or touch another restaurant's data.
const express = require('express');
const db = require('../db');
const { authenticate, requireRole, ah } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate, requireRole('restaurant_owner'));

async function ownRestaurantId(userId) {
  const { rows } = await db.query('SELECT id FROM restaurants WHERE owner_id = $1', [userId]);
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

async function notify(dbConn, userId, title, body) {
  await dbConn.query('INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)', [
    userId, title, body
  ]);
}

async function transition(orderId, status, by) {
  const { rows } = await db.query('SELECT timeline FROM orders WHERE id = $1', [orderId]);
  const timeline = rows[0].timeline || [];
  timeline.push({ status, at: new Date().toISOString(), by });
  // "Packed fresh" stamp: the moment the kitchen taps Ready for pickup
  const packed = status === 'ready' ? ', packed_at = now()' : '';
  await db.query(`UPDATE orders SET status = $1, timeline = $2::jsonb${packed} WHERE id = $3`, [
    status, JSON.stringify(timeline), orderId
  ]);
}

// ---- Restaurant profile ----

// POST /api/owner/restaurant — register (one restaurant per owner)
router.post(
  '/restaurant',
  ah(async (req, res) => {
    const existing = await ownRestaurantId(req.user.id);
    if (existing) return res.status(409).json({ error: 'Restaurant already registered' });
    const { name, description, address, lat, lng, phone, image_url, fssai, opens_at, closes_at } = req.body;
    if (!name) return res.status(400).json({ error: 'Restaurant name is required' });
    const { rows } = await db.query(
      `INSERT INTO restaurants
         (owner_id, name, description, address, lat, lng, phone, image_url, fssai, opens_at, closes_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.user.id, name, description || null, address || null, lat || null, lng || null,
       phone || null, image_url || null, fssai || null, opens_at || null, closes_at || null]
    );
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
      'chef_name', 'chef_photo', 'chef_story', 'gstin', 'birthday_dessert'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(req.body[f]);
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

// PUT /api/owner/hours { opens_at, closes_at }
router.put(
  '/hours',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { opens_at, closes_at } = req.body;
    const { rows } = await db.query(
      'UPDATE restaurants SET opens_at = $1, closes_at = $2 WHERE id = $3 RETURNING *',
      [opens_at || null, closes_at || null, id]
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
      [id, category_id || null, name, description || null, image_url || null,
       Math.round(Number(price_paise)), !!veg, available !== false,
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
        if (f === 'price_paise') v = Math.round(Number(v));
        if (f === 'meal_slot') v = normSlots(v);
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
  preparing: { from: ['accepted'], to: 'preparing' },
  ready: { from: ['preparing'], to: 'ready' },
  // Dine-in orders finish at the table, not at a doorstep
  served: { from: ['ready'], to: 'delivered', dineinOnly: true }
};

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
        "UPDATE orders SET cancel_reason = $1, payment_status = $2 WHERE id = $3",
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

module.exports = router;
