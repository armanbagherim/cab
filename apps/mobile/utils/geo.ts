/**
 * Geometry helpers shared by passenger and driver screens.
 */

export interface LatLng {
  latitude: number;
  longitude: number;
}

/**
 * Decode a Google/OSRM-style encoded polyline (precision 5) into lat/lng pairs.
 * Used for the real road geometry returned by the Neshan routing API
 * (`overview_polyline.points`, stored on trips as `routeGeoJson`).
 */
export function decodePolyline(encoded: string, precision = 5): LatLng[] {
  if (!encoded) return [];
  const coords: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const factor = 10 ** precision;

  while (index < encoded.length) {
    let result = 1;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push({ latitude: lat / factor, longitude: lng / factor });
  }
  return coords;
}

/** Downsample a dense polyline so rendered route lines stay cheap. */
export function thinPolyline(coords: LatLng[], maxPoints = 300): LatLng[] {
  if (coords.length <= maxPoints) return coords;
  const step = coords.length / maxPoints;
  const out: LatLng[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(coords[Math.floor(i * step)]);
  out.push(coords[coords.length - 1]);
  return out;
}

/** Cache key at ~1 m precision — good enough for address/estimate caching. */
export function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}

/**
 * Smooth quadratic-Bézier arc between two points — purely decorative
 * connection used only when real road geometry is unavailable. It must never
 * be presented as a navigable route.
 */
export function makeArc(
  a: LatLng,
  b: LatLng,
  points = 64,
  bulge = 0.22
): LatLng[] {
  const dx = b.longitude - a.longitude;
  const dy = b.latitude - a.latitude;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return [a, b];

  // Perpendicular offset, chosen so the arc consistently rises NORTH
  // (screen-up) regardless of travel direction.
  let px = -dy;
  let py = dx;
  if (py < 0) {
    px = dy;
    py = -dx;
  }
  const pLen = Math.hypot(px, py);
  px = (px / pLen) * dist * bulge;
  py = (py / pLen) * dist * bulge;

  // Modern cubic bezier: 2 control points for an elegant, aerodynamic curvature
  const p1x = a.longitude + (b.longitude - a.longitude) * 0.28 + px * 0.95;
  const p1y = a.latitude + (b.latitude - a.latitude) * 0.28 + py * 0.95;
  const p2x = a.longitude + (b.longitude - a.longitude) * 0.72 + px * 0.95;
  const p2y = a.latitude + (b.latitude - a.latitude) * 0.72 + py * 0.95;

  const out: LatLng[] = [];
  for (let i = 0; i <= points; i++) {
    const t = i / points;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const t2 = t * t;
    out.push({
      latitude: mt2 * mt * a.latitude + 3 * mt2 * t * p1y + 3 * mt * t2 * p2y + t2 * t * b.latitude,
      longitude: mt2 * mt * a.longitude + 3 * mt2 * t * p1x + 3 * mt * t2 * p2x + t2 * t * b.longitude,
    });
  }
  return out;
}
