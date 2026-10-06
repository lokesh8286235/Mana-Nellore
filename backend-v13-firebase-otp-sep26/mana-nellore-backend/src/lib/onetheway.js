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

module.exports = {
  SERVICE_AREA,
  DETOUR_TOLERANCE,
  isOnRoute,
  isInServiceArea,
  extractPin,
  otwDenyReason
};
