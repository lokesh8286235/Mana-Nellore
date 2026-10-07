// Google Routes API — real travel times for accurate ETAs.
// All calls are server-side (key never leaves the backend).
// Aggressive caching to control API costs.

const ROUTES_API_BASE = 'https://routes.googleapis.com';

// In-memory caches
// Batch (restaurant list): 5 min TTL — restaurant ETAs don't change fast
const batchCache = new Map();
const BATCH_TTL_MS = 5 * 60 * 1000;
// Single (tracking): 60 sec TTL — rider moves, but don't hammer the API
const singleCache = new Map();
const SINGLE_TTL_MS = 60 * 1000;

function getApiKey() {
  return process.env.GOOGLE_MAPS_KEY || '';
}

function parseDuration(durationStr) {
  // "165s" -> 165 (seconds)
  if (!durationStr) return null;
  const m = String(durationStr).match(/^([\d.]+)s$/);
  return m ? parseFloat(m[1]) : null;
}

async function callRoutesApi(endpoint, body, fieldMask) {
  const key = getApiKey();
  if (!key) return null;
  
  try {
    const resp = await fetch(`${ROUTES_API_BASE}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': fieldMask,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      console.error(`Routes API ${endpoint} failed: ${resp.status}`);
      return null;
    }
    return await resp.json();
  } catch (e) {
    console.error(`Routes API ${endpoint} error:`, e.message);
    return null;
  }
}

/**
 * Get real driving duration (seconds) and distance (meters) for a single route.
 * Uses computeRoutes with traffic-aware routing.
 * Cached for 60 seconds.
 */
async function getRouteDuration(originLat, originLng, destLat, destLng) {
  if (!Number.isFinite(originLat) || !Number.isFinite(originLng) ||
      !Number.isFinite(destLat) || !Number.isFinite(destLng)) {
    return null;
  }
  
  // Round to 4 decimals (~11m precision) for cache hits
  const key = `${originLat.toFixed(4)},${originLng.toFixed(4)}>${destLat.toFixed(4)},${destLng.toFixed(4)}`;
  const now = Date.now();
  const cached = singleCache.get(key);
  if (cached && now - cached.at < SINGLE_TTL_MS) {
    return cached.value;
  }
  
  const data = await callRoutesApi(
    '/directions/v2:computeRoutes',
    {
      origin: { location: { latLng: { latitude: originLat, longitude: originLng } } },
      destination: { location: { latLng: { latitude: destLat, longitude: destLng } } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      units: 'METRIC',
    },
    'routes.duration,routes.distanceMeters'
  );
  
  if (!data || !data.routes || !data.routes.length) {
    return null;
  }
  
  const route = data.routes[0];
  const result = {
    durationSec: parseDuration(route.duration),
    distanceMeters: route.distanceMeters || null,
  };
  
  // Only cache successful results
  if (result.durationSec != null) {
    singleCache.set(key, { value: result, at: now });
    // Prevent unbounded growth
    if (singleCache.size > 1000) {
      const firstKey = singleCache.keys().next().value;
      singleCache.delete(firstKey);
    }
  }
  
  return result;
}

/**
 * Get real driving durations for one origin to multiple destinations.
 * Uses computeRouteMatrix (one API call for up to 625 pairs).
 * Cached for 5 minutes.
 * Returns: Map of destination index -> { durationSec, distanceMeters }
 */
async function getBatchDurations(originLat, originLng, destinations) {
  // destinations: array of { lat, lng }
  if (!Number.isFinite(originLat) || !Number.isFinite(originLng) ||
      !Array.isArray(destinations) || !destinations.length) {
    return new Map();
  }
  
  // Filter to valid destinations, keep original indices
  const valid = [];
  const indexMap = []; // valid index -> original index
  destinations.forEach((d, i) => {
    if (d && Number.isFinite(d.lat) && Number.isFinite(d.lng)) {
      valid.push(d);
      indexMap.push(i);
    }
  });
  if (!valid.length) return new Map();
  
  // Cache key: origin + sorted destination coords
  const destKey = valid.map(d => `${d.lat.toFixed(4)},${d.lng.toFixed(4)}`).sort().join('|');
  const cacheKey = `${originLat.toFixed(4)},${originLng.toFixed(4)}|${destKey}`;
  const now = Date.now();
  const cached = batchCache.get(cacheKey);
  if (cached && now - cached.at < BATCH_TTL_MS) {
    return cached.value;
  }
  
  const data = await callRoutesApi(
    '/distanceMatrix/v2:computeRouteMatrix',
    {
      origins: [
        { waypoint: { location: { latLng: { latitude: originLat, longitude: originLng } } } }
      ],
      destinations: valid.map(d => ({
        waypoint: { location: { latLng: { latitude: d.lat, longitude: d.lng } } }
      })),
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      units: 'METRIC',
    },
    'originIndex,destinationIndex,duration,distanceMeters,status'
  );
  
  const result = new Map();
  if (data && Array.isArray(data)) {
    for (const row of data) {
      // destinationIndex refers to index in our valid array
      const validIdx = row.destinationIndex;
      const origIdx = indexMap[validIdx];
      if (origIdx != null && row.status && row.status.code === 0) {
        const durationSec = parseDuration(row.duration);
        if (durationSec != null) {
          result.set(origIdx, {
            durationSec,
            distanceMeters: row.distanceMeters || null,
          });
        }
      }
    }
  }
  
  // Cache even partial results
  batchCache.set(cacheKey, { value: result, at: now });
  if (batchCache.size > 200) {
    const firstKey = batchCache.keys().next().value;
    batchCache.delete(firstKey);
  }
  
  return result;
}

/**
 * Convert duration seconds to ETA minutes for display.
 * Adds a buffer for food prep (configurable).
 */
function durationToEtaMinutes(durationSec, prepBufferMin = 15) {
  if (durationSec == null) return null;
  const travelMin = Math.ceil(durationSec / 60);
  return travelMin + prepBufferMin;
}

module.exports = {
  getRouteDuration,
  getBatchDurations,
  durationToEtaMinutes,
};
