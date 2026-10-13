// On-the-way marginal-cost pricing.
// For a customer order from restaurant X, home at Z, candidate middle
// restaurant Y:
//
//   true_detour_km = road_distance(X→Y→Z) − road_distance(X→Z)
//
// Y is shown only if true_detour_km ≤ threshold (default 0.5km). The fee is:
//   20% × (true_detour_km × per_km_rate)
//
// This is the TRUE extra riding cost — not a straight-line estimate.
// Road routes come from Google's Routes API (v2:computeRoutes) server-side.
//
// PERFORMANCE: the entire calculation must complete in < 1 second.
// Strategy:
//   - Pre-filter to top 3 candidates by straight-line distance (no API)
//   - Haversine shortcut: straight-line detour < 100m → skip API, use
//     haversine × 1.3 road factor
//   - Parallel API calls via Promise.all (D0 + all D1 at once)
//   - 800ms hard timeout → fall back to haversine estimates
//   - LRU cache: D0 per (X,Z), D1 per (X,Y,Z), 1-hour TTL, max 500 entries
//
// Fallback: if the Routes API fails or Y has no coordinates, callers fall
// back to the straight-line 500m filter + 20% of Y→Z fee. The order flow
// never breaks.

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_CACHE_ENTRIES = 500;
const HAVERSINE_SHORTCUT_M = 100; // <100m straight-line → skip API
const ROAD_FACTOR = 1.3; // haversine × 1.3 ≈ road distance for short detours
const API_TIMEOUT_MS = 800; // hard cap for all API calls combined

// In-memory LRU cache: key -> { at, km }
const cache = new Map();

function cacheGet(key, ttlMs) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.km;
}

function cacheSet(key, km) {
  cache.delete(key);
  cache.set(key, { at: Date.now(), km });
  if (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

function coordKey(p) {
  return `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Single route distance via Routes API. Returns null on failure.
// Uses cache; respects the global API timeout via the caller's race.
async function routeDistanceKm(origin, destination, waypoints, gkey) {
  if (!gkey) return null;
  const key = ['D', coordKey(origin), coordKey(destination), (waypoints || []).map(coordKey).join('|')].join('>');
  const hit = cacheGet(key, DEFAULT_TTL_MS);
  if (hit != null) return hit;

  const latLng = (p) => ({ latitude: Number(p.lat), longitude: Number(p.lng) });
  const body = {
    origin: { location: { latLng: latLng(origin) } },
    destination: { location: { latLng: latLng(destination) } },
    travelMode: 'DRIVE',
    routingPreference: 'TRAFFIC_UNAWARE',
    computeAlternativeRoutes: false,
  };
  if (waypoints && waypoints.length) {
    body.intermediates = waypoints.map((w) => ({ location: { latLng: latLng(w) } }));
  }

  try {
    const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': gkey,
        'X-Goog-FieldMask': 'routes.distanceMeters',
      },
      body: JSON.stringify(body),
    });
    if (r.status !== 200) return null;
    const g = await r.json();
    const route = g && g.routes && g.routes[0];
    if (!route || route.distanceMeters == null) return null;
    const km = Number(route.distanceMeters) / 1000;
    if (!Number.isFinite(km) || km < 0) return null;
    cacheSet(key, km);
    return km;
  } catch (e) {
    return null;
  }
}

// Batch detour computation for up to 3 candidates.
// x, z: {lat,lng}. candidates: [{ y: {lat,lng}, straightKm }].
// Returns: [{ detourKm, viaApi: bool }] in the same order.
// Guarantees completion within API_TIMEOUT_MS via Promise.race.
async function batchDetourKm(x, z, candidates, gkey) {
  const t0 = Date.now();
  const results = candidates.map((c) => ({
    detourKm: null,
    viaApi: false,
    // Haversine shortcut for very close candidates — no API needed
    shortcut: c.straightKm != null && c.straightKm * 1000 < HAVERSINE_SHORTCUT_M,
  }));

  // Candidates that need the API
  const needApi = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => !r.shortcut);

  // Apply haversine shortcut immediately
  for (const { r, i } of results.map((r, i) => ({ r, i })).filter(({ r }) => r.shortcut)) {
    r.detourKm = candidates[i].straightKm * ROAD_FACTOR;
    r.viaApi = false;
  }

  if (needApi.length === 0 || !gkey) {
    return { results, elapsedMs: Date.now() - t0 };
  }

  // Fire D0 + all D1 calls in parallel
  const apiWork = (async () => {
    const d0P = routeDistanceKm(x, z, [], gkey);
    const d1Ps = needApi.map(({ i }) =>
      routeDistanceKm(x, z, [candidates[i].y], gkey)
    );
    const [d0, ...d1s] = await Promise.all([d0P, ...d1Ps]);
    if (d0 == null) return false; // D0 failed → can't compute any detour
    needApi.forEach(({ r }, j) => {
      const d1 = d1s[j];
      if (d1 != null) {
        r.detourKm = Math.max(0, d1 - d0);
        r.viaApi = true;
      }
    });
    return true;
  })();

  // Hard timeout: if API takes too long, use haversine fallback
  const timeoutP = new Promise((resolve) => setTimeout(() => resolve('timeout'), API_TIMEOUT_MS));
  const outcome = await Promise.race([apiWork.then(() => 'done'), timeoutP]);

  if (outcome === 'timeout') {
    // Fall back to haversine × road factor for anything still unresolved
    for (const { r, i } of needApi) {
      if (r.detourKm == null && candidates[i].straightKm != null) {
        r.detourKm = candidates[i].straightKm * ROAD_FACTOR;
        r.viaApi = false;
      }
    }
  }

  return { results, elapsedMs: Date.now() - t0 };
}

// Single-candidate detour (for quote/placement paths).
// Returns { detourKm, viaApi } or { detourKm: null } on total failure.
async function trueDetourKm(x, y, z, gkey, straightKm) {
  // Haversine shortcut
  if (straightKm != null && straightKm * 1000 < HAVERSINE_SHORTCUT_M) {
    return { detourKm: straightKm * ROAD_FACTOR, viaApi: false };
  }
  if (!gkey) return { detourKm: null, viaApi: false };
  const t0 = Date.now();
  const apiWork = (async () => {
    const [d0, d1] = await Promise.all([
      routeDistanceKm(x, z, [], gkey),
      routeDistanceKm(x, z, [y], gkey),
    ]);
    if (d0 == null || d1 == null) return { detourKm: null, viaApi: false };
    return { detourKm: Math.max(0, d1 - d0), viaApi: true };
  })();
  const timeoutP = new Promise((resolve) => setTimeout(() => resolve('timeout'), API_TIMEOUT_MS));
  const outcome = await Promise.race([apiWork, timeoutP]);
  if (outcome === 'timeout') {
    // Fall back to haversine estimate
    if (straightKm != null) {
      return { detourKm: straightKm * ROAD_FACTOR, viaApi: false };
    }
    return { detourKm: null, viaApi: false };
  }
  return outcome;
}

// Marginal-cost fee: 20% of the true extra riding cost, in paise.
// perKmRatePaise comes from backend config (first delivery tier rate).
// Returns null if detour is unknown (caller falls back).
function otwMarginalFeePaise(detourKm, perKmRatePaise) {
  if (detourKm == null || perKmRatePaise == null) return null;
  const d = Number(detourKm);
  const rate = Number(perKmRatePaise);
  if (!Number.isFinite(d) || !Number.isFinite(rate) || d < 0 || rate < 0) return null;
  return Math.round(d * rate * 0.2);
}

module.exports = {
  batchDetourKm,
  trueDetourKm,
  otwMarginalFeePaise,
  haversineKm,
  API_TIMEOUT_MS,
  _cache: cache,
};
