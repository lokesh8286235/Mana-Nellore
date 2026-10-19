// Group orders: shared cart for multiple people, one delivery (user 2026-10-18).
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { authenticate, ah } = require('../middleware/auth');

const router = express.Router();

function newCode() {
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}

// POST /api/group-orders — create a group order (host must be logged in)
router.post(
  '/',
  authenticate,
  ah(async (req, res) => {
    const { restaurant_id, host_name } = req.body || {};
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id required' });
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
      `SELECT gi.*, mi.name AS dish_name, mi.price_paise
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
    const { dish_id, qty, person_name } = req.body || {};
    if (!dish_id || !person_name) return res.status(400).json({ error: 'dish_id and person_name required' });
    await db.query(
      `INSERT INTO group_order_items (group_id, dish_id, qty, person_name)
       VALUES ($1, $2, $3, $4)`,
      [rows[0].id, dish_id, Math.max(1, Math.min(20, qty || 1)), String(person_name).slice(0, 50)]
    );
    res.json({ ok: true });
  })
);

// DELETE /api/group-orders/:code/items/:itemId — remove own item
router.delete(
  '/:code/items/:itemId',
  ah(async (req, res) => {
    const { rows } = await db.query('SELECT id FROM group_orders WHERE code = $1', [req.params.code.toUpperCase()]);
    if (!rows.length) return res.status(404).json({ error: 'Group not found' });
    await db.query('DELETE FROM group_order_items WHERE id = $1 AND group_id = $2', [req.params.itemId, rows[0].id]);
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
    await db.query("UPDATE group_orders SET status = 'closed' WHERE id = $1", [g.id]);
    const items = await db.query(
      `SELECT gi.dish_id, gi.qty, gi.person_name, mi.name AS dish_name, mi.price_paise
       FROM group_order_items gi
       LEFT JOIN menu_items mi ON mi.id = gi.dish_id
       WHERE gi.group_id = $1`,
      [g.id]
    );
    res.json({ group: g, items: items.rows });
  })
);

module.exports = router;
