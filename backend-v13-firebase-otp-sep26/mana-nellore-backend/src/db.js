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
  statement_timeout: 15000,   // kill runaway queries before they cascade
  query_timeout: 15000,
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
// The whole migrate runs inside ONE transaction: a failure midway used to
// leave a half-migrated DB (later steps applied, earlier ones not); now it
// rolls back and the next boot retries from a clean state. Postgres DDL is
// transactional, so BEGIN/COMMIT covers every ALTER/CREATE below.
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = (t) => client.query(t);

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
  // Google sign-in (2026-11-18): email column + phone nullable, unique per role.
  await q('ALTER TABLE users ADD COLUMN IF NOT EXISTS email text');
  await q('ALTER TABLE users ALTER COLUMN phone DROP NOT NULL');
  await q('CREATE UNIQUE INDEX IF NOT EXISTS users_email_role_key ON users (email, role)');
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
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS is_coming_soon boolean NOT NULL DEFAULT false');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS opens_at_we time');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS closes_at_we time');

  // Menu items: meal slots, combos, allergens
  await q("ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS meal_slot text[] NOT NULL DEFAULT '{all}'");
  await q('ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS calories INT');
  await q('ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS protein_g NUMERIC(5,1)');
  await q('ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_jain BOOLEAN DEFAULT false');
  // meal_slot was single text before multi-select — convert legacy values to text[].
  // Conversion and CHECK are separate idempotent blocks: if an earlier run
  // converted the type but died before adding the CHECK, a retry used to
  // skip the whole block (data_type was no longer 'text') and the constraint
  // was lost forever. Now the CHECK block has its own guard and completes.
  await q(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'menu_items' AND column_name = 'meal_slot' AND data_type = 'text') THEN
      ALTER TABLE menu_items ALTER COLUMN meal_slot DROP DEFAULT;
      ALTER TABLE menu_items DROP CONSTRAINT IF EXISTS menu_items_meal_slot_check;
      ALTER TABLE menu_items ALTER COLUMN meal_slot TYPE text[] USING ARRAY[meal_slot]::text[];
      ALTER TABLE menu_items ALTER COLUMN meal_slot SET DEFAULT '{all}';
    END IF;
  END $$`);
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'menu_items_meal_slot_check') THEN
      ALTER TABLE menu_items ADD CONSTRAINT menu_items_meal_slot_check
        CHECK (meal_slot <@ ARRAY['all','breakfast','lunch','dinner']);
    END IF;
  END $$`);
  await q('ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_combo boolean NOT NULL DEFAULT false');
  await q("ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS allergens jsonb NOT NULL DEFAULT '[]'");

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
  // Backfill share tokens ONLY when the column was just added. The old code
  // ran a full-table UPDATE on every boot — a full scan of orders on every
  // deploy — even though every order written since has a token already.
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'orders' AND column_name = 'share_token') THEN
      ALTER TABLE orders ADD COLUMN share_token text;
      UPDATE orders SET share_token = substr(md5(random()::text || id::text), 1, 12)
        WHERE share_token IS NULL;
    END IF;
  END $$`);
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_share_token_key') THEN
      ALTER TABLE orders ADD CONSTRAINT orders_share_token_key UNIQUE (share_token);
    END IF;
  END $$`);
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_otp_hash text');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS pickup_otp text');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS fssai_license text');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_otp_plain text');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lat double precision');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_lng double precision');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_label text');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS opens_at text');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS closes_at text');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number text');
  await q(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_order_number_key') THEN
      ALTER TABLE orders ADD CONSTRAINT orders_order_number_key UNIQUE (order_number);
    END IF;
  END $$`);
  await q("ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type text NOT NULL DEFAULT 'delivery'");
  // b848 pickup: order_type gains 'pickup'. schema.sql's inline CHECK
  // (delivery/dinein only) is auto-named orders_order_type_check on live DBs;
  // drop + re-add so a pickup insert is not rejected with 23514.
  await q('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_order_type_check');
  await q(`ALTER TABLE orders ADD CONSTRAINT orders_order_type_check
    CHECK (order_type IN ('delivery','dinein','pickup'))`);
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
  // COD 'collected' status
  await q('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check');
  await q(`ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
    CHECK (payment_status IN ('pending','paid','failed','refunded','collected','refund_pending'))`);
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
  // Full rider registration (Swiggy/Zomato-style) — 2026-10-15
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS dob date');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS gender text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS email text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS address text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS aadhaar_front_photo text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS aadhaar_back_photo text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS pan_no text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS pan_photo text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS licence_photo text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS rc_photo text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS bank_account text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS ifsc text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS cancelled_cheque_photo text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS upi_id text');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS registration_step int NOT NULL DEFAULT 0');
  await q('ALTER TABLE riders ADD COLUMN IF NOT EXISTS registration_completed boolean NOT NULL DEFAULT false');
  await q('ALTER TABLE coupons ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()');
  await q('ALTER TABLE coupons ADD COLUMN IF NOT EXISTS requires_student boolean NOT NULL DEFAULT false');
  // Trip grouping for on-the-way multi-restaurant orders
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS trip_id uuid');
  await q('ALTER TABLE restaurant_applications ADD COLUMN IF NOT EXISTS aadhar text');
  await q('ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS aadhar text');

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


  // Trip-based rider payout (user 2026-10-15): is_primary + trip payout fields
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_primary BOOLEAN DEFAULT FALSE');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS trip_payout_paise INTEGER');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS trip_distance_km NUMERIC(8,2)');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS trip_intermediate_stops INTEGER DEFAULT 0');
  await q('ALTER TABLE orders ADD COLUMN IF NOT EXISTS trip_payout_breakdown JSONB');
  await q('CREATE INDEX IF NOT EXISTS orders_trip_id_idx ON orders(trip_id)');

  // Group orders (user 2026-10-18)
  await q(`CREATE TABLE IF NOT EXISTS group_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(8) UNIQUE NOT NULL,
    restaurant_id UUID NOT NULL REFERENCES restaurants(id),
    host_user_id UUID NOT NULL,
    host_name VARCHAR(100),
    status VARCHAR(20) DEFAULT 'open',
    created_at TIMESTAMPTZ DEFAULT now(),
    closed_at TIMESTAMPTZ
  )`);
  await q(`CREATE TABLE IF NOT EXISTS group_order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id UUID NOT NULL REFERENCES group_orders(id) ON DELETE CASCADE,
    dish_id UUID NOT NULL REFERENCES menu_items(id),
    qty INT NOT NULL DEFAULT 1,
    person_name VARCHAR(50) NOT NULL,
    added_at TIMESTAMPTZ DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_go_code ON group_orders(code)');
  await q('CREATE INDEX IF NOT EXISTS idx_goi_group ON group_order_items(group_id)');
  await q('ALTER TABLE group_order_items ADD COLUMN IF NOT EXISTS added_by_user_id uuid');

  // Push device tokens (FCM). One row per device token; re-login reassigns it.
  await q(`CREATE TABLE IF NOT EXISTS push_tokens (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role text NOT NULL,
    token text NOT NULL UNIQUE,
    platform text NOT NULL CHECK (platform IN ('android','ios','web')),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id)');

  // (Share-token backfill moved up to the column-add block above so it runs
  // only when the column is new — no per-boot full-table UPDATE anymore.)

  // Banner promotions (customer-app hero banners, managed no-code from admin).
  await q(`CREATE TABLE IF NOT EXISTS banner_promotions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
    title text NOT NULL,
    image_url text,
    starts_at timestamptz NOT NULL DEFAULT now(),
    ends_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_banner_promotions_restaurant ON banner_promotions(restaurant_id)');
  await q('CREATE INDEX IF NOT EXISTS idx_banner_promotions_active ON banner_promotions(starts_at, ends_at)');

  // Search events for trending: one row per submitted search, with the dish
  // ids shown in that search's results. search_count per dish/restaurant is
  // aggregated live (last 7 days) — no counters to keep in sync.
  await q(`CREATE TABLE IF NOT EXISTS search_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    query text NOT NULL,
    dish_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await q('CREATE INDEX IF NOT EXISTS idx_search_events_created ON search_events(created_at)');

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
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
    tax_rates: { food_pct: 5, delivery_pct: 18, platform_pct: 18 },
    otw_flat_fee_paise: 500,
    // Customer delivery fee tiers (user 2026-10-15, FINAL) — same values as
    // the loadPricingConfig() and GET /api/config fallbacks (50100/90100/
    // 130100). Seeded here so a fresh DB carries them as real config rows.
    customer_fee: {
      base_paise: 2000,
      base_km: 2,
      per_km_paise: 800,
      tiers: [
        { min_order_paise: 50100, free_km: 3 },
        { min_order_paise: 90100, free_km: 5 },
        { min_order_paise: 130100, free_km: 8 }
      ]
    },
    tip_min_paise: 1000,
    tip_max_paise: 50000,
    budget_threshold_paise: 15000,
    referral_reward_paise: 5000,
    prep_lead_minutes: 30,
    rider_payout_tiers: {
      slab1_up_to_km: 5,
      slab1_rate_paise_per_km: 800,   // 0-5 km: Rs 8/km
      slab2_up_to_km: 8,
      slab2_rate_paise_per_km: 900,   // 5-8 km: Rs 9/km on full distance
      slab3_base_km: 8,
      slab3_base_rate_paise_per_km: 800,  // 8+ km: first 8 km @ Rs 8/km
      slab3_extra_rate_paise_per_km: 1000 // + extra km @ Rs 10/km
    },
    platform_fee_paise: 700, // Rs 7
    default_commission_pct: 12,
    eta_minutes: 30,              // Honest ETA estimate shown to customers (not a guarantee)
    call_to_order_phone: ''       // support / phone-order line shown in the customer app
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
