// On-the-way route validation + Nellore service-area checks.
// The backend is the final gatekeeper: discounts are computed here from
// database coordinates — client claims are never trusted.
//
// Founder rules (2026-10-06):
// - Every restaurant delivers to every address in Nellore (full-city).
//   Deliverability is rejected ONLY when the address is clearly OUTSIDE
//   the Nellore service area.
// - A secondary (on-the-way) restaurant that is NOT on the route X -> Z
//   cannot be delivered at all: its items leave the order (never repriced).
// - Fail closed everywhere: an unverifiable route means NO discount and
//   NO delivery for the secondary.
const { haversineKm } = require('./pricing');

// Lazy-load routesApi to avoid circular dependencies (routesApi doesn't
// require onetheway, but keep it lazy for safety).
let _routesApi = null;
function routesApi() {
  if (!_routesApi) _routesApi = require('./routesApi');
  return _routesApi;
}

// Cache for X->Z direct route distances (meters).
// Key: "xLat,xLng>zLat,zLng" (rounded to 4 decimals).
// TTL: 10 minutes — road distances don't change fast.
const _directRouteCache = new Map();
const DIRECT_ROUTE_TTL_MS = 10 * 60 * 1000;

function _cacheKey(lat1, lng1, lat2, lng2) {
  return `${Number(lat1).toFixed(4)},${Number(lng1).toFixed(4)}>${Number(lat2).toFixed(4)},${Number(lng2).toFixed(4)}`;
}

function _getCachedDirect(xLat, xLng, zLat, zLng) {
  const k = _cacheKey(xLat, xLng, zLat, zLng);
  const e = _directRouteCache.get(k);
  if (e && Date.now() - e.at < DIRECT_ROUTE_TTL_MS) return e.meters;
  return null;
}

function _setCachedDirect(xLat, xLng, zLat, zLng, meters) {
  const k = _cacheKey(xLat, xLng, zLat, zLng);
  _directRouteCache.set(k, { meters, at: Date.now() });
  if (_directRouteCache.size > 500) {
    const fk = _directRouteCache.keys().next().value;
    _directRouteCache.delete(fk);
  }
}

// Nellore service area: every restaurant delivers anywhere inside it.
const SERVICE_AREA = { lat: 14.4426, lng: 79.9865, radiusKm: 15 };

// A secondary counts as "on the way" when the detour through it
// (X -> S -> Z) is at most 25% longer than the direct trip (X -> Z).
const DETOUR_TOLERANCE = 1.25;

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// isOnRoute(secondary, primary, address) — each {lat, lng}.
// True only when the secondary lies on the primary -> address route.
// FAIL CLOSED: any missing coordinate returns false.
// Uses haversine (straight-line) — the fallback when Routes API is unavailable.
function isOnRoute(sec, prim, addr) {
  const sLat = num(sec && sec.lat);
  const sLng = num(sec && sec.lng);
  const pLat = num(prim && prim.lat);
  const pLng = num(prim && prim.lng);
  const aLat = num(addr && addr.lat);
  const aLng = num(addr && addr.lng);
  if ([sLat, sLng, pLat, pLng, aLat, aLng].some((v) => v === null)) return false;
  const dXZ = haversineKm(pLat, pLng, aLat, aLng);
  const dXS = haversineKm(pLat, pLng, sLat, sLng);
  const dSZ = haversineKm(sLat, sLng, aLat, aLng);
  if (dXZ === 0) return dXS === 0 && dSZ === 0;
  return dXS + dSZ <= dXZ * DETOUR_TOLERANCE;
}

// isOnRouteTrue(sec, prim, addr) — TRUE route matching via Google Routes API.
// Uses real driving distances instead of haversine straight-line.
// Returns: true (on route), false (off route), or null (API failed/unavailable).
// Null means "fall back to haversine" — never fail closed on API errors.
//
// A secondary is "on the way" if the detour through it (X -> S -> Z) is at
// most 25% longer than the direct trip (X -> Z), using REAL road distances.
//
// NOTE: As of 2026-10-07, zero restaurants have coordinates, so this always
// returns null (falls back to haversine). It engages automatically once
// restaurant lat/lng are captured at onboarding.
async function isOnRouteTrue(sec, prim, addr) {
  const sLat = num(sec && sec.lat);
  const sLng = num(sec && sec.lng);
  const pLat = num(prim && prim.lat);
  const pLng = num(prim && prim.lng);
  const aLat = num(addr && addr.lat);
  const aLng = num(addr && addr.lng);
  if ([sLat, sLng, pLat, pLng, aLat, aLng].some((v) => v === null)) return null;

  try {
    const api = routesApi();
    if (typeof api.getRouteDuration !== 'function') return null;

    // Get X->Z direct distance (cached — same for all secondaries in an order).
    let xzMeters = _getCachedDirect(pLat, pLng, aLat, aLng);
    if (xzMeters == null) {
      const xz = await api.getRouteDuration(pLat, pLng, aLat, aLng);
      if (!xz || xz.distanceMeters == null) return null;
      xzMeters = xz.distanceMeters;
      _setCachedDirect(pLat, pLng, aLat, aLng, xzMeters);
    }
    if (xzMeters === 0) {
      // Degenerate: X and Z are the same place. Only on-route if S is there too.
      return sLat === pLat && sLng === pLng;
    }

    // Get X->S and S->Z distances.
    const [xs, sz] = await Promise.all([
      api.getRouteDuration(pLat, pLng, sLat, sLng),
      api.getRouteDuration(sLat, sLng, aLat, aLng),
    ]);
    if (!xs || xs.distanceMeters == null || !sz || sz.distanceMeters == null) {
      return null;
    }

    const viaMeters = xs.distanceMeters + sz.distanceMeters;
    return viaMeters <= xzMeters * DETOUR_TOLERANCE;
  } catch (e) {
    // Never fail closed on API errors — fall back to haversine.
    return null;
  }
}

function extractPin(address) {
  const text = [address && address.line1, address && address.line2].filter(Boolean).join(' ');
  const m = text.match(/\b524\d{3}\b/);
  return m ? m[0] : null;
}

// isInServiceArea(address) -> 'inside' | 'outside' | 'unknown'.
// 'unknown' (no coords, no PIN, no city match) must ALLOW the order —
// never block a legit order over missing metadata (caller logs it).
function isInServiceArea(address) {
  if (!address) return 'unknown';
  const aLat = num(address.lat);
  const aLng = num(address.lng);
  if (aLat !== null && aLng !== null) {
    const d = haversineKm(aLat, aLng, SERVICE_AREA.lat, SERVICE_AREA.lng);
    return d <= SERVICE_AREA.radiusKm ? 'inside' : 'outside';
  }
  if (extractPin(address)) return 'inside'; // 524xxx PINs are the Nellore region
  const city = String(address.city || '').toLowerCase();
  if (city.includes('nellore')) return 'inside';
  return 'unknown';
}

// Why a secondary was denied: 'off_route' vs 'unverifiable' (missing coords).
function otwDenyReason(secRest, primRest, address) {
  const coords = [secRest && secRest.lat, secRest && secRest.lng,
    primRest && primRest.lat, primRest && primRest.lng,
    address && address.lat, address && address.lng];
  if (coords.some((v) => num(v) === null)) {
    return 'unverifiable';
  }
  return 'off_route';
}

// True when all three parties have coordinates — i.e., the route check is verifiable.
function otwCoordsComplete(sec, prim, addr) {
  return [sec, prim, addr].every((p) => p && num(p.lat) !== null && num(p.lng) !== null);
}

// The discount decision.
// - Verifiable route + on-route  -> grant the 20% discount.
// - Verifiable route + off-route -> deny (strip/exclude) the secondary.
// - Unverifiable (any coords missing) -> grant the 20%, flagged for audit.
//
// The third case is deliberate: the customer app is permissive when coords are
// missing (it lists every open restaurant as on-the-way), and today NO
// restaurant has coordinates. Denying here would break 100% of legitimate
// on-the-way orders and contradict what the user sees. The strict gate
// engages automatically the moment coordinates exist (capture them at
// restaurant onboarding). Every permissive grant is audit-logged.
async function otwDiscountDecision(sec, prim, addr) {
  if (!otwCoordsComplete(sec, prim, addr)) return { decision: 'grant_unverifiable' };
  // Try TRUE route matching first (real road distances via Routes API).
  // Falls back to haversine if API unavailable or coords missing.
  // The `method` field indicates which was used (for audit/debug).
  const trueResult = await isOnRouteTrue(sec, prim, addr);
  if (trueResult !== null) {
    return trueResult
      ? { decision: 'grant', method: 'routes_api' }
      : { decision: 'deny', reason: 'off_route', method: 'routes_api' };
  }
  if (isOnRoute(sec, prim, addr)) return { decision: 'grant', method: 'haversine' };
  return { decision: 'deny', reason: 'off_route', method: 'haversine' };
}

module.exports = {
  SERVICE_AREA,
  DETOUR_TOLERANCE,
  isOnRoute,
  isOnRouteTrue,
  isInServiceArea,
  extractPin,
  otwDenyReason,
  otwCoordsComplete,
  otwDiscountDecision
};
