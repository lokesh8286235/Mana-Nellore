// PostgreSQL connection pool + boot-time schema run + seeding.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function query(text, params) {
  return pool.query(text, params);
}

async function initDb() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  await seed();
  console.log('Database ready');
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
    }
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
       ON CONFLICT (phone) DO UPDATE
         SET role = 'admin', password_hash = EXCLUDED.password_hash`,
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
}

module.exports = { pool, query, initDb };
