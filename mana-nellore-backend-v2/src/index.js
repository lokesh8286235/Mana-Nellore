// Mana Nellore backend — single source of truth for the four apps
// (customer, restaurant, rider, admin). Node.js + Express + PostgreSQL.
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { initDb } = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'mana-nellore-backend', time: new Date().toISOString() });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/restaurants', require('./routes/restaurants'));
app.use('/api/owner', require('./routes/owner'));
app.use('/api/customer', require('./routes/customer'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/rider', require('./routes/rider'));
app.use('/api/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 8080;

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set');
  process.exit(1);
}

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`mana-nellore-backend listening on ${PORT}`));
  })
  .catch((e) => {
    console.error('Database init failed:', e.message);
    process.exit(1);
  });
