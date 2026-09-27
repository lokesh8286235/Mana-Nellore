// Customer portal: saved addresses, notifications, support tickets.
// Addresses are strictly scoped to the logged-in customer.
const express = require('express');
const db = require('../db');
const { authenticate, ah } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ---- Current location (customer) ----
router.put(
  '/location',

  ah(async (req, res) => {
    const { lat, lng } = req.body;
    if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng are required' });
    await db.query('UPDATE users SET lat = $1, lng = $2 WHERE id = $3', [lat, lng, req.user.id]);
    res.json({ ok: true, lat, lng });
  })
);

// ---- Addresses (customer only) ----
router.get(
  '/addresses',
  
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, label',
      [req.user.id]
    );
    res.json({ addresses: rows });
  })
);

router.post(
  '/addresses',
  
  ah(async (req, res) => {
    const { label, line1, line2, city, lat, lng, is_default } = req.body;
    if (!line1) return res.status(400).json({ error: 'Address line1 is required' });
    if (is_default) {
      await db.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    }
    const { rows } = await db.query(
      `INSERT INTO addresses (user_id, label, line1, line2, city, lat, lng, is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, label || null, line1, line2 || null, city || 'Nellore',
       lat || null, lng || null, !!is_default]
    );
    res.status(201).json({ address: rows[0] });
  })
);

router.put(
  '/addresses/:id',
  
  ah(async (req, res) => {
    const fields = ['label', 'line1', 'line2', 'city', 'lat', 'lng', 'is_default'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(req.body[f]);
        sets.push(`${f} = $${params.length}`);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    if (req.body.is_default) {
      await db.query('UPDATE addresses SET is_default = false WHERE user_id = $1', [req.user.id]);
    }
    params.push(req.params.id, req.user.id);
    const { rows } = await db.query(
      `UPDATE addresses SET ${sets.join(', ')}
       WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'Address not found' });
    res.json({ address: rows[0] });
  })
);

router.delete(
  '/addresses/:id',
  
  ah(async (req, res) => {
    await db.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2', [
      req.params.id, req.user.id
    ]);
    res.json({ ok: true });
  })
);

// ---- Notifications (any authenticated role; always scoped to self) ----
router.get(
  '/notifications',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    res.json({ notifications: rows });
  })
);

router.put(
  '/notifications/:id/read',
  ah(async (req, res) => {
    await db.query('UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2', [
      req.params.id, req.user.id
    ]);
    res.json({ ok: true });
  })
);

// DELETE /api/customer/notifications — clear all my notifications
router.delete(
  '/notifications',
  ah(async (req, res) => {
    await db.query('DELETE FROM notifications WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  })
);

// ---- Support tickets (any authenticated role; users see only their own) ----
router.post(
  '/support/tickets',
  ah(async (req, res) => {
    const { order_id, category, subject, message } = req.body;
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required' });
    }
    if (order_id) {
      const o = await db.query('SELECT id FROM orders WHERE id = $1', [order_id]);
      if (!o.rows[0]) return res.status(400).json({ error: 'Order not found' });
    }
    const { rows } = await db.query(
      `INSERT INTO support_tickets (user_id, order_id, category, subject, message)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, order_id || null, category || null, subject, message]
    );
    res.status(201).json({ ticket: rows[0] });
  })
);

router.get(
  '/support/tickets',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json({ tickets: rows });
  })
);

// ---- Credits (customer only) — wallet balance from promise/apology credits ----
router.get(
  '/credits',
  
  ah(async (req, res) => {
    const bal = await db.query(
      'SELECT COALESCE(SUM(amount_paise), 0) AS balance FROM customer_credits WHERE user_id = $1',
      [req.user.id]
    );
    const hist = await db.query(
      `SELECT c.*, o.id AS order_ref FROM customer_credits c
       LEFT JOIN orders o ON o.id = c.order_id
       WHERE c.user_id = $1 ORDER BY c.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ balance_paise: Number(bal.rows[0].balance), history: hist.rows });
  })
);

module.exports = router;
