// Mana Nellore backend — single source of truth for the four apps
// (customer, restaurant, rider, admin). Node.js + Express + PostgreSQL.
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { initDb } = require('./db');
const { activateDueScheduledOrders } = require('./lib/scheduled');

const app = express();
// Behind Railway's proxy the client IP arrives in X-Forwarded-For. Without
// this, rate limiting keys on the proxy IP and every user shares one bucket.
app.set('trust proxy', 1);
app.use(helmet());
// Browsers may only call the API from our own web apps (*.vercel.app covers
// the stable domains and deploy URLs). Non-browser clients (curl, native
// apps) send no Origin and are unaffected.
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || /\.vercel\.app$/.test(origin)) return cb(null, true);
      return cb(new Error('CORS: origin not allowed'));
    },
  })
);
app.use(express.json({ limit: '2mb' }));

// Rate limiting: general API + strict OTP/auth
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120 requests per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many requests, please slow down' }
});
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // 10 OTP/login attempts per minute per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many attempts, please try again in a minute' }
});
app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);

app.get('/api/health', (req, res) => {
  // Public: readiness only. Never expose dbStatus.error — init failure
  // messages can contain connection details.
  res.json({
    ok: !dbStatus.error,
    service: 'mana-nellore-backend',
    db: { ready: dbStatus.ready },
    time: new Date().toISOString(),
  });
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/restaurants', require('./routes/restaurants'));
app.use('/api/owner', require('./routes/owner'));
app.use('/api/customer', require('./routes/customer'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/rider', require('./routes/rider'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', require('./routes/public'));

// Static image assets — deliberately outside /api/ so menu/gallery bursts
// don't consume the API rate-limit budget.
app.use('/img', require('./routes/img'));

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// Central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  // Don't leak raw DB errors (e.g. invalid UUID syntax) to clients
  if (err.code === '22P02') {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 8080;

// Tracks DB init state for /api/health. The server always starts so a bad
// migration shows up as a diagnosable degraded state instead of a silent
// crash loop.
const dbStatus = { ready: false, phase: null, error: null };

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set');
  process.exit(1);
}

initDb()
  .then(() => {
    dbStatus.ready = true;
    // Scheduled orders: promote due ones every 60s (30-min prep lead time).
    // Idempotent via the status='scheduled' check; a single Railway instance
    // runs this, so no distributed lock is needed. The same function also
    // runs opportunistically on the rider-offers and restaurant-orders paths.
    const tickScheduled = () => {
      activateDueScheduledOrders().catch((e) => console.error('scheduled activation failed:', e.message));
    };
    tickScheduled();
    setInterval(tickScheduled, 60 * 1000);
  })
  .catch((e) => {
    dbStatus.phase = e.phase || 'unknown';
    dbStatus.error = e.message;
    console.error(`Database init failed in phase [${dbStatus.phase}]:`, e.message);
  })
  .finally(() => {
    app.listen(PORT, () => console.log(`mana-nellore-backend listening on ${PORT} (db ready: ${dbStatus.ready})`));
  });
