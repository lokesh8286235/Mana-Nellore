// Server-side Google Maps proxy.
// Why: the apps used to call Google's DirectionsService straight from the
// browser, but the browser API key's restrictions can block those requests
// (REQUEST_DENIED). Proxying server-side bypasses browser key restrictions:
// the server key is used here, never exposed to clients.
//
// Uses the Routes API (v2:computeRoutes) — the legacy Directions API is not
// enabled for this project ("LegacyApiNotActivatedMapError").
//
// Only numeric coordinates are accepted (no free-text queries) so callers
// cannot burn Google quota on arbitrary searches.
const express = require('express');
const { ah } = require('../middleware/auth');

const router = express.Router();

// Tiny in-memory cache: driving directions barely change within a minute,
// and this keeps Google quota burn low. Keyed on rounded coordinates.
const CACHE_TTL_MS = 90 * 1000;
const cache = new Map(); // key -> { at, body }

function parseLatLng(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function parseDuration(s) {
  // Routes API returns durations like "374s".
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d+)s$/);
  return m ? Number(m[1]) : null;
}

function cacheKey(origin, destination, waypoints) {
  const r = (p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  return [r(origin), r(destination), waypoints.map(r).join('|')].join('>');
}

// GET /api/maps/directions?origin=LAT,LNG&destination=LAT,LNG&waypoints=LAT,LNG|LAT,LNG
// waypoints optional, pipe-separated, max 10.
router.get(
  '/directions',
  ah(async (req, res) => {
    const gkey = process.env.GOOGLE_MAPS_KEY;
    if (!gkey) {
      return res.status(503).json({ status: 'ERROR', error: 'Maps not configured' });
    }

    const origin = parseLatLng(req.query.origin);
    const destination = parseLatLng(req.query.destination);
    if (!origin || !destination) {
      return res.status(400).json({
        status: 'ERROR',
        error: 'origin and destination are required as LAT,LNG',
      });
    }

    let waypoints = [];
    if (req.query.waypoints) {
      const parts = String(req.query.waypoints).split('|').slice(0, 10);
      waypoints = parts.map(parseLatLng);
      if (waypoints.some((w) => !w)) {
        return res.status(400).json({
          status: 'ERROR',
          error: 'waypoints must be pipe-separated LAT,LNG pairs',
        });
      }
    }

    const key = cacheKey(origin, destination, waypoints);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return res.json(hit.body);
    }

    const latLng = (p) => ({ latitude: p.lat, longitude: p.lng });
    const body = {
      origin: { location: { latLng: latLng(origin) } },
      destination: { location: { latLng: latLng(destination) } },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_UNAWARE',
      computeAlternativeRoutes: false,
    };
    if (waypoints.length) {
      body.intermediates = waypoints.map((w) => ({ location: { latLng: latLng(w) } }));
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    let g;
    let httpStatus = 200;
    try {
      const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': gkey,
          'X-Goog-FieldMask':
            'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline,' +
            'routes.legs.distanceMeters,routes.legs.duration',
        },
        body: JSON.stringify(body),
      });
      httpStatus = r.status;
      g = await r.json();
    } catch (e) {
      return res.status(502).json({ status: 'ERROR', error: 'Upstream request failed' });
    } finally {
      clearTimeout(timer);
    }

    const route = g && g.routes && g.routes[0];
    if (httpStatus !== 200 || !route) {
      const gstatus =
        (g && g.error && g.error.status) || `HTTP_${httpStatus}`;
      // Client errors from bad input are unlikely (we validate), but pass
      // through 400s honestly; key/quota problems -> 502 so clients fall back.
      const httpCode = httpStatus === 400 ? 400 : 502;
      return res.status(httpCode).json({ status: 'ERROR', error: gstatus });
    }

    const legs = (route.legs || []).map((l) => ({
      distance_m: l.distanceMeters ?? null,
      duration_s: parseDuration(l.duration),
      start_address: null,
      end_address: null,
    }));
    const distance_m = route.distanceMeters ?? legs.reduce((a, l) => a + (l.distance_m || 0), 0);
    const duration_s =
      parseDuration(route.duration) ?? legs.reduce((a, l) => a + (l.duration_s || 0), 0);

    const out = {
      status: 'OK',
      polyline: route.polyline && route.polyline.encodedPolyline,
      legs,
      distance_m,
      duration_s,
    };
    cache.set(key, { at: Date.now(), body: out });
    if (cache.size > 500) {
      cache.delete(cache.keys().next().value);
    }
    res.json(out);
  })
);

module.exports = router;
