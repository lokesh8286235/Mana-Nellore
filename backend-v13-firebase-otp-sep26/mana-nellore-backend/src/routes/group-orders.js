// Group orders: shared cart for multiple people, one delivery (user 2026-10-18).
const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authenticate, ah } = require('../middleware/auth');

const router = express.Router();

function newCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Group joins are guest-friendly (no login required), so auth is OPTIONAL
// here: when the caller sends a valid customer token we record who they are
// (added_by_user_id) and enforce ownership on deletes; when they do not,
// the guest flow works exactly as before. A bad/expired token never blocks
// a guest — it is simply ignored.
function optionalCustomer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    if (payload && payload.role === 'customer') return { id: payload.sub };
    return null;
  } catch (e) {
    return null;
  }
}

// POST /api/group-orders — create a group order (host must be logged in)
router.post(
  '/',
  authenticate,
  ah(async (req, res) => {
    const { restaurant_id, host_name } = req.body || {};
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });
    // A group can only start at a restaurant that exists and can take orders.
    const rRes = await db.query(
      "SELECT id FROM restaurants WHERE id = $1 AND status = 'approved' AND COALESCE(is_coming_soon, false) = false",
      [restaurant_id]
    );
    if (!rRes.rows[0]) return res.status(400).json({ error: 'Restaurant is not available for ordering' });
    const code = newCode();
    const { rows } = await db.query(
      `INSERT INTO group_orders (code, restaurant_id, host_user_id, host_name, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING *`,
      [code, restaurant_id, req.user.id, host_name || req.user.name || 'Host']
    );
    res.json({ group: rows[0] });
  })
);

// GET /api/group-orders/:code — view group (public, no auth for joining)
router.get(
  '/:code',
  ah(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM group_orders WHERE code = $1', [req.params.code.toUpperCase()]);
    if (!rows.length) return res.status(404).json({ error: 'Group not found' });
    const g = rows[0];
    const items = await db.query(
      `SELECT gi.*, mi.name AS dish_name, mi.price_paise, mi.veg
       FROM group_order_items gi
       LEFT JOIN menu_items mi ON mi.id = gi.dish_id
       WHERE gi.group_id = $1 ORDER BY gi.added_at`,
      [g.id]
    );
    const rest = await db.query('SELECT id, name FROM restaurants WHERE id = $1', [g.restaurant_id]);
    res.json({ group: g, items: items.rows, restaurant: rest.rows[0] || null });
  })
);

// POST /api/group-orders/:code/items — add item (no auth, just a name)
router.post(
  '/:code/items',
  ah(async (req, res) => {
    const { rows } = await db.query(
      "SELECT * FROM group_orders WHERE code = $1 AND status = 'open'",
      [req.params.code.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Group not found or closed' });
    const group = rows[0];
    const { dish_id, qty, person_name } = req.body || {};
    if (!dish_id || !person_name) return res.status(400).json({ error: 'dish_id and person_name required' });
    // The dish must exist AND belong to this group's restaurant. The old
    // code inserted any dish_id unchecked — a dish from another restaurant
    // landed in the group, and a nonexistent dish died with a raw FK 500.
    const dish = await db.query(
      'SELECT id, restaurant_id FROM menu_items WHERE id = $1',
      [dish_id]
    );
    if (!dish.rows[0]) return res.status(404).json({ error: 'Dish not found' });
    if (String(dish.rows[0].restaurant_id) !== String(group.restaurant_id)) {
      return res.status(400).json({ error: 'Dish is not from this group\u2019s restaurant' });
    }
    const caller = optionalCustomer(req);
    const { rows: inserted } = await db.query(
      `INSERT INTO group_order_items (group_id, dish_id, qty, person_name, added_by_user_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [group.id, dish_id, Math.max(1, Math.min(20, qty || 1)), String(person_name).slice(0, 50),
       caller ? caller.id : null]
    );
    res.json({ ok: true, item: inserted[0] });
  })
);

// DELETE /api/group-orders/:code/items/:itemId — remove own item
router.delete(
  '/:code/items/:itemId',
  ah(async (req, res) => {
    const { rows } = await db.query('SELECT id, status, host_user_id FROM group_orders WHERE code = $1', [req.params.code.toUpperCase()]);
    if (!rows.length) return res.status(404).json({ error: 'Group not found' });
    if (rows[0].status !== 'open') return res.status(409).json({ error: 'Group is closed' });
    const item = await db.query(
      'SELECT id, person_name, added_by_user_id FROM group_order_items WHERE id = $1 AND group_id = $2',
      [req.params.itemId, rows[0].id]
    );
    if (!item.rows[0]) return res.status(404).json({ error: 'Item not found' });
    // Ownership: the host may remove any item; anyone else may remove only
    // their own. Guests (no token) keep the old behaviour — they joined
    // without an account, so there is nothing to check against. A signed-in
    // caller who is neither the host nor the item's person gets a 403.
    const caller = optionalCustomer(req);
    if (caller) {
      const isHost = String(rows[0].host_user_id) === String(caller.id);
      const isOwner = item.rows[0].added_by_user_id != null
        && String(item.rows[0].added_by_user_id) === String(caller.id);
      let isNamedPerson = false;
      if (!isHost && !isOwner) {
        const u = await db.query('SELECT name FROM users WHERE id = $1', [caller.id]);
        isNamedPerson = !!u.rows[0] && !!u.rows[0].name
          && String(u.rows[0].name).trim().toLowerCase() === String(item.rows[0].person_name).trim().toLowerCase();
      }
      if (!isHost && !isOwner && !isNamedPerson) {
        return res.status(403).json({ error: 'You can only remove your own items' });
      }
    }
    const del = await db.query('DELETE FROM group_order_items WHERE id = $1 AND group_id = $2', [req.params.itemId, rows[0].id]);
    if (!del.rowCount) return res.status(404).json({ error: 'Item not found' });
    res.json({ ok: true });
  })
);

// POST /api/group-orders/:code/close — host closes and gets checkout data
router.post(
  '/:code/close',
  authenticate,
  ah(async (req, res) => {
    const { rows } = await db.query('SELECT * FROM group_orders WHERE code = $1', [req.params.code.toUpperCase()]);
    if (!rows.length) return res.status(404).json({ error: 'Group not found' });
    const g = rows[0];
    if (String(g.host_user_id) !== String(req.user.id)) return res.status(403).json({ error: 'Only host can close' });
    if (g.status !== 'open') return res.status(409).json({ error: 'Group is already closed' });
    // UPDATE ... RETURNING * so the response carries the FRESH row (the old
    // code returned the pre-UPDATE row, still "open") and closed_at is set.
    const closed = await db.query(
      "UPDATE group_orders SET status = 'closed', closed_at = now() WHERE id = $1 RETURNING *",
      [g.id]
    );
    const items = await db.query(
      `SELECT gi.dish_id, gi.qty, gi.person_name, mi.name AS dish_name, mi.price_paise, mi.veg
       FROM group_order_items gi
       LEFT JOIN menu_items mi ON mi.id = gi.dish_id
       WHERE gi.group_id = $1`,
      [g.id]
    );
    res.json({ group: closed.rows[0], items: items.rows });
  })
);

module.exports = router;
