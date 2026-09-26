// Customer portal: saved addresses, notifications, support tickets.
// Addresses are strictly scoped to the logged-in customer.
const express = require('express');
const db = require('../db');
const { authenticate, requireRole, ah } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// ---- Addresses (customer only) ----
router.get(
  '/addresses',
  requireRole('customer'),
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
  requireRole('customer'),
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
  requireRole('customer'),
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
  requireRole('customer'),
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

module.exports = router;
