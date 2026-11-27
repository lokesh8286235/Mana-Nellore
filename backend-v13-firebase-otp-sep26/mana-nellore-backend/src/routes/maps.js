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

// Google encoded-polyline decode/encode (used to re-orient a reversed route
// so its polyline starts at the requested origin).
function decodePolyline(str) {
  let index = 0;
  let lat = 0;
  let lng = 0;
  const pts = [];
  while (index < str.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      byte = str.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}

function encodePolyline(pts) {
  const enc = (n) => {
    let v = n < 0 ? ~(n << 1) : n << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  let lastLat = 0;
  let lastLng = 0;
  let out = '';
  for (const p of pts) {
    const la = Math.round(p.lat * 1e5);
    const ln = Math.round(p.lng * 1e5);
    out += enc(la - lastLat) + enc(ln - lastLng);
    lastLat = la;
    lastLng = ln;
  }
  return out;
}

function reverseEncodedPolyline(enc) {
  if (!enc) return enc;
  try {
    return encodePolyline(decodePolyline(enc).reverse());
  } catch (e) {
    return enc;
  }
}

// One Routes API call. Returns { ok: true, route } or
// { ok: false, httpStatus, gstatus }. Network failure -> ok: false.
async function computeRoute(gkey, body) {
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
          'routes.legs.distanceMeters,routes.legs.duration,' +
          'routes.legs.steps.distanceMeters,routes.legs.steps.staticDuration,' +
          'routes.legs.steps.navigationInstruction,routes.legs.steps.polyline',
      },
      body: JSON.stringify(body),
    });
    httpStatus = r.status;
    g = await r.json();
  } catch (e) {
    return { ok: false, httpStatus: 502, gstatus: 'HTTP_502' };
  } finally {
    clearTimeout(timer);
  }
  const route = g && g.routes && g.routes[0];
  if (httpStatus !== 200 || !route) {
    const gstatus = (g && g.error && g.error.status) || `HTTP_${httpStatus}`;
    return { ok: false, httpStatus, gstatus };
  }
  return { ok: true, route };
}

function routeDistanceM(route) {
  if (!route) return null;
  if (typeof route.distanceMeters === 'number') return route.distanceMeters;
  const legs = route.legs || [];
  if (!legs.length) return null;
  let sum = 0;
  for (const l of legs) sum += l.distanceMeters || 0;
  return sum;
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
    const buildBody = (o, d) => {
      const b = {
        origin: { location: { latLng: latLng(o) } },
        destination: { location: { latLng: latLng(d) } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
        computeAlternativeRoutes: false,
      };
      if (waypoints.length) {
        b.intermediates = waypoints.map((w) => ({ location: { latLng: latLng(w) } }));
      }
      return b;
    };

    // Display routes only: with no intermediate stops, the Routes API's
    // one-way routing out of a street can send the forward direction on a
    // long loop (e.g. Asli -> Home: 9.5 km, looping back past the
    // restaurant) while the reverse direction is direct (4.4 km). The
    // driven road is the same either way; the shorter polyline is the one
    // that reads as "start at the restaurant, go to Home". So fetch both
    // directions in parallel and return the shorter, re-oriented to
    // origin -> destination. With waypoints the stop order matters, so
    // those keep the single forward direction.
    let chosen = null; // { route, reversed }
    let fwdErr = null;
    if (waypoints.length) {
      const r = await computeRoute(gkey, buildBody(origin, destination));
      if (r.ok) chosen = { route: r.route, reversed: false };
      else fwdErr = r;
    } else {
      const [fwd, rev] = await Promise.all([
        computeRoute(gkey, buildBody(origin, destination)),
        computeRoute(gkey, buildBody(destination, origin)),
      ]);
      if (fwd.ok && rev.ok) {
        const fd = routeDistanceM(fwd.route);
        const rd = routeDistanceM(rev.route);
        // Tie -> forward (no reversal needed).
        chosen =
          rd !== null && fd !== null && rd < fd
            ? { route: rev.route, reversed: true }
            : { route: fwd.route, reversed: false };
      } else if (fwd.ok) {
        chosen = { route: fwd.route, reversed: false };
      } else if (rev.ok) {
        chosen = { route: rev.route, reversed: true };
      } else {
        fwdErr = fwd;
      }
    }

    if (!chosen) {
      const e = fwdErr || { httpStatus: 502, gstatus: 'HTTP_502' };
      // Client errors from bad input are unlikely (we validate), but pass
      // through 400s honestly; key/quota problems -> 502 so clients fall back.
      const httpCode = e.httpStatus === 400 ? 400 : 502;
      return res.status(httpCode).json({ status: 'ERROR', error: e.gstatus });
    }

    const route = chosen.route;

    const legs = (route.legs || []).map((l) => ({
      distance_m: l.distanceMeters ?? null,
      duration_s: parseDuration(l.duration),
      start_address: null,
      end_address: null,
    }));

    // Flatten per-step turn-by-turn data across all legs.
    // Routes API step shape: { distanceMeters, staticDuration: "120s",
    //   polyline: { encodedPolyline }, navigationInstruction: { maneuver, instructions } }.
    // Simplified to keep response size small; capped at 100 steps.
    const steps = [];
    for (const leg of route.legs || []) {
      for (const s of leg.steps || []) {
        if (steps.length >= 100) break;
        const nav = s.navigationInstruction || {};
        steps.push({
          instruction: nav.instructions || null,
          maneuver: nav.maneuver || null,
          distance_m: s.distanceMeters ?? null,
          duration_s: parseDuration(s.staticDuration),
          polyline: (s.polyline && s.polyline.encodedPolyline) || null,
        });
      }
    }
    const distance_m = routeDistanceM(route) ?? 0;
    const duration_s =
      parseDuration(route.duration) ?? legs.reduce((a, l) => a + (l.duration_s || 0), 0);

    let polyline = route.polyline && route.polyline.encodedPolyline;
    let outSteps = steps;
    if (chosen.reversed) {
      // Re-orient the geometry so the polyline starts at the requested
      // origin and ends at the requested destination.
      polyline = reverseEncodedPolyline(polyline);
      outSteps = steps
        .slice()
        .reverse()
        .map((st) => ({
          ...st,
          polyline: st.polyline ? reverseEncodedPolyline(st.polyline) : null,
        }));
    }

    const out = {
      status: 'OK',
      polyline,
      legs,
      distance_m,
      duration_s,
      steps: outSteps,
    };
    cache.set(key, { at: Date.now(), body: out });
    if (cache.size > 500) {
      cache.delete(cache.keys().next().value);
    }
    res.json(out);
  })
);

module.exports = router;
