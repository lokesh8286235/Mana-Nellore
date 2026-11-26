// Server-side geocoding of a restaurant's typed address (b862).
//
// A restaurant without a pin (lat/lng null) still needs a real distance-based
// delivery fee — so when the pin is missing, its typed `address` is geocoded
// via the Google Geocoding API (same GOOGLE_MAPS_KEY the server already uses
// for Distance Matrix) and the result is cached in memory.
//
// Rules:
// - Pin wins: a restaurant WITH lat/lng never geocodes.
// - A failed, timed-out, denied or too-coarse geocode returns null and the
//   caller keeps the existing base-fee fallback. The quote/place NEVER 500s
//   because geocoding failed.
// - Coarse results are rejected, mirroring the app's client-side rule
//   (co10RestGeo): APPROXIMATE + postal_code, or APPROXIMATE + locality
//   without a sublocality, is not precise enough for a delivery fee.
// - Nothing is persisted: geocoded coords are a read-time fallback only.
//   Filling the restaurant's pin is a separate admin action.
// - No fee, distance or coordinate is hardcoded here — the fee comes from
//   pricing_config and the real geocoded distance, exactly as the pinned
//   path does.

const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000; // successful geocodes: 24h
const GEOCODE_FAIL_TTL_MS = 10 * 60 * 1000; // failures: 10 min (address may be fixed)
const GEOCODE_TIMEOUT_MS = 5000;
const GEOCODE_CACHE_MAX = 500;

// address (normalized) -> { lat, lng, at, ok }
const cache = new Map();

function cacheKey(address) {
  return String(address || '').trim().toLowerCase();
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  const ttl = hit.ok ? GEOCODE_TTL_MS : GEOCODE_FAIL_TTL_MS;
  if (Date.now() - hit.at > ttl) {
    cache.delete(key);
    return undefined;
  }
  return hit;
}

function cacheSet(key, value) {
  if (cache.size >= GEOCODE_CACHE_MAX) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function isCoarse(result) {
  const locType = result && result.geometry && result.geometry.location_type;
  if (locType !== 'APPROXIMATE') return false;
  const types = (result && result.types) || [];
  if (types.indexOf('postal_code') >= 0) return true;
  if (types.indexOf('locality') >= 0 && types.indexOf('sublocality') < 0) return true;
  return false;
}

// Geocode a free-text address. Returns { lat, lng } or null.
async function geocodeAddress(address) {
  const key = cacheKey(address);
  if (!key) return null;
  const hit = cacheGet(key);
  if (hit) return hit.ok ? { lat: hit.lat, lng: hit.lng } : null;

  const gkey = process.env.GOOGLE_MAPS_KEY;
  if (!gkey) {
    cacheSet(key, { at: Date.now(), ok: false });
    return null;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEOCODE_TIMEOUT_MS);
  try {
    const url =
      'https://maps.googleapis.com/maps/api/geocode/json?address=' +
      encodeURIComponent(String(address).trim()) +
      '&key=' +
      encodeURIComponent(gkey);
    const resp = await fetch(url, { signal: ctrl.signal });
    const body = await resp.json();
    if (body.status !== 'OK' || !Array.isArray(body.results) || !body.results[0]) {
      cacheSet(key, { at: Date.now(), ok: false });
      return null;
    }
    const r0 = body.results[0];
    if (isCoarse(r0)) {
      cacheSet(key, { at: Date.now(), ok: false });
      return null;
    }
    const loc = r0.geometry && r0.geometry.location;
    const lat = Number(loc && loc.lat);
    const lng = Number(loc && loc.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      cacheSet(key, { at: Date.now(), ok: false });
      return null;
    }
    cacheSet(key, { lat, lng, at: Date.now(), ok: true });
    return { lat, lng };
  } catch (e) {
    cacheSet(key, { at: Date.now(), ok: false });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Resolve a restaurant row to coordinates: its pin when present, otherwise
// the geocoded typed address. Returns { lat, lng, src: 'pin'|'geocode' }
// or null when neither is available.
async function resolveRestaurantCoords(restaurant) {
  if (!restaurant) return null;
  const lat = Number(restaurant.lat);
  const lng = Number(restaurant.lng);
  if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
    return { lat, lng, src: 'pin' };
  }
  const addr = String(restaurant.address || '').trim();
  if (!addr) return null;
  const g = await geocodeAddress(addr);
  if (!g) return null;
  return { lat: g.lat, lng: g.lng, src: 'geocode' };
}

module.exports = { geocodeAddress, resolveRestaurantCoords };
