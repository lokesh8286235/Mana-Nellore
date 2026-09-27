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
  // COD 'collected' status
  await q('ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check');
  await q(`ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
    CHECK (payment_status IN ('pending','paid','failed','refunded','collected'))`);
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
