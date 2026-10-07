// Pricing engine — the single source of truth for all money math.
// Everything is driven by pricing_config rows so admin edits apply instantly.
// All money in paise (integers). No floats anywhere.

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371; // earth radius in km
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Pricing config changes rarely (admin edits). Cache in memory for 60s to
// avoid a DB round trip on every quote and placement. Admin changes apply
// within a minute — acceptable for pricing.
let _pricingCache = null;
let _pricingCacheAt = 0;
const PRICING_CACHE_TTL_MS = 60000;

async function loadPricingConfig(db) {
  const now = Date.now();
  if (_pricingCache && now - _pricingCacheAt < PRICING_CACHE_TTL_MS) {
    return _pricingCache;
  }
  const { rows } = await db.query('SELECT key, value FROM pricing_config');
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const cfg = {
    deliveryTiers:
      (m.delivery_tiers && m.delivery_tiers.tiers) || [
        { up_to_km: 3, rate_paise_per_km: 1000 },
        { up_to_km: 8, rate_paise_per_km: 900 },
        { up_to_km: null, rate_paise_per_km: 800 }
      ],
    riderPayout: m.rider_payout_tiers || {
      slab1_up_to_km: 5,
      slab1_rate_paise_per_km: 800,
      slab2_up_to_km: 8,
      slab2_rate_paise_per_km: 900,
      slab3_base_km: 8,
      slab3_base_rate_paise_per_km: 800,
      slab3_extra_rate_paise_per_km: 1000
    },
    platformFeePaise: Number(m.platform_fee_paise != null ? m.platform_fee_paise : 800),
    defaultCommissionPct: Number(
      m.default_commission_pct != null ? m.default_commission_pct : 12
    ),
    freeDeliveryRules:
      (m.free_delivery_rules && m.free_delivery_rules.rules) || [],
    // Honest ETA estimate shown to customers ("Usually ~X min") — NOT a delivery promise.
    etaMinutes: Number(m.eta_minutes != null ? m.eta_minutes : 30),
    // GST rates (%) charged on the customer bill. Backend-driven: the admin
    // Pricing screen edits these, the customer app fetches them via /api/config.
    taxRates: normalizeTaxRates(m.tax_rates),
    // Flat rider bonus per extra on-the-way pickup stop (beyond the primary).
    // Falls back to ₹15 when the key is absent — no migration needed.
    riderPayoutExtraStopPaise: Number(
      m.rider_payout_extra_stop_paise != null ? m.rider_payout_extra_stop_paise : 1500
    ),
    // Fallback distance (km) used for delivery-fee calculation when restaurant
    // or address coordinates are missing. The fee is still computed via the
    // admin-configurable delivery tiers — never a hardcoded rupee value.
    // Default 5km is a sensible Nellore average; admin can tune via pricing_config.
    fallbackDistanceKm: Number(
      m.fallback_distance_km != null ? m.fallback_distance_km : 5
    ),
  };
  _pricingCache = cfg;
  _pricingCacheAt = Date.now();
  return cfg;
}

// Defensive normalization for the tax_rates pricing_config value.
// Never throws; falls back to the founder's rates on bad data.
function normalizeTaxRates(v) {
  const d = { food_gst_pct: 5, delivery_gst_pct: 18, platform_gst_pct: 18 };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...d };
  const out = {};
  for (const k of Object.keys(d)) {
    const n = Number(v[k]);
    out[k] = v[k] == null || !Number.isFinite(n) || n < 0 ? d[k] : n;
  }
  return out;
}

// Component-wise GST, each component rounded to paise then summed.
// Matches the customer app's bill math so displayed and charged totals agree.
function computeGstPaise(taxRates, { foodPaise, deliveryPaise, platformPaise }) {
  const r = normalizeTaxRates(taxRates);
  const g = (base, pct) => Math.round((Number(base) || 0) * pct / 100);
  const food = g(foodPaise, r.food_gst_pct);
  const delivery = g(deliveryPaise, r.delivery_gst_pct);
  const platform = g(platformPaise, r.platform_gst_pct);
  return { food, delivery, platform, total: food + delivery + platform, rates: r };
}

// Marginal tiers: 0-3 km @ Rs 10/km, 3-8 km @ Rs 9/km, 8+ km @ Rs 8/km.
// Free-delivery rules (order value + distance) zero the fee when matched.
function deliveryFeePaise(tiers, distanceKm, orderValuePaise, freeRules) {
  if (
    Array.isArray(freeRules) &&
    freeRules.some(
      (r) =>
        orderValuePaise >= Number(r.min_order_paise) &&
        distanceKm <= Number(r.max_distance_km)
    )
  ) {
    return 0;
  }
  let fee = 0;
  let prev = 0;
  for (const t of tiers) {
    const upTo = t.up_to_km == null ? Infinity : Number(t.up_to_km);
    const kmInTier = Math.max(0, Math.min(distanceKm, upTo) - prev);
    fee += kmInTier * Number(t.rate_paise_per_km);
    prev = upTo;
    if (distanceKm <= upTo) break;
  }
  return Math.round(fee);
}

// Rider payout: 0-5 km Rs 8/km; 5-8 km Rs 9/km on full distance;
// 8+ km: first 8 km @ Rs 8/km + extra km @ Rs 10/km.
function riderPayoutPaise(cfg, distanceKm) {
  const d = Number(distanceKm);
  if (d <= Number(cfg.slab1_up_to_km)) {
    return Math.round(d * Number(cfg.slab1_rate_paise_per_km));
  }
  if (d <= Number(cfg.slab2_up_to_km)) {
    return Math.round(d * Number(cfg.slab2_rate_paise_per_km));
  }
  const baseKm = Number(cfg.slab3_base_km);
  return Math.round(
    baseKm * Number(cfg.slab3_base_rate_paise_per_km) +
      (d - baseKm) * Number(cfg.slab3_extra_rate_paise_per_km)
  );
}

function computeQuote({ config, distanceKm, subtotalPaise, discountPaise = 0, commissionPct, taxRates, gstFoodBasePaise }) {
  const net = subtotalPaise - discountPaise;
  // When locations are unknown, estimate via the tier engine at the
  // admin-configurable fallback distance — never a hardcoded rupee value.
  const effDist = distanceKm == null ? (Number(config.fallbackDistanceKm) || 5) : distanceKm;
  const deliveryFee = deliveryFeePaise(config.deliveryTiers, effDist, net, config.freeDeliveryRules);
  const platformFeePaise = config.platformFeePaise;
  const pct = commissionPct != null ? Number(commissionPct) : config.defaultCommissionPct;
  const commissionPaise = Math.round((net * pct) / 100);
  const payout =
    distanceKm == null ? null : riderPayoutPaise(config.riderPayout, distanceKm);
  // GST is charged on the customer bill at backend-driven rates. The food base
  // is the pre-discount subtotal, matching the customer app's bill math so the
  // displayed total and the charged total agree to the paise.
  const gst = computeGstPaise(
    taxRates || config.taxRates,
    {
      foodPaise: gstFoodBasePaise != null ? gstFoodBasePaise : subtotalPaise,
      deliveryPaise: deliveryFee,
      platformPaise: platformFeePaise
    }
  );
  return {
    deliveryFeePaise: deliveryFee,
    platformFeePaise,
    taxPaise: gst.total,
    gstBreakdown: gst,
    commissionPaise,
    riderPayoutPaise: payout,
    totalPaise: net + deliveryFee + platformFeePaise + gst.total
  };
}

module.exports = {
  haversineKm,
  loadPricingConfig,
  normalizeTaxRates,
  computeGstPaise,
  deliveryFeePaise,
  riderPayoutPaise,
  computeQuote
};
