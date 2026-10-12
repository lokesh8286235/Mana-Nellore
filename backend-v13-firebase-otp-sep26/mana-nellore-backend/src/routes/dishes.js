// Dish ratings: customers rate individual dishes from their delivered orders.
// Only buyers can rate (must have ordered the dish), one rating per dish per order.
const express = require('express');
const db = require('../db');
const { authenticate, ah } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// POST /api/dishes/:id/rate { rating: 1-5, order_id }
// Verifies: dish exists, order belongs to the customer, order is delivered,
// the dish was in that order, and no existing rating for (dish, customer, order).
router.post(
  '/:id/rate',
  ah(async (req, res) => {
    const dishId = req.params.id;
    const rating = Number(req.body.rating);
    const orderId = req.body.order_id;

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dishId)) {
      return res.status(404).json({ error: 'Dish not found' });
    }
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Rating must be 1-5' });
    }
    if (!orderId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
      return res.status(400).json({ error: 'Valid order_id is required' });
    }

    // Dish must exist
    const dish = await db.query('SELECT id, restaurant_id FROM menu_items WHERE id = $1', [dishId]);
    if (!dish.rows[0]) return res.status(404).json({ error: 'Dish not found' });

    // Order must belong to this customer and be delivered
    const order = await db.query(
      'SELECT id, status FROM orders WHERE id = $1 AND customer_id = $2',
      [orderId, req.user.id]
    );
    if (!order.rows[0]) return res.status(404).json({ error: 'Order not found' });
    if (order.rows[0].status !== 'delivered') {
      return res.status(409).json({ error: 'You can rate dishes only from delivered orders' });
    }

    // The dish must have been in that order
    const inOrder = await db.query(
      'SELECT 1 FROM order_items WHERE order_id = $1 AND menu_item_id = $2 LIMIT 1',
      [orderId, dishId]
    );
    if (!inOrder.rows[0]) {
      return res.status(403).json({ error: 'You can only rate dishes you ordered' });
    }

    // One rating per dish per order
    const existing = await db.query(
      'SELECT id FROM dish_ratings WHERE dish_id = $1 AND customer_id = $2 AND order_id = $3',
      [dishId, req.user.id, orderId]
    );
    if (existing.rows[0]) {
      return res.status(409).json({ error: 'Dish already rated for this order' });
    }

    await db.query(
      'INSERT INTO dish_ratings (dish_id, customer_id, order_id, rating) VALUES ($1, $2, $3, $4)',
      [dishId, req.user.id, orderId, rating]
    );

    // Return the fresh aggregate so the client can update instantly
    const agg = await db.query(
      `SELECT COALESCE(AVG(rating), 0)::float AS avg, COUNT(*)::int AS count
       FROM dish_ratings WHERE dish_id = $1`,
      [dishId]
    );
    res.json({
      ok: true,
      rating_avg: Math.round(agg.rows[0].avg * 10) / 10,
      rating_count: agg.rows[0].count,
    });
  })
);

// GET /api/dishes/:id/ratings — recent ratings for a dish (for the restaurant app feed)
router.get(
  '/:id/ratings',
  ah(async (req, res) => {
    const dishId = req.params.id;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dishId)) {
      return res.status(404).json({ error: 'Dish not found' });
    }
    // Restaurant owners see their own dishes' ratings; customers see aggregates only.
    const dish = await db.query(
      `SELECT mi.id, mi.restaurant_id, r.owner_id FROM menu_items mi
       JOIN restaurants r ON r.id = mi.restaurant_id WHERE mi.id = $1`,
      [dishId]
    );
    if (!dish.rows[0]) return res.status(404).json({ error: 'Dish not found' });

    const isOwner = req.user.role === 'owner' && String(dish.rows[0].owner_id) === String(req.user.id);
    const isAdmin = req.user.role === 'admin';
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ error: 'Only the restaurant can see individual ratings' });
    }

    const { rows } = await db.query(
      `SELECT dr.rating, dr.created_at, u.name AS customer_name
       FROM dish_ratings dr
       LEFT JOIN users u ON u.id = dr.customer_id
       WHERE dr.dish_id = $1
       ORDER BY dr.created_at DESC LIMIT 50`,
      [dishId]
    );
    res.json({ ratings: rows });
  })
);

module.exports = router;
