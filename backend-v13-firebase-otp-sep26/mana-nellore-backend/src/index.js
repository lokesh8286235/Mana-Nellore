// Mana Nellore backend — single source of truth for the four apps
// (customer, restaurant, rider, admin). Node.js + Express + PostgreSQL.
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { initDb } = require('./db');
const { activateDueScheduledOrders, remindRiderPreAccepted } = require('./lib/scheduled');

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
// Per-phone OTP limits (on top of the per-IP authLimiter above): sending and
// verifying OTPs is additionally throttled per phone number so one attacker
// cannot burn SMS budget or brute-force a single victim's 6-digit code from
// many IPs. Keys are last-10-digits + IP (normalized in the route handlers).
const phoneKey = (req) => {
  const raw = String((req.body && req.body.phone) || (req.query && req.query.phone) || '');
  const digits = raw.replace(/\D/g, '');
  return (digits.slice(-10) || 'nophone') + ':' + ipKeyGenerator(req.ip);
};
const otpSendLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5, // 5 OTP sends per 10 min per phone
  keyGenerator: phoneKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many OTP requests for this number, please try again later' }
});
const otpVerifyLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10, // 10 verify attempts per 10 min per phone (6-digit codes expire in 10 min)
  keyGenerator: phoneKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many wrong attempts, please request a fresh code' }
});
// /api/applications/check is an unauthenticated partner-number oracle —
// throttle it aggressively per IP.
const appCheckLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20, // 20 checks per hour per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many checks, please try again later' }
});
app.use('/api/', apiLimiter);
app.use('/api/auth/', authLimiter);
app.use('/api/auth/send-otp', otpSendLimiter);
app.use('/api/auth/verify-otp', otpVerifyLimiter);
app.use('/api/applications/check', appCheckLimiter);

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
app.use('/api/ai', require('./routes/ai'));
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
      remindRiderPreAccepted().catch((e) => console.error('rider reminder failed:', e.message));
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
