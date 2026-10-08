// Idempotency for money-mutating endpoints (order placement, refunds,
// settlements, COD settlement, ticket refunds).
//
// Clients send either an `Idempotency-Key` HTTP header (admin app) or an
// `idempotency_key` field in the JSON body (customer app). The key is scoped
// per endpoint + user, so one user's key can never replay another user's
// request.
//
// Protocol:
//  - First request with a key claims it (completed=false) and proceeds.
//  - The response is captured via a res.json wrapper: 2xx responses are
//    stored; anything else releases the claim so the client can retry.
//  - A repeat request with the same key replays the stored response.
//  - A request arriving while a claim is in-flight gets 409.
//  - Stale in-flight claims (>2 min, e.g. crashed client) are reclaimable.
//  - Rows older than 24h are purged (boot + probabilistic cleanup).
//
// The middleware fails OPEN: if the idempotency layer itself errors, the
// request proceeds normally rather than blocking a money endpoint.
const db = require('../db');

const STALE_MINUTES = 2;
const TTL_HOURS = 24;
const MAX_KEY_LEN = 160;

function keyFromReq(req) {
  const h = req.headers && req.headers['idempotency-key'];
  if (typeof h === 'string' && h.trim()) return h.trim().slice(0, MAX_KEY_LEN);
  const b = req.body && req.body.idempotency_key;
  if (typeof b === 'string' && b.trim()) return b.trim().slice(0, MAX_KEY_LEN);
  return null;
}

async function purgeOld() {
  try {
    await db.query(
      `DELETE FROM idempotency_keys WHERE created_at < now() - INTERVAL '${TTL_HOURS} hours'`
    );
  } catch (e) {
    console.error('idempotency purge failed:', e.message);
  }
}

function idempotency(endpoint) {
  return async (req, res, next) => {
    const key = keyFromReq(req);
    // No key, or no authenticated identity to scope by: pass through.
    if (!key || !req.user || !req.user.id) return next();
    const scope = `${endpoint}:${req.user.id}`;

    let claimed = false;
    try {
      // Reclaim a stale in-flight claim left by a crashed client.
      await db.query(
        `DELETE FROM idempotency_keys
          WHERE scope = $1 AND key = $2 AND completed = false
            AND created_at < now() - INTERVAL '${STALE_MINUTES} minutes'`,
        [scope, key]
      );
      const ins = await db.query(
        `INSERT INTO idempotency_keys (scope, key, completed)
         VALUES ($1, $2, false)
         ON CONFLICT (scope, key) DO NOTHING
         RETURNING key`,
        [scope, key]
      );
      claimed = ins.rows.length > 0;
    } catch (e) {
      console.error('idempotency claim failed:', e.message);
      return next(); // fail open
    }

    if (!claimed) {
      try {
        const ex = await db.query(
          'SELECT completed, status_code, response FROM idempotency_keys WHERE scope = $1 AND key = $2',
          [scope, key]
        );
        const row = ex.rows[0];
        if (row && row.completed) {
          // Exact replay of the original response.
          return res.status(row.status_code || 200).json(row.response);
        }
      } catch (e) {
        console.error('idempotency replay failed:', e.message);
        return next();
      }
      return res.status(409).json({
        error: 'Request already in progress — please wait a moment and try again'
      });
    }

    // We own the claim: capture the response. 2xx -> store for replay,
    // anything else -> release so the client can retry with the same key.
    const origJson = res.json.bind(res);
    let finalized = false;
    const finalize = async (ok, statusCode, body) => {
      if (finalized) return;
      finalized = true;
      try {
        if (ok) {
          await db.query(
            `UPDATE idempotency_keys
                SET completed = true, status_code = $1, response = $2::jsonb
              WHERE scope = $3 AND key = $4`,
            [statusCode, JSON.stringify(body), scope, key]
          );
          // Probabilistic TTL cleanup: ~1% of money requests.
          if (Math.random() < 0.01) purgeOld().catch(() => {});
        } else {
          await db.query('DELETE FROM idempotency_keys WHERE scope = $1 AND key = $2', [scope, key]);
        }
      } catch (e) {
        console.error('idempotency finalize failed:', e.message);
      }
    };
    res.json = function (body) {
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      return finalize(ok, res.statusCode, body).then(
        () => origJson(body),
        () => origJson(body)
      );
    };
    return next();
  };
}

module.exports = { idempotency, purgeOld };
