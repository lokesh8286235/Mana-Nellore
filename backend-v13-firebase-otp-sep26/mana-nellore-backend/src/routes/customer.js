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
    // Scoped update FIRST, in one transaction: the old code cleared every
    // default flag before the update, so a 404 left the user with no default.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      params.push(req.params.id, req.user.id);
      const { rows } = await client.query(
        `UPDATE addresses SET ${sets.join(', ')}
         WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
        params
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Address not found' });
      }
      if (req.body.is_default) {
        await client.query(
          'UPDATE addresses SET is_default = false WHERE user_id = $1 AND id <> $2',
          [req.user.id, rows[0].id]
        );
      }
      await client.query('COMMIT');
      res.json({ address: rows[0] });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  })
);

router.delete(
  '/addresses/:id',
  
  ah(async (req, res) => {
    const del = await db.query('DELETE FROM addresses WHERE id = $1 AND user_id = $2', [
      req.params.id, req.user.id
    ]);
    if (!del.rowCount) return res.status(404).json({ error: 'Address not found' });
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
    const unread = await db.query(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND COALESCE(read, false) = false',
      [req.user.id]
    );
    res.json({ notifications: rows, unread_count: unread.rows[0].n });
  })
);

router.put(
  '/notifications/:id/read',
  ah(async (req, res) => {
    const upd = await db.query('UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2', [
      req.params.id, req.user.id
    ]);
    if (!upd.rowCount) return res.status(404).json({ error: 'Notification not found' });
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
// Photo-aware version (kept); the older no-photo duplicate was removed so
// ticket photos actually reach the server.
router.post(
  '/support/tickets',
  ah(async (req, res) => {
    const { order_id, category, subject, message, photo_url } = req.body;
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required' });
    }
    if (order_id) {
      const o = await db.query('SELECT id FROM orders WHERE id = $1 AND customer_id = $2', [order_id, req.user.id]);
      if (!o.rows[0]) return res.status(400).json({ error: 'Order not found' });
    }
    const { rows } = await db.query(
      `INSERT INTO support_tickets (user_id, order_id, category, subject, message, photo_url)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, order_id || null, category || null, subject, message, photo_url || null]
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

// ---- Profile ----
router.get(
  '/profile',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT id, phone, email, name, role, dob, is_student, referral_code, created_at FROM users WHERE id = $1',
      [req.user.id]
    );
    // Delivered-only stats (2026-11-27): placed/cancelled orders never count
    // toward "orders" or "total spent" — the old query counted every order
    // and summed every non-cancelled one, so a placed-then-cancelled order
    // inflated "Total spent" with money never paid.
    const stats = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'delivered') AS orders,
              COALESCE(SUM(total_paise) FILTER (WHERE status = 'delivered'), 0) AS spent_paise
       FROM orders WHERE customer_id = $1`, [req.user.id]
    );
    res.json({
      profile: rows[0],
      stats: { orders: Number(stats.rows[0].orders), spent_paise: Number(stats.rows[0].spent_paise) }
    });
  })
);

router.put(
  '/profile',
  ah(async (req, res) => {
    const { name, dob } = req.body;
    // dob must be a real YYYY-MM-DD date: Postgres threw a 500 on garbage
    // like "tomorrow" or "12/31/1990" instead of a clean 400.
    if (dob != null && dob !== '') {
      const m = /^\d{4}-\d{2}-\d{2}$/.exec(String(dob));
      const d = m ? new Date(String(dob) + 'T00:00:00Z') : null;
      const real = !!d && !Number.isNaN(d.getTime())
        && d.toISOString().slice(0, 10) === String(dob);
      if (!real) return res.status(400).json({ error: 'Invalid dob — use YYYY-MM-DD' });
    }
    const { rows } = await db.query(
      `UPDATE users SET name = COALESCE($1, name), dob = COALESCE($2, dob)
       WHERE id = $3
       RETURNING id, phone, name, role, dob, is_student, referral_code`,
      [name || null, dob || null, req.user.id]
    );
    res.json({ profile: rows[0] });
  })
);

// ---- Delete my account ----
// DELETE /api/customer/account — own account only (req.user.id), customers only.
// A rider profile or a restaurant ownership blocks deletion (409: contact
// support) so deleting a customer login can never silently orphan a livelihood.
// What happens, in ONE transaction:
//   * Orders are ANONYMIZED, not deleted: customer_id is reassigned to the
//     "Deleted account" placeholder user (00000000-0000-0000-0000-000000000000,
//     no phone/email/name of a real person), delivery lat/lng/label, delivery
//     note and recipient name/phone are nulled, and address_id drops to NULL
//     when the addresses are deleted. Order ids, order numbers, restaurant,
//     rider, items, totals, payment fields, timeline and status are kept
//     untouched for accounting. (The placeholder — not NULL — keeps every
//     JOIN working: owner/admin order views still list the order, showing
//     "Deleted account" instead of a name/phone. orders.customer_id is NOT
//     NULL with no ON DELETE action, so the user row cannot be deleted while
//     orders still point at it.)
//   * Personal data is DELETED: the user row, addresses, push tokens,
//     favorites, coupon issuances, support tickets, ratings + dish ratings
//     authored by the user, callback requests, open alerts, student
//     applications, notifications and unused OTP codes. Other users'
//     referred_by pointers to this user become NULL automatically.
//   * Group traces are scrubbed, not deleted (other members' data stays):
//     groups hosted by the user keep running with host_name "Deleted user";
//     group items the user added lose the added_by link.
//   * The JWT dies with the row: authenticate() 401s ("Account no longer
//     exists") on any later call with the old token.
const DELETED_CUSTOMER_ID = '00000000-0000-0000-0000-000000000000';

router.delete(
  '/account',
  ah(async (req, res) => {
    if (req.user.role !== 'customer') {
      return res.status(403).json({ error: 'Only customer accounts can be deleted here' });
    }
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      // Guards: never orphan a restaurant or a rider profile.
      const owns = await client.query(
        'SELECT id FROM restaurants WHERE owner_id = $1 LIMIT 1', [req.user.id]
      );
      if (owns.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This account owns a restaurant — contact support to delete it' });
      }
      const rides = await client.query(
        'SELECT id FROM riders WHERE user_id = $1 LIMIT 1', [req.user.id]
      );
      if (rides.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This account has a rider profile — contact support to delete it' });
      }
      // Placeholder "deleted customer" (no phone/email of a real person).
      await client.query(
        `INSERT INTO users (id, phone, name, role) VALUES ($1, NULL, 'Deleted account', 'customer')
         ON CONFLICT (id) DO NOTHING`,
        [DELETED_CUSTOMER_ID]
      );
      // Anonymize orders FIRST (see comment above — the user row cannot be
      // deleted while orders still point at it).
      const anon = await client.query(
        `UPDATE orders SET customer_id = $2, delivery_lat = NULL, delivery_lng = NULL,
           delivery_label = NULL, delivery_note = NULL, recipient_name = NULL, recipient_phone = NULL
         WHERE customer_id = $1`,
        [req.user.id, DELETED_CUSTOMER_ID]
      );
      // Scrub group traces (groups themselves stay for the other members).
      await client.query(
        `UPDATE group_orders SET host_name = 'Deleted user' WHERE host_user_id = $1`,
        [req.user.id]
      );
      await client.query(
        `UPDATE group_order_items SET added_by_user_id = NULL WHERE added_by_user_id = $1`,
        [req.user.id]
      );
      // Delete personal data. Most of these also cascade from the users row,
      // but explicit deletes keep the endpoint correct even where a live FK
      // differs from the repo schema.
      await client.query('DELETE FROM push_tokens WHERE user_id = $1', [req.user.id]);
      await client.query('DELETE FROM addresses WHERE user_id = $1', [req.user.id]);
      await client.query('DELETE FROM favorites WHERE customer_id = $1', [req.user.id]);
      await client.query('DELETE FROM coupon_issuances WHERE user_id = $1', [req.user.id]);
      await client.query('DELETE FROM support_tickets WHERE user_id = $1', [req.user.id]);
      await client.query('DELETE FROM ratings WHERE rater_id = $1', [req.user.id]);
      await client.query('DELETE FROM dish_ratings WHERE customer_id = $1', [req.user.id]);
      await client.query('DELETE FROM callback_requests WHERE user_id = $1', [req.user.id]);
      await client.query('DELETE FROM restaurant_open_alerts WHERE user_id = $1', [req.user.id]);
      await client.query('DELETE FROM student_applications WHERE user_id = $1', [req.user.id]);
      await client.query('DELETE FROM notifications WHERE user_id = $1', [req.user.id]);
      await client.query(
        'DELETE FROM otp_codes WHERE phone = (SELECT phone FROM users WHERE id = $1)',
        [req.user.id]
      );
      const del = await client.query('DELETE FROM users WHERE id = $1', [req.user.id]);
      if (!del.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Account not found' });
      }
      await client.query('COMMIT');
      res.json({ ok: true, anonymized_orders: anon.rowCount });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  })
);

// ---- Call me back: CUT (user 2026-09-28, permanent). The POST route is
// removed — customers can no longer file callbacks. The GET below is kept
// as read-only history for requests filed before the cut.
router.get(
  '/callbacks',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT * FROM callback_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20',
      [req.user.id]
    );
    res.json({ callbacks: rows });
  })
);

// ---- Notify-me-when-open alerts ----
router.post(
  '/open-alerts',
  ah(async (req, res) => {
    const { restaurant_id } = req.body;
    if (!restaurant_id) return res.status(400).json({ error: 'restaurant_id is required' });
    await db.query(
      `INSERT INTO restaurant_open_alerts (user_id, restaurant_id)
       VALUES ($1, $2) ON CONFLICT (user_id, restaurant_id) DO NOTHING`,
      [req.user.id, restaurant_id]
    );
    res.json({ ok: true });
  })
);

router.delete(
  '/open-alerts/:restaurantId',
  ah(async (req, res) => {
    await db.query(
      'DELETE FROM restaurant_open_alerts WHERE user_id = $1 AND restaurant_id = $2',
      [req.user.id, req.params.restaurantId]
    );
    res.json({ ok: true });
  })
);

// ---- Referrals: share code, both sides earn a coupon (no wallet credits) ----
function makeReferralCode() {
  const crypto = require('crypto');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'MN';
  for (let i = 0; i < 6; i++) code += chars[crypto.randomInt(chars.length)];
  return code;
}

router.get(
  '/referral',
  ah(async (req, res) => {
    let { rows } = await db.query('SELECT referral_code FROM users WHERE id = $1', [req.user.id]);
    let code = rows[0].referral_code;
    if (!code) {
      code = makeReferralCode();
      await db.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, req.user.id]);
    }
    const count = await db.query('SELECT COUNT(*) AS n FROM users WHERE referred_by = $1', [req.user.id]);
    res.json({ code, referrals: Number(count.rows[0].n) });
  })
);

// POST /api/customer/referral/apply { code } — new customer applies a friend's code,
// both get a Rs 50 off coupon.
// NOTE (hardcoded, user decision needed): the Rs 50 value (5000 paise) and
// Rs 199 minimum (19900 paise) in mkCoupon are literals, not config —
// flagged, not changed (see b776 report).
// The whole apply is ONE transaction: the old code did ~6 sequential writes
// with no transaction and no ON CONFLICT on the coupon insert, so a failure
// or a code collision mid-apply left one side rewarded and the other not.
router.post(
  '/referral/apply',
  ah(async (req, res) => {
    const code = String(req.body.code || '').toUpperCase().trim();
    if (!code) return res.status(400).json({ error: 'Referral code is required' });
    const me = await db.query('SELECT referred_by FROM users WHERE id = $1', [req.user.id]);
    if (me.rows[0] && me.rows[0].referred_by) return res.status(409).json({ error: 'You already used a referral code' });
    const friend = await db.query('SELECT id FROM users WHERE referral_code = $1', [code]);
    if (!friend.rows[0]) return res.status(400).json({ error: 'Invalid referral code' });
    if (friend.rows[0].id === req.user.id) {
      return res.status(400).json({ error: 'You are entering your own referral code 🙂' });
    }
    const friendId = friend.rows[0].id;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      // Re-check under lock: two simultaneous applies must not both win.
      const locked = await client.query(
        'SELECT referred_by FROM users WHERE id = $1 FOR UPDATE', [req.user.id]
      );
      if (locked.rows[0] && locked.rows[0].referred_by) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'You already used a referral code' });
      }
      // Coupon codes are random hex; a collision retries with a fresh code
      // instead of dying on the UNIQUE(code) constraint.
      const mkCoupon = async (suffix) => {
        for (let attempt = 0; attempt < 5; attempt++) {
          const c = 'REF' + suffix + require('crypto').randomBytes(4).toString('hex').toUpperCase();
          const ins = await client.query(
            `INSERT INTO coupons (code, discount_type, value, min_order_paise, max_discount_paise, active)
             VALUES ($1, 'flat', 5000, 19900, 5000, true)
             ON CONFLICT (code) DO NOTHING RETURNING code`, [c]
          );
          if (ins.rows[0]) return ins.rows[0].code;
        }
        throw { status: 500, message: 'Could not generate a referral coupon, please retry' };
      };
      const myCoupon = await mkCoupon('ME');
      const friendCoupon = await mkCoupon('FR');
      const upd = await client.query(
        'UPDATE users SET referred_by = $1 WHERE id = $2 AND referred_by IS NULL',
        [friendId, req.user.id]
      );
      if (!upd.rowCount) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'You already used a referral code' });
      }
      // Record issuance so GET /api/customer/coupons can list them (survives reinstalls)
      await client.query(
        `INSERT INTO coupon_issuances (user_id, coupon_code, source) VALUES ($1, $2, 'referral')
         ON CONFLICT (user_id, coupon_code) DO NOTHING`,
        [req.user.id, myCoupon]
      );
      await client.query(
        `INSERT INTO coupon_issuances (user_id, coupon_code, source) VALUES ($1, $2, 'referral')
         ON CONFLICT (user_id, coupon_code) DO NOTHING`,
        [friendId, friendCoupon]
      );
      await client.query('INSERT INTO notifications (user_id, title, body) VALUES ($1, $2, $3)',
        [friendId, '🎉 Your friend joined Mana Nellore!',
         `Thanks for spreading the word! Here's Rs 50 off your next order: ${friendCoupon}`]);
      await client.query('COMMIT');
      res.json({ ok: true, coupon: myCoupon, message: 'Rs 50 off coupon added to your account!' });
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  })
);

// ---- Student discount application ----
router.post(
  '/student-apply',
  ah(async (req, res) => {
    const { id_photo, college } = req.body;
    if (!id_photo) return res.status(400).json({ error: 'College ID photo is required' });
    const { rows } = await db.query(
      `INSERT INTO student_applications (user_id, id_photo, college)
       VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, id_photo, college || null]
    );
    res.status(201).json({ application: rows[0] });
  })
);

// ---- Favorites: server-side memory so hearts survive phone changes/reinstalls ----
router.get(
  '/favorites',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT entity_type, entity_id FROM favorites WHERE customer_id = $1 ORDER BY created_at',
      [req.user.id]
    );
    res.json({ favorites: rows });
  })
);

router.post(
  '/favorites',
  ah(async (req, res) => {
    const { entity_type, entity_id } = req.body || {};
    if (!['restaurant', 'dish'].includes(entity_type)) {
      return res.status(400).json({ error: 'entity_type must be restaurant or dish' });
    }
    if (!entity_id) return res.status(400).json({ error: 'entity_id is required' });
    // A favorite must point at something real — the old code accepted any
    // string, so hearts on deleted dishes/restaurants piled up as dead rows.
    // A non-UUID id can never exist, so it is a 404, not a Postgres 500.
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(String(entity_id))) {
      return res.status(404).json({ error: 'Item not found' });
    }
    const exists = await db.query(
      entity_type === 'restaurant'
        ? 'SELECT 1 FROM restaurants WHERE id = $1'
        : 'SELECT 1 FROM menu_items WHERE id = $1',
      [entity_id]
    );
    if (!exists.rows[0]) return res.status(404).json({ error: 'Item not found' });
    await db.query(
      `INSERT INTO favorites (customer_id, entity_type, entity_id)
       VALUES ($1, $2, $3) ON CONFLICT (customer_id, entity_type, entity_id) DO NOTHING`,
      [req.user.id, entity_type, String(entity_id)]
    );
    res.status(201).json({ ok: true });
  })
);

router.delete(
  '/favorites',
  ah(async (req, res) => {
    const { entity_type, entity_id } = req.body || {};
    if (!entity_type || !entity_id) {
      return res.status(400).json({ error: 'entity_type and entity_id are required' });
    }
    await db.query(
      'DELETE FROM favorites WHERE customer_id = $1 AND entity_type = $2 AND entity_id = $3',
      [req.user.id, entity_type, String(entity_id)]
    );
    res.json({ ok: true });
  })
);

// ---- Preferences: veg-only + healthy defaults follow the customer ----
router.get(
  '/preferences',
  ah(async (req, res) => {
    const { rows } = await db.query(
      'SELECT veg_only, healthy_default FROM users WHERE id = $1',
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ preferences: { veg_only: !!rows[0].veg_only, healthy_default: !!rows[0].healthy_default } });
  })
);

router.put(
  '/preferences',
  ah(async (req, res) => {
    const sets = [];
    const params = [];
    if (req.body.veg_only !== undefined) {
      params.push(!!req.body.veg_only);
      sets.push(`veg_only = $${params.length}`);
    }
    if (req.body.healthy_default !== undefined) {
      params.push(!!req.body.healthy_default);
      sets.push(`healthy_default = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.user.id);
    const { rows } = await db.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING veg_only, healthy_default`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ preferences: { veg_only: !!rows[0].veg_only, healthy_default: !!rows[0].healthy_default } });
  })
);

// ---- My refunds: orders with payment_status='refunded' ----
router.get(
  '/refunds',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT o.id AS order_id, o.total_paise AS amount_paise, o.payment_status AS status,
              o.placed_at, o.cancel_reason, r.name AS restaurant_name
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE o.customer_id = $1 AND o.payment_status = 'refunded'
       ORDER BY o.placed_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ refunds: rows });
  })
);

// ---- My coupons: only codes actually issued to this customer, with live status ----
router.get(
  '/coupons',
  ah(async (req, res) => {
    const { rows } = await db.query(
      `SELECT ci.coupon_code AS code, ci.source, ci.issued_at,
              c.discount_type, c.value, c.min_order_paise, c.max_discount_paise,
              c.active, c.valid_from, c.valid_to
       FROM coupon_issuances ci
       LEFT JOIN coupons c ON c.code = ci.coupon_code
       WHERE ci.user_id = $1
       ORDER BY ci.issued_at DESC`,
      [req.user.id]
    );
    const now = new Date();
    const coupons = rows.map((r) => {
      let status = 'usable';
      if (!r.active) status = 'inactive';
      else if (r.valid_from && new Date(r.valid_from) > now) status = 'upcoming';
      else if (r.valid_to && new Date(r.valid_to) < now) status = 'expired';
      return {
        code: r.code,
        source: r.source,
        issued_at: r.issued_at,
        discount_type: r.discount_type,
        value: r.value,
        min_order_paise: r.min_order_paise,
        max_discount_paise: r.max_discount_paise,
        status
      };
    });
    res.json({ coupons });
  })
);

module.exports = router;
