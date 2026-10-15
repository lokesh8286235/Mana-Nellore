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

async function loadPricingConfig(db) {
  const { rows } = await db.query('SELECT key, value FROM pricing_config');
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    deliveryTiers:
      (m.delivery_tiers && m.delivery_tiers.tiers) || [
        { up_to_km: 3, rate_paise_per_km: 1000 },
        { up_to_km: 8, rate_paise_per_km: 900 },
        { up_to_km: null, rate_paise_per_km: 900 }
      ],
    riderPayout: m.rider_payout_tiers || {
      slab1_up_to_km: 5,
      slab1_rate_paise_per_km: 800,
      slab2_up_to_km: 8,
      slab2_rate_paise_per_km: 900,
      slab3_base_km: 8,
      slab3_base_rate_paise_per_km: 800,
      slab3_extra_rate_paise_per_km: 800
    },
    // Trip-based rider payout (user 2026-10-15): flat base + per-km + per intermediate stop
    tripPayout: m.trip_payout || {
      base_paise: 2000,           // Rs 20 for first 2km
      base_km: 2,
      per_km_paise: 800,          // Rs 8/km beyond base
      per_intermediate_stop_paise: 500  // Rs 5 per intermediate restaurant
    },
    platformFeePaise: Number(m.platform_fee_paise != null ? m.platform_fee_paise : 800),
    defaultCommissionPct: Number(
      m.default_commission_pct != null ? m.default_commission_pct : 12
    ),
    freeDeliveryRules:
      (m.free_delivery_rules && m.free_delivery_rules.rules) || [],
    // Honest ETA estimate shown to customers ("Usually ~X min") — NOT a delivery promise.
    etaMinutes: Number(m.eta_minutes != null ? m.eta_minutes : 30),
    // On-the-way secondary fee: flat amount in paise (user-dictated 2026-10-13).
    otwFlatFeePaise: Number(m.otw_flat_fee_paise != null ? m.otw_flat_fee_paise : 500),
  };
}

// Marginal tiers: 0-3 km @ Rs 10/km, 3-8 km @ Rs 9/km, 8+ km @ Rs 9/km.
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

// Trip-based rider payout (user 2026-10-15, FINAL).
// Formula: base_paise (first base_km) + per_km_paise * max(0, totalKm - base_km) + per_intermediate_stop_paise * intermediateStops
// Returns { payout_paise, breakdown } where breakdown has base, distance, stops components.
function tripPayoutPaise(cfg, totalKm, intermediateStops) {
  const basePaise = Number(cfg.base_paise);
  const baseKm = Number(cfg.base_km);
  const perKmPaise = Number(cfg.per_km_paise);
  const perStopPaise = Number(cfg.per_intermediate_stop_paise);
  const km = Number(totalKm) || 0;
  const stops = Math.max(0, Math.floor(Number(intermediateStops) || 0));
  const extraKm = Math.max(0, km - baseKm);
  const basePart = basePaise;
  const distancePart = Math.round(extraKm * perKmPaise);
  const stopsPart = stops * perStopPaise;
  const total = basePart + distancePart + stopsPart;
  return {
    payout_paise: total,
    breakdown: {
      base_paise: basePart,
      base_km: baseKm,
      extra_km: Math.round(extraKm * 100) / 100,
      distance_paise: distancePart,
      per_km_paise: perKmPaise,
      intermediate_stops: stops,
      stops_paise: stopsPart,
      per_stop_paise: perStopPaise,
      total_km: Math.round(km * 100) / 100
    }
  };
}

// On-the-way secondary delivery fee (user-dictated 2026-10-13).
// Flat fee from config (otw_flat_fee_paise, default 500 paise = Rs 5).
// "On the way" = within 500m of the primary→customer route line — enforced by
// the caller (discovery only lists ≤500m; order placement removes the rest).
// Restaurants beyond 500m are never offered as on-the-way options.
// Free-delivery rules never apply to secondaries — no silent freebies.
function otwSecondaryFeePaise(normalFeePaise, config) {
  if (normalFeePaise == null) return null;
  const flat = Number(config && config.otwFlatFeePaise != null ? config.otwFlatFeePaise : 500);
  return Math.round(flat);
}

function computeQuote({ config, distanceKm, subtotalPaise, discountPaise = 0, commissionPct }) {
  const net = subtotalPaise - discountPaise;
  // No hardcoded fallback: if distance unknown, fee is null (frontend hides it)
  const deliveryFee =
    distanceKm == null
      ? null
      : deliveryFeePaise(config.deliveryTiers, distanceKm, net, config.freeDeliveryRules);
  const platformFeePaise = config.platformFeePaise;
  const pct = commissionPct != null ? Number(commissionPct) : config.defaultCommissionPct;
  const commissionPaise = Math.round((net * pct) / 100);
  const payout =
    distanceKm == null ? null : riderPayoutPaise(config.riderPayout, distanceKm);
  return {
    deliveryFeePaise: deliveryFee,
    platformFeePaise,
    taxPaise: 0,
    commissionPaise,
    riderPayoutPaise: payout,
    totalPaise: net + deliveryFee + platformFeePaise
  };
}

module.exports = {
  haversineKm,
  loadPricingConfig,
  deliveryFeePaise,
  riderPayoutPaise,
  tripPayoutPaise,
  otwSecondaryFeePaise,
  computeQuote
};
