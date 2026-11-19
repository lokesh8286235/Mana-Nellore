// JWT authentication + role guards. Every protected route uses these,
// and every query additionally scopes by req.user.id / role (role isolation).
const jwt = require('jsonwebtoken');
const db = require('../db');

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing Authorization token' });
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = { id: payload.sub, role: payload.role };
  // A valid signature is not enough: the account must still exist and not be
  // blocked. A DB error fails open (the route handler needs the DB anyway);
  // a confirmed missing/blocked account is rejected here.
  try {
    const { rows } = await db.query('SELECT is_blocked FROM users WHERE id = $1', [payload.sub]);
    if (!rows[0]) return res.status(401).json({ error: 'Account no longer exists' });
    if (rows[0].is_blocked) {
      return res.status(403).json({ error: 'Your account has been blocked. Please contact support.' });
    }
  } catch (e) {
    console.error('[auth] user lookup failed, proceeding with JWT claims:', e.message);
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden for this role' });
    }
    next();
  };
}

// Async route wrapper so thrown errors reach the error handler.
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = { signToken, authenticate, requireRole, ah };
