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
    promiseMinutes: Number(m.promise_minutes != null ? m.promise_minutes : 30),
    apologyCreditPaise: Number(
      m.apology_credit_paise != null ? m.apology_credit_paise : 5000
    )
  };
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

function computeQuote({ config, distanceKm, subtotalPaise, discountPaise = 0, commissionPct }) {
  const net = subtotalPaise - discountPaise;
  const deliveryFee =
    distanceKm == null
      ? 2500 // fallback Rs 25 when locations are unknown
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
  computeQuote
};
