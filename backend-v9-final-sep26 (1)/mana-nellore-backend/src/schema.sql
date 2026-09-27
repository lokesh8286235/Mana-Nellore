-- Mana Nellore backend schema.
-- Auto-run on boot from src/db.js. All money is stored in paise (integers).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Users across all four apps (role decides which portal they can use)
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone text UNIQUE NOT NULL,
  name text,
  role text NOT NULL CHECK (role IN ('customer','restaurant_owner','rider','admin')),
  password_hash text,
  lat double precision,
  lng double precision,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS lat double precision;
ALTER TABLE users ADD COLUMN IF NOT EXISTS lng double precision;

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
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','suspended','rejected')),
  is_open boolean NOT NULL DEFAULT true,
  opens_at time,
  closes_at time,
  commission_pct numeric NOT NULL DEFAULT 12,
  rating_avg numeric NOT NULL DEFAULT 0,
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
  sort_order int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_menu_restaurant ON menu_items(restaurant_id);

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
                      'picked_up','on_way','delivered','cancelled')),
  subtotal_paise int NOT NULL,
  discount_paise int NOT NULL DEFAULT 0,
  delivery_fee_paise int NOT NULL DEFAULT 0,
  platform_fee_paise int NOT NULL DEFAULT 0,
  tax_paise int NOT NULL DEFAULT 0,
  commission_paise int NOT NULL DEFAULT 0,
  total_paise int NOT NULL,
  payment_method text,
  payment_status text NOT NULL DEFAULT 'pending'
    CHECK (payment_status IN ('pending','paid','failed','refunded')),
  delivery_otp_hash text,
  cancel_reason text,
  timeline jsonb NOT NULL DEFAULT '[]',
  placed_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  promised_at timestamptz,
  pickup_photo text,
  credits_used_paise int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX IF NOT EXISTS idx_orders_rider ON orders(rider_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

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
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  category text,
  subject text,
  message text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','in_progress','resolved','closed')),
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

-- Delivery zones: each zone has its own delivery-promise time (minutes).
-- The zone flagged is_default is used when no Maps-based zone matching is
-- available. At least one zone must exist; seed a default on first boot.
CREATE TABLE IF NOT EXISTS zones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  promise_minutes int NOT NULL DEFAULT 30 CHECK (promise_minutes > 0),
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity text,
  entity_id text,
  meta jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

-- Customer credit ledger (grants +, spends -). Powers the 30-minute promise
-- auto-credit and the cold-food apology credit. All money in paise.
CREATE TABLE IF NOT EXISTS customer_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_paise int NOT NULL,
  reason text NOT NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credits_user ON customer_credits(user_id);

-- Item customizations (e.g. "Spice Level": Mild/Medium/Spicy, "Add-ons": Extra Cheese +₹30)
CREATE TABLE IF NOT EXISTS customization_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_item_id uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  max_select int NOT NULL DEFAULT 1,
  sort int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS customization_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES customization_groups(id) ON DELETE CASCADE,
  name text NOT NULL,
  price_paise int NOT NULL DEFAULT 0,
  sort int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cust_groups_item ON customization_groups(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_cust_opts_group ON customization_options(group_id);

-- Fingerprint (WebAuthn) credentials for rider login
CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);

-- Single-use WebAuthn challenges (5-minute expiry)
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge text PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  expires_at timestamptz NOT NULL
);
