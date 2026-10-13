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
    // Honest ETA estimate shown to customers ("Usually ~X min") — NOT a delivery promise.
    etaMinutes: Number(m.eta_minutes != null ? m.eta_minutes : 30),
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

// On-the-way secondary detour fee: 20% of the tier-priced detour distance.
// The detour is how far the secondary restaurant sits off the primary→customer
// route line. The 20% discount applies to the detour cost itself — a restaurant
// 100m off-route pays less than one 500m off-route. Free-delivery rules never
// apply to the detour — it's extra service on top of the main delivery.
// Per-km rate comes from deliveryTiers (first tier covers all detours, which
// are ≤ 0.5km by the on-route definition).
function otwDetourFeePaise(config, detourKm) {
  const d = Math.max(0, Number(detourKm) || 0);
  const detourCost = deliveryFeePaise(config.deliveryTiers, d, 0, []);
  return Math.round(detourCost * 0.2);
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
  otwDetourFeePaise,
  computeQuote
};
