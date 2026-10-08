// PostgreSQL connection pool + boot-time schema run + seeding.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 25,                    // headroom for 1000+ concurrent app users polling
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

function query(text, params) {
  return pool.query(text, params);
}

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(schema);
  } catch (e) { e.phase = 'schema'; throw e; }
  try {
    await migrate();
  } catch (e) { e.phase = 'migrate'; throw e; }
  try {
    await seed();
  } catch (e) { e.phase = 'seed'; throw e; }
  console.log('Database ready');
}

// Idempotent migrations for databases created before these columns existed.
async function migrate() {
  const q = (t) => pool.query(t);

  // Role-splitting: one phone -> separate profile per role.
  await q(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_key') THEN
      ALTER TABLE users DROP CONSTRAINT users_phone_key;
    END IF;
  END $$`);
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_phone_role_key') THEN
      ALTER TABLE users ADD CONSTRAINT users_phone_role_key UNIQUE (phone, role);
    END IF;
  END $$`);
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS dob date');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_student boolean NOT NULL DEFAULT false');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by uuid');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_otp text');
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_referred_by_fkey') THEN
      ALTER TABLE users ADD CONSTRAINT users_referred_by_fkey
        FOREIGN KEY (referred_by) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
  END $$`);
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_referral_code_key') THEN
      ALTER TABLE users ADD CONSTRAINT users_referral_code_key UNIQUE (referral_code);
    END IF;
  END $$`);

  // Restaurants: verified badge, chef profile, GST, birthday dessert
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS chef_name text');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS chef_photo text');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS chef_story text');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS gstin text');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS birthday_dessert boolean NOT NULL DEFAULT false');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS opens_at_we time');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS is_coming_soon boolean NOT NULL DEFAULT false');
  // Coming soon means NOT approved yet: any coming-soon restaurant that is still
  // marked approved+verified gets moved back to pending+unverified (idempotent).
  await q(`UPDATE restaurants SET verified = false, status = 'pending'
           WHERE is_coming_soon = true AND status = 'approved'`);
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS closes_at_we time');

  // Menu items: meal slots, combos, allergens
  await q("ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS meal_slot text[] NOT NULL DEFAULT '{all}'");
  // meal_slot was single text before multi-select — convert legacy values to text[]
  await q(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'menu_items' AND column_name = 'meal_slot' AND data_type = 'text') THEN
      ALTER TABLE menu_items ALTER COLUMN meal_slot DROP DEFAULT;
      ALTER TABLE menu_items DROP CONSTRAINT IF EXISTS menu_items_meal_slot_check;
      ALTER TABLE menu_items ALTER COLUMN meal_slot TYPE text[] USING ARRAY[meal_slot]::text[];
      ALTER TABLE menu_items ALTER COLUMN meal_slot SET DEFAULT '{all}';
      ALTER TABLE menu_items ADD CONSTRAINT menu_items_meal_slot_check
        CHECK (meal_slot <@ ARRAY['all','breakfast','lunch','dinner']);
    END IF;
  END $$`);
  await q('ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_combo boolean NOT NULL DEFAULT false');
  await q("ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS allergens jsonb NOT NULL DEFAULT '[]'");
  // Dish ratings: aggregated from order food_ratings (each dish in a rated order
  // gets one "vote" at the order's food_rating). Powers "Recommended dishes".
  await q('ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS rating_avg numeric NOT NULL DEFAULT 0');
  await q('ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS rating_count integer NOT NULL DEFAULT 0');
  // Backfill dish ratings from historical order ratings
  await q(`UPDATE menu_items mi SET
             rating_count = sub.cnt,
             rating_avg = sub.avg
           FROM (
             SELECT oi.menu_item_id AS mid, COUNT(*) AS cnt, AVG(r.food_rating)::numeric AS avg
             FROM ratings r
             JOIN order_items oi ON oi.order_id = r.order_id
             WHERE r.ratee_type = 'restaurant' AND r.food_rating IS NOT NULL
               AND oi.menu_item_id IS NOT NULL
             GROUP BY oi.menu_item_id
           ) sub
           WHERE mi.id = sub.mid`);

  // Restaurant rating_count: aggregated from order food_ratings. The
  // restaurants table only had rating_avg; the count powers the "(1.2k)"
  // display on restaurant cards.
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS rating_count integer NOT NULL DEFAULT 0');
  // Backfill restaurant rating counts from historical ratings
  await q(`UPDATE restaurants r SET
             rating_count = sub.cnt
           FROM (
             SELECT ratee_id AS rid, COUNT(*) AS cnt
             FROM ratings
             WHERE ratee_type = 'restaurant' AND food_rating IS NOT NULL
             GROUP BY ratee_id
           ) sub
           WHERE r.id = sub.rid`);

  // Orders: new lifecycle fields
  await q(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'promised_at')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'eta_at') THEN
      ALTER TABLE orders RENAME COLUMN promised_at TO eta_at;
    END IF;
  END $$`);
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS eta_at timestamptz');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_photo text');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS packed_at timestamptz');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_photo text');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS share_token text');
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_share_token_key') THEN
      ALTER TABLE orders ADD CONSTRAINT orders_share_token_key UNIQUE (share_token);
    END IF;
  END $$`);
  await q("ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type text NOT NULL DEFAULT 'delivery'");
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS table_id uuid');
  // Dine-in table link (added here, not in schema.sql, because on existing
  // databases the table_id column only exists after the line above).
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_table_id_fkey') THEN
      ALTER TABLE orders ADD CONSTRAINT orders_table_id_fkey
        FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE SET NULL;
    END IF;
  END $$`);
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_note text');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS no_cutlery boolean NOT NULL DEFAULT false');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS tip_paise int NOT NULL DEFAULT 0');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_name text');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_phone text');
  // On-the-way grouping (anti-scam): which orders belong to a multi-restaurant
  // group, their role, and whether a claimed secondary discount was denied.
  await q("ALTER TABLE orders ADD COLUMN IF NOT EXISTS otw_role text");
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS otw_primary_order_id uuid');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS otw_group_size int');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS otw_discount_denied boolean NOT NULL DEFAULT false');
  // COD 'collected' status
  await q('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check');
  await q(`ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
    CHECK (payment_status IN ('pending','paid','failed','refunded','collected'))`);

  // Scheduled ordering: scheduled_for + pre_accepted, new 'scheduled' /
  // 'confirmed' statuses. Existing databases carry the old auto-named
  // orders_status_check — replace it only when it lacks the new values.
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_for timestamptz');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS pre_accepted boolean NOT NULL DEFAULT false');
  await q(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_check'
               AND pg_get_constraintdef(oid) NOT LIKE '%scheduled%') THEN
      ALTER TABLE orders DROP CONSTRAINT orders_status_check;
    END IF;
  END $$`);
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_check') THEN
      ALTER TABLE orders ADD CONSTRAINT orders_status_check
        CHECK (status IN ('placed','accepted','rejected','preparing','ready',
                          'picked_up','on_way','delivered','cancelled',
                          'scheduled','confirmed'));
    END IF;
  END $$`);
  await q('CREATE INDEX IF NOT EXISTS idx_orders_status_scheduled ON orders(status, scheduled_for)');
  // Scheduled order cancellation protection: track late cancels per restaurant,
  // allow admin to suspend scheduling, structured notification data.
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS late_cancels int NOT NULL DEFAULT 0');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS scheduling_suspended boolean NOT NULL DEFAULT false');
  await q('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS data jsonb');
  await q(`CREATE TABLE IF NOT EXISTS scheduled_cancels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id uuid REFERENCES restaurants(id) ON DELETE SET NULL,
    order_id uuid,
    scheduled_for timestamptz,
    cancelled_at timestamptz NOT NULL DEFAULT now(),
    is_late boolean NOT NULL DEFAULT false
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_sched_cancels_rest ON scheduled_cancels(restaurant_id, cancelled_at)');

  // Rider scheduled pre-acceptance: a rider can commit to a scheduled order
  // ahead of time (scheduled_rider_id). We remind them 1 hour before it goes
  // live (rider_reminded) and auto-assign at activation when eligible.
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_rider_id uuid REFERENCES riders(id) ON DELETE SET NULL');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS scheduled_rider_at timestamptz');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_reminded boolean NOT NULL DEFAULT false');
  await q('CREATE INDEX IF NOT EXISTS idx_orders_sched_rider ON orders(scheduled_rider_id) WHERE scheduled_rider_id IS NOT NULL');

  // Remove wallet/credit remnants
  await q('ALTER TABLE orders DROP COLUMN IF EXISTS credits_used_paise');
  await q('DROP TABLE IF EXISTS customer_credits');

  // Quest bonuses survive quest deletion
  await q('ALTER TABLE rider_bonuses DROP CONSTRAINT IF EXISTS rider_bonuses_quest_id_fkey');
  await q('ALTER TABLE rider_bonuses ALTER COLUMN quest_id DROP NOT NULL');
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rider_bonuses_quest_id_fkey') THEN
      ALTER TABLE rider_bonuses ADD CONSTRAINT rider_bonuses_quest_id_fkey
        FOREIGN KEY (quest_id) REFERENCES quests(id) ON DELETE SET NULL;
    END IF;
  END $$`);

  // Support tickets: resolution notes + photo attachments
  await q('ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolution_note text');
  await q('ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS photo_url text');

  // Audit log: per-session staff name
  await q('ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS staff_name text');

  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS aadhaar_no text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS aadhaar_photo text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS profile_photo text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS cancelled_deliveries int NOT NULL DEFAULT 0');
  await q('ALTER TABLE coupons ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()');
  await q('ALTER TABLE coupons ADD COLUMN IF NOT EXISTS requires_student boolean NOT NULL DEFAULT false');
  await q('ALTER TABLE restaurant_applications ADD COLUMN IF NOT EXISTS aadhar text');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS aadhar text');
  await q("ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS cuisines text[] NOT NULL DEFAULT '{}'");
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS is_pure_veg boolean NOT NULL DEFAULT false');

  // Customer memory: preferences, favorites, coupon issuances (survive reinstalls)
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS veg_only boolean NOT NULL DEFAULT false');
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS healthy_default boolean NOT NULL DEFAULT false');
  await q(`CREATE TABLE IF NOT EXISTS favorites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_type text NOT NULL CHECK (entity_type IN ('restaurant','dish')),
    entity_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (customer_id, entity_type, entity_id)
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_favorites_customer ON favorites(customer_id)');
  await q(`CREATE TABLE IF NOT EXISTS coupon_issuances (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    coupon_code text NOT NULL,
    source text,
    issued_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, coupon_code)
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_coupon_issuances_user ON coupon_issuances(user_id)');

  // Backfill share tokens for old orders
  await q(`UPDATE orders SET share_token = substr(md5(random()::text || id::text), 1, 12)
           WHERE share_token IS NULL`);

  // Fix 2026-10-07: Clear restaurant coords outside India (bogus geocoding).
  // Sri Durga had US coords showing 14708km from Nellore. Restaurants in
  // Nellore must be within India bounds; anything outside is wrong data.
  await q(`UPDATE restaurants SET lat = NULL, lng = NULL
           WHERE lat IS NOT NULL AND (
             lat < 6 OR lat > 38 OR lng < 68 OR lng > 98
           )`);

  // Image store (v16): photo bytes as immutable files, not data-URLs in JSON.
  await q(`CREATE TABLE IF NOT EXISTS images (
    hash text PRIMARY KEY,
    data bytea NOT NULL,
    mime text NOT NULL DEFAULT 'image/jpeg',
    created_at timestamptz NOT NULL DEFAULT now()
  )`);

  // Idempotency keys for money-mutating endpoints (order placement, refunds,
  // settlements, COD settlement, ticket refunds). Scoped per endpoint + user.
  // Rows are completed once and purged after 24h (see purgeOld).
  await q(`CREATE TABLE IF NOT EXISTS idempotency_keys (
    scope text NOT NULL,
    key text NOT NULL,
    completed boolean NOT NULL DEFAULT false,
    status_code int,
    response jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (scope, key)
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at)');
  await q(`DELETE FROM idempotency_keys WHERE created_at < now() - INTERVAL '24 hours'`);

  // Refund flag on orders: refunded_at is set everywhere payment_status
  // becomes 'refunded'; the generated `refunded` boolean flows into every
  // order object (all serializers use SELECT o.*) so apps can exclude
  // refunded orders (e.g. restaurant home revenue) without extra queries.
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS refunded_at timestamptz');
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'orders' AND column_name = 'refunded') THEN
      ALTER TABLE orders ADD COLUMN refunded boolean
        GENERATED ALWAYS AS (refunded_at IS NOT NULL) STORED;
    END IF;
  END $$`);
  // Backfill: historical refunded orders predate the column.
  await q(`UPDATE orders SET refunded_at = COALESCE(placed_at, now())
           WHERE payment_status = 'refunded' AND refunded_at IS NULL`);

  // Rider SOS alerts: created in an earlier deploy without a schema entry;
  // declare it here so fresh databases get the table the routes expect.
  await q(`CREATE TABLE IF NOT EXISTS sos_alerts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rider_id uuid REFERENCES riders(id) ON DELETE SET NULL,
    lat double precision,
    lng double precision,
    status text NOT NULL DEFAULT 'open',
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_sos_rider_created ON sos_alerts(rider_id, created_at)');

  await migrateDataUrlPhotos();
}

// One-time: move data-URL photos already stored in text columns into the
// image store and rewrite the columns to /img/<hash>. Idempotent — only rows
// still holding a data:image/... value are touched.
async function migrateDataUrlPhotos() {
  const crypto = require('crypto');
  const { parseDataUrl, imgUrl } = require('./lib/images');
  const targets = [
    ['restaurants', 'image_url'],
    ['restaurants', 'chef_photo'],
    ['menu_items', 'image_url'],
  ];
  for (const [table, col] of targets) {
    const { rows } = await pool.query(
      `SELECT id, ${col} AS v FROM ${table} WHERE ${col} LIKE 'data:image/%'`
    );
    for (const r of rows) {
      const p = parseDataUrl(r.v);
      if (!p || !p.buffer.length) continue;
      const hash = crypto.createHash('sha256').update(p.buffer).digest('hex');
      await pool.query(
        'INSERT INTO images (hash, data, mime) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING',
        [hash, p.buffer, p.mime]
      );
      await pool.query(`UPDATE ${table} SET ${col} = $1 WHERE id = $2`, [imgUrl(hash), r.id]);
      console.log(`migrated photo ${table}.${col} ${r.id} -> ${imgUrl(hash).slice(0, 60)}...`);
    }
    // Fix up rows migrated while the URL was still relative: /img/<hash> ->
    // absolute. Idempotent.
    await pool.query(
      `UPDATE ${table} SET ${col} = $1 || substring(${col} from 5)
       WHERE ${col} LIKE '/img/%'`,
      [imgUrl('').slice(0, -1)]
    );
  }
}

// Default pricing rules (paise). Admin can edit these live via /api/admin/pricing.
function defaultPricingRows() {
  return {
    delivery_tiers: {
      tiers: [
        { up_to_km: 3, rate_paise_per_km: 1000 }, // 0-3 km: Rs 10/km
        { up_to_km: 8, rate_paise_per_km: 900 },  // 3-8 km: Rs 9/km
        { up_to_km: null, rate_paise_per_km: 800 } // 8+ km: Rs 8/km
      ]
    },
    rider_payout_tiers: {
      slab1_up_to_km: 5,
      slab1_rate_paise_per_km: 800,   // 0-5 km: Rs 8/km
      slab2_up_to_km: 8,
      slab2_rate_paise_per_km: 900,   // 5-8 km: Rs 9/km on full distance
      slab3_base_km: 8,
      slab3_base_rate_paise_per_km: 800,  // 8+ km: first 8 km @ Rs 8/km
      slab3_extra_rate_paise_per_km: 1000 // + extra km @ Rs 10/km
    },
    platform_fee_paise: 800, // Rs 8
    default_commission_pct: 12,
    free_delivery_rules: {
      rules: [
        { min_order_paise: 49900, max_distance_km: 3 },   // Rs 499+ up to 3 km
        { min_order_paise: 89900, max_distance_km: 5 },   // Rs 899+ up to 5 km
        { min_order_paise: 129900, max_distance_km: 8 }   // Rs 1299+ up to 8 km
      ]
    },
    eta_minutes: 30,              // Honest ETA estimate shown to customers (not a guarantee)
    call_to_order_phone: ''       // support / phone-order line shown in the customer app
    ,
    // GST rates (%) charged on the customer bill. Editable from the admin
    // Pricing screen; the customer app fetches them via GET /api/config so
    // rate changes apply without an app rebuild.
    tax_rates: { food_gst_pct: 5, delivery_gst_pct: 18, platform_gst_pct: 18 }
  };
}

async function seed() {
  const adminPhone = process.env.ADMIN_PHONE;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminPhone && adminPassword) {
    const hash = await bcrypt.hash(adminPassword, 10);
    await pool.query(
      `INSERT INTO users (phone, name, role, password_hash)
       VALUES ($1, 'Admin', 'admin', $2)
       ON CONFLICT (phone, role) DO UPDATE
         SET password_hash = EXCLUDED.password_hash`,
      [adminPhone, hash]
    );
  } else {
    console.log('ADMIN_PHONE/ADMIN_PASSWORD not set — skipping admin seed');
  }

  const rows = defaultPricingRows();
  for (const [key, value] of Object.entries(rows)) {
    await pool.query(
      'INSERT INTO pricing_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [key, JSON.stringify(value)]
    );
  }

  // Retire the promise-time delivery zones (feature removed); keep nothing reading them.
  await pool.query('DROP TABLE IF EXISTS zones');
  // Rename promise_minutes -> eta_minutes, but never violate the unique key if
  // eta_minutes was already seeded above: drop the stale row instead.
  await pool.query(`DELETE FROM pricing_config WHERE key = 'promise_minutes'
    AND EXISTS (SELECT 1 FROM pricing_config WHERE key = 'eta_minutes')`);
  await pool.query(`UPDATE pricing_config SET key = 'eta_minutes' WHERE key = 'promise_minutes'`);
}

module.exports = { pool, query, initDb };
