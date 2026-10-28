import { config } from '../config';
import { NeshanRouteResult, NeshanReverseResult, NeshanSearchResult } from '../types';

const SERVICE_KEY = config.neshan.serviceApiKey;

async function fetchNeshan(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'Api-Key': SERVICE_KEY },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Neshan API error: ${res.status} ${body.slice(0, 200)}`);
  }
  return res;
}

/**
 * Direction API (v4)
 * Returns route without status field. "ok" is implied when routes array exists.
 */
export async function getRoute(
  originLat: number,
  originLng: number,
  destLat: number,
  destLng: number
): Promise<NeshanRouteResult> {
  const url = `https://api.neshan.org/v4/direction?type=car&origin=${originLat},${originLng}&destination=${destLat},${destLng}`;
  const res = await fetchNeshan(url);
  const data = await res.json() as any;
  return {
    status: data.routes && data.routes.length > 0 ? 'OK' : 'NO_ROUTE',
    distance: data.routes?.[0]?.legs?.[0]?.distance?.value ?? 0,
    duration: data.routes?.[0]?.legs?.[0]?.duration?.value ?? 0,
    routes: data.routes ?? [],
  };
}

/**
 * Reverse Geocode (v5)
 */
export async function reverseGeocode(lat: number, lng: number): Promise<NeshanReverseResult> {
  const url = `https://api.neshan.org/v5/reverse?lat=${lat}&lng=${lng}`;
  const res = await fetchNeshan(url);
  const data = await res.json() as any;
  return {
    status: data.status ?? 'UNKNOWN',
    formatted_address: data.formatted_address ?? '',
    neighbourhood: data.neighbourhood ?? '',
    route_name: data.route_name ?? '',
    city: data.city ?? '',
  };
}

/**
 * Forward Geocode (v4) - single result address search
 */
export async function geocodeAddress(address: string): Promise<{ x: number; y: number; formatted: string } | null> {
  const url = `https://api.neshan.org/v4/geocoding?address=${encodeURIComponent(address)}`;
  const res = await fetchNeshan(url);
  const data = await res.json() as any;
  if (data.status === 'OK' && data.location) {
    return {
      x: data.location.x,
      y: data.location.y,
      formatted: address,
    };
  }
  return null;
}

export async function searchAddress(query: string): Promise<NeshanSearchResult> {
  const url = `https://api.neshan.org/v4/geocoding?address=${encodeURIComponent(query)}`;
  const res = await fetchNeshan(url);
  const data = await res.json() as any;
  if (data.status === 'OK' && data.location) {
    return {
      status: 'OK',
      count: 1,
      items: [{
        title: query,
        address: query,
        location: { x: data.location.x, y: data.location.y },
      }],
    };
  }
  return { status: 'ZERO_RESULTS', count: 0, items: [] };
}

/**
 * Geocoding Plus (v1) — accurate address search with multiple results
 */
export async function searchAddressPlus(
  address: string,
  city: string,
  province: string,
  latitude?: number,
  longitude?: number
): Promise<{ items: Array<{ location: { latitude: number; longitude: number }; neighbourhood: string; city: string; province: string }> }> {
  const body: any = {
    address,
    city,
    province,
    location: latitude && longitude ? { latitude, longitude } : { latitude: 35.6892, longitude: 51.3890 },
    extent: {
      southWest: { latitude: 35.5, longitude: 51.2 },
      northEast: { latitude: 35.8, longitude: 51.6 },
    },
  };
  const url = 'https://api.neshan.org/geocoding/v1/plus?json=' + encodeURIComponent(JSON.stringify(body));
  const res = await fetchNeshan(url);
  return res.json() as Promise<{ items: Array<{ location: { latitude: number; longitude: number }; neighbourhood: string; city: string; province: string }> }>;
}
/**
 * Search API (v1) — real place/POI search.
 * Used by the passenger's location-search UI: handles Persian and English
 * terms and returns actual coordinates (location.x = lng, location.y = lat).
 */
export async function searchPoi(
  term: string,
  lat?: number,
  lng?: number
): Promise<{ count: number; items: Array<{ title: string; address: string; neighbourhood?: string; region?: string; location: { x: number; y: number } }> }> {
  const url = new URL('https://api.neshan.org/v1/search');
  url.searchParams.set('term', term);
  if (typeof lat === 'number' && typeof lng === 'number') {
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lng', String(lng));
  }
  const res = await fetchNeshan(url.toString());
  const data = await res.json() as any;
  return {
    count: data.count ?? 0,
    items: (data.items ?? []).map((i: any) => ({
      title: i.title ?? '',
      address: i.address ?? '',
      neighbourhood: i.neighbourhood,
      region: i.region,
      location: { x: i.location?.x ?? 0, y: i.location?.y ?? 0 },
    })),
  };
}
