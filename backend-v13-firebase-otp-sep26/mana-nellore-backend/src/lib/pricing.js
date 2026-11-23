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
      slab3_extra_rate_paise_per_km: 800
    },
    // Trip-based rider payout (user 2026-10-15): flat base + per-km + per intermediate stop
    tripPayout: m.trip_payout || {
      base_paise: 2000,           // Rs 20 for first 2km
      base_km: 2,
      per_km_paise: 800,          // Rs 8/km beyond base
      per_intermediate_stop_paise: 500  // Rs 5 per intermediate restaurant
    },
    // Customer delivery fee with free-km tiers (user 2026-10-15, FINAL)
    customerFee: m.customer_fee || {
      base_paise: 2000,  // Rs 20 for first 2km (below Rs 501)
      base_km: 2,
      per_km_paise: 800,  // Rs 8/km
      tiers: [
        { min_order_paise: 50100, free_km: 3 },   // Rs 501+: 3km free
        { min_order_paise: 90100, free_km: 5 },   // Rs 901+: 5km free
        { min_order_paise: 130100, free_km: 8 }   // Rs 1301+: 8km free
      ]
    },
    platformFeePaise: Number(m.platform_fee_paise != null ? m.platform_fee_paise : 700),
    defaultCommissionPct: Number(
      m.default_commission_pct != null ? m.default_commission_pct : 12
    ),
    // Honest ETA estimate shown to customers ("Usually ~X min") — NOT a delivery promise.
    etaMinutes: Number(m.eta_minutes != null ? m.eta_minutes : 30),
    // On-the-way secondary fee: flat amount in paise (user-dictated 2026-10-13).
    otwFlatFeePaise: Number(m.otw_flat_fee_paise != null ? m.otw_flat_fee_paise : 500),
    // Tip caps (user 2026-10-20): backend-driven via pricing_config keys
    // 'tip_min_paise' / 'tip_max_paise', same values GET /api/config exposes.
    // Order placement clamps the client-sent tip to tipMaxPaise.
    tipMinPaise: Number(m.tip_min_paise != null ? m.tip_min_paise : 1000),
    tipMaxPaise: Number(m.tip_max_paise != null ? m.tip_max_paise : 50000),
    // GST rates (user rule: food 5%, delivery 18%, platform 18%) — backend-driven
    // via pricing_config key 'tax_rates', admin-editable, exposed on GET /api/config.
    // Accepts both food_pct and food_gst_pct namings (the live row predates this
    // change and uses *_gst_pct); always normalized to food/delivery/platform_pct.
    taxRates: normalizeTaxRates(m.tax_rates),
  };
}

// Marginal tiers: 0-3 km @ Rs 10/km, 3-8 km @ Rs 9/km, 8+ km @ Rs 8/km.
// Legacy list fee only (on-the-way normal-fee reference). The customer delivery
// fee is customerDeliveryFeePaise (Rs 20 base + Rs 8/km + free-km tiers).
function deliveryFeePaise(tiers, distanceKm) {
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

// Customer delivery fee with free-km tiers (user 2026-10-15, FINAL).
// Below Rs 501: Rs 20 base (first 2km) + Rs 8/km beyond
// Rs 501+: first 3km free, Rs 8/km after (no base fee)
// Rs 901+: first 5km free, Rs 8/km after
// Rs 1301+: first 8km free, Rs 8/km after
// Config: customerFee { base_paise, base_km, per_km_paise, tiers: [{min_order_paise, free_km}] }
// Returns { fee_paise, free_km, next_tier } where next_tier helps the upsell nudge.
function customerDeliveryFeePaise(cfg, distanceKm, orderValuePaise) {
  const km = Number(distanceKm) || 0;
  const orderPaise = Number(orderValuePaise) || 0;
  const basePaise = Number(cfg.base_paise);
  const baseKm = Number(cfg.base_km);
  const perKmPaise = Number(cfg.per_km_paise);
  const tiers = Array.isArray(cfg.tiers) ? cfg.tiers : [];

  // Find the highest tier the order qualifies for
  let freeKm = 0;
  let nextTier = null;
  const sorted = tiers.slice().sort((a, b) => Number(a.min_order_paise) - Number(b.min_order_paise));
  for (const t of sorted) {
    if (orderPaise >= Number(t.min_order_paise)) {
      freeKm = Number(t.free_km);
    } else if (!nextTier) {
      nextTier = t;
    }
  }

  let fee;
  if (freeKm > 0) {
    // Tier qualified: free km, then per-km rate (no base fee)
    fee = Math.round(Math.max(0, km - freeKm) * perKmPaise);
  } else {
    // Below first tier: base fee covers first base_km, then per-km
    fee = basePaise + Math.round(Math.max(0, km - baseKm) * perKmPaise);
  }

  return {
    fee_paise: fee,
    free_km: freeKm,
    next_tier: nextTier ? {
      min_order_paise: Number(nextTier.min_order_paise),
      free_km: Number(nextTier.free_km),
      amount_needed_paise: Math.max(0, Number(nextTier.min_order_paise) - orderPaise)
    } : null
  };
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

// Normalize a tax_rates value to { food_pct, delivery_pct, platform_pct }.
function normalizeTaxRates(t) {
  const r = t || {};
  const pick = (a, b, d) => Number(r[a] != null ? r[a] : r[b] != null ? r[b] : d);
  return {
    food_pct: pick('food_pct', 'food_gst_pct', 5),
    delivery_pct: pick('delivery_pct', 'delivery_gst_pct', 18),
    platform_pct: pick('platform_pct', 'platform_gst_pct', 18)
  };
}

// GST (user rule, component-wise): food 5% on net items, delivery 18% on the
// delivery fee, platform 18% on the platform fee. Per-component rounding to
// paise, then summed. Rates come from config.taxRates (pricing_config key
// 'tax_rates'); defaults match the user rule.
function computeTax(taxRates, netPaise, deliveryFeePaise, platformFeePaise) {
  const rates = taxRates || {};
  const foodPct = Number(rates.food_pct != null ? rates.food_pct : 5);
  const deliveryPct = Number(rates.delivery_pct != null ? rates.delivery_pct : 18);
  const platformPct = Number(rates.platform_pct != null ? rates.platform_pct : 18);
  const foodPaise = Math.round((Math.max(0, Number(netPaise) || 0) * foodPct) / 100);
  const deliveryTaxPaise = Math.round(((Number(deliveryFeePaise) || 0) * deliveryPct) / 100);
  const platformTaxPaise = Math.round(((Number(platformFeePaise) || 0) * platformPct) / 100);
  return {
    taxPaise: foodPaise + deliveryTaxPaise + platformTaxPaise,
    breakdown: { food_paise: foodPaise, delivery_paise: deliveryTaxPaise, platform_paise: platformTaxPaise }
  };
}

function computeQuote({ config, distanceKm, subtotalPaise, discountPaise = 0, commissionPct, deliveryFeePaiseOverride, platformFeePaiseOverride }) {
  const net = subtotalPaise - discountPaise;
  // If distance unknown, use base fee from config (never null — DB requires it)
  const baseFee = Number(config.customerFee && config.customerFee.base_paise) || 2000;
  // FINAL fee model (user 2026-10-15): free-km tiers by order value, Rs 8/km beyond.
  // This matches what the checkout nudge advertises — the bill must equal the promise.
  // deliveryFeePaiseOverride (e.g. 0 for dine-in / pickup) and
  // platformFeePaiseOverride (e.g. 0 for pickup) charge GST on the fees
  // actually charged, never on a fee that was waived.
  const deliveryFee =
    deliveryFeePaiseOverride != null
      ? deliveryFeePaiseOverride
      : distanceKm == null
        ? baseFee
        : customerDeliveryFeePaise(config.customerFee, distanceKm, net).fee_paise;
  const platformFeePaise = platformFeePaiseOverride != null ? platformFeePaiseOverride : config.platformFeePaise;
  const pct = commissionPct != null ? Number(commissionPct) : config.defaultCommissionPct;
  const commissionPaise = Math.round((net * pct) / 100);
  const payout =
    distanceKm == null ? null : riderPayoutPaise(config.riderPayout, distanceKm);
  const tax = computeTax(config.taxRates, net, deliveryFee, platformFeePaise);
  return {
    deliveryFeePaise: deliveryFee,
    platformFeePaise,
    taxPaise: tax.taxPaise,
    taxBreakdown: tax.breakdown,
    commissionPaise,
    riderPayoutPaise: payout,
    // NOTE: totalPaise deliberately EXCLUDES tip. The tip is a rider gratuity
    // added on top, not part of the priced quote: the quote-bill and the
    // place-breakdown totals add tipPaise to this value themselves
    // (total_paise = totalPaise + tipPaise). Do not "fix" this by adding tip
    // here — it would double-count the tip in every bill.
    totalPaise: net + deliveryFee + platformFeePaise + tax.taxPaise
  };
}

module.exports = {
  haversineKm,
  loadPricingConfig,
  deliveryFeePaise,
  customerDeliveryFeePaise,
  riderPayoutPaise,
  tripPayoutPaise,
  otwSecondaryFeePaise,
  computeTax,
  normalizeTaxRates,
  computeQuote
};
