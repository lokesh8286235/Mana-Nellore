// Scheduled ordering: activation of due scheduled orders.
//
// A scheduled order goes live PREP_LEAD_MINUTES (30) before its
// scheduled_for time: status 'scheduled' -> 'placed' (or 'confirmed' when
// the restaurant pre-accepted), firing the same notifications a fresh
// placed order gets. All rows of one order group (primary + secondaries)
// activate atomically in a single transaction.
// Idempotent: only rows still in 'scheduled' status are touched, so
// overlapping runs (the 60s timer + opportunistic request-path calls) are
// harmless.
const db = require('../db');

// Prep lead time: orders go live this many minutes before scheduled_for.
const PREP_LEAD_MINUTES = 30;

async function notify(userId, title, body) {
  await db.query('INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)', [
    userId, title, body
  ]);
}

// Customer-facing date/time, e.g. "Thu, 8 Oct, 7:00 pm" (Asia/Kolkata).
function formatKolkata(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short', day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(d);
}

// Assign a pre-accepted scheduled group to its committed rider at
// activation. Eligibility mirrors the live accept guards (online, no
// multi-delivery lock, < 3 active groups). Ineligible -> the group stays
// unassigned and flows into the normal offer pool; the rider is told why.
async function handoffPreAcceptedRider(primaryId, riderId, firstRow) {
  const rr = await db.query('SELECT id, user_id, online, status FROM riders WHERE id = $1', [riderId]);
  const rider = rr.rows[0];
  const rn = await db.query('SELECT name FROM restaurants WHERE id = $1', [firstRow.restaurant_id]);
  const rname = (rn.rows[0] && rn.rows[0].name) || 'the restaurant';
  const when = formatKolkata(firstRow.scheduled_for);
  const release = async (reason) => {
    if (rider && rider.user_id) {
      await notify(rider.user_id, 'Scheduled delivery released',
        `Your scheduled delivery from ${rname} (${when}) was released to other riders: ${reason}.`);
    }
  };
  if (!rider || rider.status !== 'approved') {
    await release('your account is not active');
    return;
  }
  if (!rider.online) {
    await release('you are offline');
    return;
  }
  const md = await db.query(
    `SELECT 1 FROM orders o
     WHERE o.rider_id = $1 AND o.status NOT IN ('delivered','cancelled')
       AND (o.otw_role IS NULL OR o.otw_role = 'primary')
       AND EXISTS (SELECT 1 FROM orders s WHERE s.otw_primary_order_id = o.id
                   AND s.status NOT IN ('delivered','cancelled'))
     LIMIT 1`,
    [riderId]
  );
  if (md.rows.length) {
    await release('you are on a multi-restaurant delivery');
    return;
  }
  const cnt = await db.query(
    `SELECT COUNT(*) AS n FROM orders
     WHERE rider_id = $1 AND status NOT IN ('delivered','cancelled')
       AND (otw_role IS NULL OR otw_role = 'primary')`,
    [riderId]
  );
  if (Number(cnt.rows[0].n) >= 3) {
    await release('you already hold 3 active deliveries');
    return;
  }
  const nowIso = new Date().toISOString();
  await db.query(
    `UPDATE orders SET rider_id = $1,
       timeline = COALESCE(timeline, '[]'::jsonb)
         || jsonb_build_object('status', 'rider_assigned', 'at', $3::text, 'by', 'system')
     WHERE (id = $2 OR otw_primary_order_id = $2)
       AND status IN ('placed','confirmed') AND rider_id IS NULL`,
    [riderId, primaryId, nowIso]
  );
  await notify(rider.user_id, '🛵 Your scheduled delivery is live',
    `Head to ${rname} — your scheduled order (${when}) is now being prepared.`);
}

// Promote every due scheduled group to live. Returns { activated } — the
// number of groups transitioned (0 when nothing is due).
async function activateDueScheduledOrders() {
  if (activateDueScheduledOrders.running) return { activated: 0, skipped: true };
  activateDueScheduledOrders.running = true;
  try {
    // Cheap indexed probe (idx_orders_status_scheduled): nothing due -> out.
    const probe = await db.query(
      `SELECT 1 FROM orders
       WHERE status = 'scheduled' AND scheduled_for <= now() + ($1 || ' minutes')::interval
       LIMIT 1`,
      [String(PREP_LEAD_MINUTES)]
    );
    if (!probe.rows.length) return { activated: 0 };

    // Orphaned secondaries: their primary was cancelled/pre-rejected out from
    // under them. Promote them to standalone primaries so they still go live
    // on time instead of stalling in 'scheduled' forever.
    await db.query(
      `UPDATE orders o SET otw_role = 'primary', otw_primary_order_id = NULL
       WHERE o.status = 'scheduled' AND o.otw_role = 'secondary'
         AND o.scheduled_for <= now() + ($1 || ' minutes')::interval
         AND NOT EXISTS (
           SELECT 1 FROM orders p
           WHERE p.id = o.otw_primary_order_id AND p.status = 'scheduled'
         )`,
      [String(PREP_LEAD_MINUTES)]
    );

    const { rows: primaries } = await db.query(
      `SELECT id FROM orders
       WHERE status = 'scheduled'
         AND scheduled_for <= now() + ($1 || ' minutes')::interval
         AND (otw_role IS NULL OR otw_role = 'primary')
       ORDER BY scheduled_for ASC LIMIT 50`,
      [String(PREP_LEAD_MINUTES)]
    );
    let activated = 0;
    for (const p of primaries) {
      if (await activateGroup(p.id)) activated++;
    }
    return { activated };
  } finally {
    activateDueScheduledOrders.running = false;
  }
}
activateDueScheduledOrders.running = false;

// Activate one order group (primary + secondaries) in a single transaction.
// Returns true when the group transitioned, false when it was already gone.
async function activateGroup(primaryId) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const pr = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [primaryId]);
    const primary = pr.rows[0];
    if (!primary || primary.status !== 'scheduled') {
      await client.query('ROLLBACK');
      return false;
    }
    const nowIso = new Date().toISOString();
    const upd = await client.query(
      `UPDATE orders
       SET status = CASE WHEN pre_accepted THEN 'confirmed' ELSE 'placed' END,
           timeline = COALESCE(timeline, '[]'::jsonb)
             || jsonb_build_object('status',
                  (CASE WHEN pre_accepted THEN 'confirmed' ELSE 'placed' END)::text,
                  'at', $2::text, 'by', 'system')
       WHERE (id = $1 OR otw_primary_order_id = $1) AND status = 'scheduled'
       RETURNING *`,
      [primaryId, nowIso]
    );
    await client.query('COMMIT');
    const rows = upd.rows;
    if (!rows.length) return false;

    // The EXACT same notifications a fresh placed order gets: a new-order
    // push per restaurant (drives the kitchen alarm), then one customer push
    // for the whole group.
    for (const o of rows) {
      const ownerRes = await db.query('SELECT owner_id FROM restaurants WHERE id = $1', [o.restaurant_id]);
      const owner = ownerRes.rows[0];
      if (owner && owner.owner_id) {
        await notify(owner.owner_id, '🔔 New order!',
          `Delivery order worth Rs ${(Number(o.total_paise) / 100).toFixed(2)} — the kitchen needs you! 👨‍🍳`);
      }
    }
    const first = rows.find((o) => o.otw_role !== 'secondary') || rows[0];
    const otp = first.order_type === 'delivery' ? first.delivery_otp : null;
    await notify(first.customer_id, 'Your scheduled order is now being prepared',
      `Your scheduled order${rows.length > 1 ? ` (${rows.length} restaurants)` : ''} is now being prepared.` +
      // OTP parity with ASAP orders (which get the OTP text at placement):
      // the last-pickup fallback does NOT re-notify because an OTP hash
      // already exists, so this is the customer's only OTP push.
      (otp ? ` Your delivery OTP is ${otp} — share it with your rider at handover.` : ''));

    // Rider pre-acceptance handoff: a rider committed to this scheduled order
    // ahead of time. Auto-assign them now if they're eligible (online, no
    // multi-delivery lock, under the 3-slot cap) — the 1km on-the-way rule
    // is a live-offers filter and doesn't apply to a prior commitment.
    // Otherwise release to the normal offer pool.
    const preRiderId = first.scheduled_rider_id;
    if (preRiderId) {
      await handoffPreAcceptedRider(primaryId, preRiderId, first);
    }
    console.log(`scheduled: activated group ${primaryId} (${rows.length} rows)`);
    return true;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { activateDueScheduledOrders, remindRiderPreAccepted, formatKolkata, PREP_LEAD_MINUTES };

// 1-hour rider reminder: for scheduled orders a rider pre-accepted, where
// the slot is now within 60 minutes and we haven't reminded yet, push a
// "get ready" notification to the rider. Idempotent via rider_reminded.
async function remindRiderPreAccepted() {
  if (remindRiderPreAccepted.running) return { reminded: 0, skipped: true };
  remindRiderPreAccepted.running = true;
  try {
    const { rows } = await db.query(
      `SELECT o.id, o.scheduled_for, o.scheduled_rider_id, rd.user_id AS rider_user_id,
              r.name AS restaurant_name
       FROM orders o
       JOIN riders rd ON rd.id = o.scheduled_rider_id
       JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.status = 'scheduled'
         AND o.scheduled_rider_id IS NOT NULL
         AND o.rider_reminded = false
         AND (o.otw_role IS NULL OR o.otw_role = 'primary')
         AND o.scheduled_for > now()
         AND o.scheduled_for <= now() + interval '60 minutes'
       LIMIT 50`
    );
    let reminded = 0;
    for (const o of rows) {
      await db.query(
        `UPDATE orders SET rider_reminded = true
         WHERE id = $1 AND rider_reminded = false`,
        [o.id]
      );
      await notify(o.rider_user_id, '⏰ Scheduled delivery in 1 hour',
        `Your scheduled delivery from ${o.restaurant_name} (${formatKolkata(o.scheduled_for)}) starts in 1 hour. Get ready!`);
      reminded++;
    }
    return { reminded };
  } finally {
    remindRiderPreAccepted.running = false;
  }
}
remindRiderPreAccepted.running = false;
