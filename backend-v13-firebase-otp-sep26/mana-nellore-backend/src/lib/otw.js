// On-the-way helpers — simple version (user-dictated 2026-10-13).
//
// Formula:
//   X→Z (primary):   100% of normal delivery fee for X→Z distance
//   Y→Z (secondary): 20% of the normal delivery fee for Y→Z distance
//
// "On the way" = restaurant within 500m (straight-line) of the X→Z route
// segment. No detour calculations, no Routes API calls for pricing.
// Restaurants beyond 500m are never offered as on-the-way options.

// Straight-line distance from point P to segment AB, in km.
// Uses an equirectangular projection (good enough for <15km).
function pointToSegKm(px, py, ax, ay, bx, by) {
  const meanLat = ((ay + by) / 2) * Math.PI / 180;
  const kx = 111.32 * Math.cos(meanLat); // km per degree lng
  const ky = 110.57; // km per degree lat
  const Ax = ax * kx, Ay = ay * ky;
  const Bx = bx * kx, By = by * ky;
  const Px = px * kx, Py = py * ky;
  const dx = Bx - Ax, dy = By - Ay;
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(Px - Ax, Py - Ay);
  const t = Math.max(0, Math.min(1, ((Px - Ax) * dx + (Py - Ay) * dy) / len2));
  return Math.hypot(Px - (Ax + t * dx), Py - (Ay + t * dy));
}

module.exports = {
  pointToSegKm,
};
