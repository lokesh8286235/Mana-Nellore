-- Mana Nellore backend schema.
-- Auto-run on boot from src/db.js. All money is stored in paise (integers).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Users across all four apps. One phone number gets a SEPARATE profile per
-- role (portal) — a customer profile and a rider profile on the same phone
-- are two different users rows.
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  name text,
  role text NOT NULL CHECK (role IN ('customer','restaurant_owner','rider','admin')),
  password_hash text,
  lat double precision,
  lng double precision,
  dob date,
  is_student boolean NOT NULL DEFAULT false,
  referral_code text UNIQUE,
  referred_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (phone, role)
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lng double precision;
ALTER TABLE users ADD COLUMN IF NOT EXISTS veg_only boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS healthy_default boolean NOT NULL DEFAULT false;

-- OTP login codes (hashed, single-use, expiring)
CREATE TABLE IF NOT EXISTS otp_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(phone);

CREATE TABLE IF NOT EXISTS restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  address text,
  lat double precision,
  lng double precision,
  phone text,
  image_url text,
  fssai text,
  aadhar text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','suspended','rejected')),
  is_open boolean NOT NULL DEFAULT true,
  opens_at time,
  closes_at time,
  opens_at_we time,
  closes_at_we time,
  is_coming_soon boolean NOT NULL DEFAULT false,
  commission_pct numeric NOT NULL DEFAULT 12,
  rating_avg numeric NOT NULL DEFAULT 0,
  verified boolean NOT NULL DEFAULT false,
  chef_name text,
  chef_photo text,
  chef_story text,
  gstin text,
  birthday_dessert boolean NOT NULL DEFAULT false,
  cuisines text[] NOT NULL DEFAULT '{}',
  is_pure_veg boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order int NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  image_url text,
  price_paise int NOT NULL CHECK (price_paise >= 0),
  veg boolean NOT NULL DEFAULT false,
  available boolean NOT NULL DEFAULT true,
  prep_minutes int NOT NULL DEFAULT 20,
  sort_order int NOT NULL DEFAULT 0,
  meal_slot text[] NOT NULL DEFAULT '{all}'
    CHECK (meal_slot <@ ARRAY['all','breakfast','lunch','dinner']),
  is_combo boolean NOT NULL DEFAULT false,
  allergens jsonb NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_menu_restaurant ON menu_items(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_menu_rest_veg_avail ON menu_items(restaurant_id, available, veg);

CREATE TABLE IF NOT EXISTS addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label text,
  line1 text,
  line2 text,
  city text NOT NULL DEFAULT 'Nellore',
  lat double precision,
  lng double precision,
  is_default boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);

CREATE TABLE IF NOT EXISTS riders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vehicle_type text,
  vehicle_number text,
  licence_no text,
  aadhaar_no text,
  aadhaar_photo text,
  profile_photo text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','suspended','rejected')),
  online boolean NOT NULL DEFAULT false,
  lat double precision,
  lng double precision,
  rating_avg numeric NOT NULL DEFAULT 0,
  cancelled_deliveries int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  rider_id uuid REFERENCES riders(id) ON DELETE SET NULL,
  address_id uuid REFERENCES addresses(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'placed'
    CHECK (status IN ('placed','accepted','rejected','preparing','ready',
                      'picked_up','on_way','delivered','cancelled',
                      'scheduled','confirmed')),
  subtotal_paise int NOT NULL,
  discount_paise int NOT NULL DEFAULT 0,
  delivery_fee_paise int NOT NULL DEFAULT 0,
  platform_fee_paise int NOT NULL DEFAULT 0,
  tax_paise int NOT NULL DEFAULT 0,
  commission_paise int NOT NULL DEFAULT 0,
  total_paise int NOT NULL,
  payment_method text,
  payment_status text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending','paid','failed','refunded','collected')),
  delivery_otp_hash text,
  delivery_otp text,
  cancel_reason text,
  timeline jsonb NOT NULL DEFAULT '[]',
  placed_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  eta_at timestamptz,
  packed_at timestamptz,
  pickup_photo text,
  delivery_photo text,
  share_token text UNIQUE,
  order_type text NOT NULL DEFAULT 'delivery'
    CHECK (order_type IN ('delivery','dinein')),
  table_id uuid,
  delivery_note text,
  no_cutlery boolean NOT NULL DEFAULT false,
  tip_paise int NOT NULL DEFAULT 0,
  recipient_name text,
  recipient_phone text,
  -- Scheduled ordering: the customer-chosen delivery time (NULL for ASAP
  -- orders) and whether the restaurant pre-accepted while still scheduled.
  scheduled_for timestamptz,
  pre_accepted boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_orders_rest_status ON orders(restaurant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_rest_packed ON orders(restaurant_id, placed_at) WHERE packed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_rider ON orders(rider_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
-- Scheduled-order activation probe: due 'scheduled' rows by time.
CREATE INDEX IF NOT EXISTS idx_orders_status_scheduled ON orders(status, scheduled_for);

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id uuid REFERENCES menu_items(id) ON DELETE SET NULL,
  name_snapshot text NOT NULL,
  unit_price_paise int NOT NULL,
  qty int NOT NULL CHECK (qty > 0),
  instructions text
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS rider_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  order_id uuid UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_paise int NOT NULL,
  distance_km numeric,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  gross_paise int NOT NULL,
  commission_paise int NOT NULL,
  refunds_paise int NOT NULL DEFAULT 0,
  net_paise int NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text UNIQUE NOT NULL,
  discount_type text NOT NULL CHECK (discount_type IN ('flat','percent')),
  value int NOT NULL,
  min_order_paise int NOT NULL DEFAULT 0,
  max_discount_paise int,
  valid_from timestamptz,
  valid_to timestamptz,
  active boolean NOT NULL DEFAULT true,
  requires_student boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Customer memory: favorites + coupon issuances survive phone changes/reinstalls.
CREATE TABLE IF NOT EXISTS favorites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('restaurant','dish')),
  entity_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_favorites_customer ON favorites(customer_id);

CREATE TABLE IF NOT EXISTS coupon_issuances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  coupon_code text NOT NULL,
  source text,
  issued_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, coupon_code)
);
CREATE INDEX IF NOT EXISTS idx_coupon_issuances_user ON coupon_issuances(user_id);

CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  category text,
  subject text,
  message text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','resolved','closed')),
  resolution_note text,
  photo_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON support_tickets(status);

CREATE TABLE IF NOT EXISTS ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  rater_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ratee_type text NOT NULL CHECK (ratee_type IN ('restaurant','rider')),
  ratee_id uuid NOT NULL,
  food_rating int CHECK (food_rating BETWEEN 1 AND 5),
  delivery_rating int CHECK (delivery_rating BETWEEN 1 AND 5),
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Single source of truth for all pricing rules; admin edits apply instantly.
CREATE TABLE IF NOT EXISTS pricing_config (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);

-- Rider quests/incentives configured by admin
CREATE TABLE IF NOT EXISTS quests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  target_deliveries int NOT NULL CHECK (target_deliveries > 0),
  bonus_paise int NOT NULL CHECK (bonus_paise >= 0),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Quest bonuses awarded to riders (one per rider per quest).
-- quest_id is SET NULL (not CASCADE) on quest delete so earned bonuses survive.
CREATE TABLE IF NOT EXISTS rider_bonuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  quest_id uuid REFERENCES quests(id) ON DELETE SET NULL,
  amount_paise int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rider_id, quest_id)
);
CREATE INDEX IF NOT EXISTS idx_bonuses_rider ON rider_bonuses(rider_id);

-- Customer food-photo reviews
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS photo_url text;

-- Restaurant onboarding applications (in-app apply -> admin approval -> activation)
CREATE TABLE IF NOT EXISTS restaurant_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_name text NOT NULL,
  owner_name text NOT NULL,
  phone text NOT NULL,
  address text,
  lat double precision,
  lng double precision,
  fssai text,
  photo_url text NOT NULL,
  aadhar text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  admin_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_applications_status ON restaurant_applications(status);

-- "Call me back" support requests
CREATE TABLE IF NOT EXISTS callback_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone text,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  reason text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','done')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_callbacks_status ON callback_requests(status);

-- "Notify me when open" alerts
CREATE TABLE IF NOT EXISTS restaurant_open_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, restaurant_id)
);

-- Curated collections (Taste of Nellore, festival specials, ...)
CREATE TABLE IF NOT EXISTS collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  image_url text,
  active boolean NOT NULL DEFAULT true,
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS collection_restaurants (
  collection_id uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, restaurant_id)
);

-- Dine-in tables (QR ordering)
CREATE TABLE IF NOT EXISTS tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  label text NOT NULL,
  qr_token text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tables_restaurant ON tables(restaurant_id);
-- NOTE: the orders.table_id foreign key is added in migrate() (db.js), AFTER
-- the table_id column itself is added — it cannot live here because on an
-- existing database the column does not exist yet when the schema runs.

-- Rider COD cash ledger (cash collected at the door, pending settlement)
CREATE TABLE IF NOT EXISTS rider_cod_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id uuid NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
  order_id uuid UNIQUE NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  amount_paise int NOT NULL,
  settled boolean NOT NULL DEFAULT false,
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cod_rider ON rider_cod_ledger(rider_id);

-- Student discount applications (college ID -> admin approval -> is_student)
CREATE TABLE IF NOT EXISTS student_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id_photo text NOT NULL,
  college text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Image store: photo bytes live here ONCE; API JSON only carries /img/<hash>.
-- Keeps restaurant-list and menu payloads tiny at 1000+ restaurants.
CREATE TABLE IF NOT EXISTS images (
  hash text PRIMARY KEY,
  data bytea NOT NULL,
  mime text NOT NULL DEFAULT 'image/jpeg',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Pending customer registrations (password flow): staged here until OTP is verified.
-- Registration expires after 10 minutes; verify-register promotes to users.
CREATE TABLE IF NOT EXISTS pending_registrations (
  phone text PRIMARY KEY,
  name text NOT NULL,
  password_hash text NOT NULL,
  address text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

-- On-the-way anti-scam audit trail: every secondary-restaurant discount
-- decision at placement (granted / stripped / rejected), plus service-area
-- determinations. The founder reviews scam attempts from the admin panel.
CREATE TABLE IF NOT EXISTS otw_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  event text NOT NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  customer_id uuid,
  primary_restaurant_id uuid,
  secondary_restaurant_id uuid,
  address_id uuid,
  fee_charged_paise int,
  fee_full_paise int,
  reason text,
  meta jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_otw_audit_created ON otw_audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otw_audit_customer ON otw_audit_log(customer_id);
