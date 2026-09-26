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

async function notify(dbConn, userId, title, body) {
  await dbConn.query('INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)', [
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
    const fields = ['name', 'description', 'address', 'lat', 'lng', 'phone', 'image_url', 'fssai'];
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

// PUT /api/owner/open { is_open }
router.put(
  '/open',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const { rows } = await db.query(
      'UPDATE restaurants SET is_open = $1 WHERE id = $2 RETURNING *',
      [!!req.body.is_open, id]
    );
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
    const { category_id, name, description, image_url, price_paise, veg, available, prep_minutes, sort_order } = req.body;
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
         (restaurant_id, category_id, name, description, image_url, price_paise, veg, available, prep_minutes, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [id, category_id || null, name, description || null, image_url || null,
       Math.round(Number(price_paise)), !!veg, available !== false,
       prep_minutes || 20, sort_order || 0]
    );
    res.status(201).json({ item: rows[0] });
  })
);

router.put(
  '/menu/items/:itemId',
  ah(async (req, res) => {
    const id = await requireRestaurant(req, res);
    if (!id) return;
    const fields = ['category_id', 'name', 'description', 'image_url', 'price_paise', 'veg', 'available', 'prep_minutes', 'sort_order'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        let v = req.body[f];
        if (f === 'price_paise') v = Math.round(Number(v));
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
  ready: { from: ['preparing'], to: 'ready' }
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
    } else {
      const labels = { accepted: 'accepted your order', preparing: 'is preparing your order', ready: 'has your order ready for pickup' };
      await notify(db, order.customer_id, 'Order update', `The restaurant ${labels[rule.to]}.`);
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

module.exports = router;
