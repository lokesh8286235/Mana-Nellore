// Server-side Google Maps proxy.
// Why: the apps used to call Google's DirectionsService straight from the
// browser, but the browser API key's restrictions can block those requests
// (REQUEST_DENIED). Proxying server-side bypasses browser key restrictions:
// the server key is used here, never exposed to clients.
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
  return { lat, lng, text: `${lat},${lng}` };
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

    const params = new URLSearchParams({
      origin: origin.text,
      destination: destination.text,
      mode: 'driving',
      units: 'metric',
      key: gkey,
    });
    if (waypoints.length) {
      params.set('waypoints', waypoints.map((w) => w.text).join('|'));
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    let g;
    try {
      const r = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`, {
        signal: ctrl.signal,
      });
      g = await r.json();
    } catch (e) {
      return res.status(502).json({ status: 'ERROR', error: 'Upstream request failed' });
    } finally {
      clearTimeout(timer);
    }

    if (!g || g.status !== 'OK' || !g.routes || !g.routes.length) {
      const gstatus = (g && g.status) || 'UNKNOWN_ERROR';
      // Quota / key problems on our side -> 502 so clients can fall back.
      // ZERO_RESULTS / NOT_FOUND are legitimate answers -> 200 with ERROR body.
      const httpCode =
        gstatus === 'ZERO_RESULTS' || gstatus === 'NOT_FOUND' ? 200 : 502;
      return res.status(httpCode).json({ status: 'ERROR', error: gstatus });
    }

    const route = g.routes[0];
    const legs = (route.legs || []).map((l) => ({
      distance_m: l.distance && l.distance.value,
      duration_s: l.duration && l.duration.value,
      start_address: l.start_address,
      end_address: l.end_address,
    }));
    const distance_m = legs.reduce((a, l) => a + (l.distance_m || 0), 0);
    const duration_s = legs.reduce((a, l) => a + (l.duration_s || 0), 0);

    const body = {
      status: 'OK',
      polyline: route.overview_polyline && route.overview_polyline.points,
      legs,
      distance_m,
      duration_s,
    };
    cache.set(key, { at: Date.now(), body });
    // Keep the cache small.
    if (cache.size > 500) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    res.json(body);
  })
);

module.exports = router;
