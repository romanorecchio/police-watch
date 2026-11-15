/** Distance, heading, and phrasing helpers. Pure functions, Node + browser. */

export const EARTH_MI = 3958.7613;
export const NM_IN_MI = 1.1507794;

export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

export function haversineMiles(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MI * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function headingDelta(a, b) {
  let d = Math.abs(Number(a) - Number(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/** @returns {boolean|null} null if no heading is available */
export function isAhead(heading, bearing, coneDeg = 70) {
  if (heading == null || Number.isNaN(Number(heading))) return null;
  return headingDelta(heading, bearing) <= coneDeg / 2;
}

export function cardinal(bearing) {
  const dirs = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  const idx = Math.round((((Number(bearing) % 360) + 360) % 360) / 45) % 8;
  return dirs[idx];
}

export function formatMiles(mi) {
  const n = Number(mi);
  if (!Number.isFinite(n)) return "";
  if (n < 0.1) return "less than a tenth of a mile";
  if (n < 0.95) return `${n.toFixed(1)} miles`;
  if (n < 1.15) return "1 mile";
  if (n < 10) return `${n.toFixed(1)} miles`;
  return `${Math.round(n)} miles`;
}

export function nmToMiles(nm) {
  return Number(nm) * NM_IN_MI;
}

export function milesToNm(mi) {
  return Number(mi) / NM_IN_MI;
}

export function bboxFromPoint(lat, lon, radiusMiles) {
  const dLat = radiusMiles / 69.0;
  const cos = Math.cos(toRad(lat));
  const dLon = radiusMiles / (69.0 * Math.max(0.2, Math.abs(cos)));
  return {
    top: lat + dLat,
    bottom: lat - dLat,
    left: lon - dLon,
    right: lon + dLon,
  };
}
