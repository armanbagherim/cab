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
    let result = 0;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result += (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result += (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push({ latitude: lat / factor, longitude: lng / factor });
  }
  return coords;
}

/** Cache key at ~1 m precision — good enough for address/estimate caching. */
export function coordKey(lat: number, lng: number): string {
  return `${lat.toFixed(4)},${lng.toFixed(4)}`;
}
