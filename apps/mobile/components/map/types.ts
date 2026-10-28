import type React from 'react';

export interface MapMarker {
  id: string;
  latitude: number;
  longitude: number;
  color?: string;
  label?: string;
}

export interface MapLine {
  coordinates: Array<{ latitude: number; longitude: number }>;
  color?: string;
  width?: number;
  /** Dest color: when present the stroke is drawn as a coordinated
   * origin→destination gradient (segmented polyline). */
  to?: string;
}

export interface NeshanMapProps {
  style?: any;
  /** Static initial camera — applied only once at map load, never reapplied afterwards. */
  initialRegion?: { latitude: number; longitude: number; zoom?: number };
  markers?: MapMarker[];
  polyline?: MapLine | null;
  onCenterChange?: (lat: number, lng: number) => void;
  onPress?: (lat: number, lng: number) => void;
  onMapMove?: () => void;
  onMapSettle?: (lat: number, lng: number) => void;
  onReady?: () => void;
  /** Fixed pin rendered as a native overlay at the map's visual center. */
  showCenterPin?: boolean;
  pinColor?: string;
}

export interface NeshanMapRef {
  animateTo: (lat: number, lng: number, zoom?: number) => void;
  getCenter: () => { lat: number; lng: number };
  fitToCoordinates: (coords: Array<{ latitude: number; longitude: number }>, padding?: number) => void;
}

export type NeshanMapComponent = React.ForwardRefExoticComponent<
  NeshanMapProps & React.RefAttributes<NeshanMapRef>
>;

/** Neshan raster tile URL (single style; source created once per map lifecycle). */
export function tileUrlTemplate(): string {
  const key = process.env.EXPO_PUBLIC_NESHAN_TILE_KEY || '';
  return `https://api.neshan.org/tile/raster/basemap/{z}/{x}/{y}?style=neshan&Api-key=${key}`;
}

export const MAP_ATTRIBUTION =
  '&copy; <a href="https://www.Neshan.org" target="_blank">Neshan</a> | &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors';

export const TEHRAN_CENTER = { lat: 35.6892, lng: 51.389 };

/**
 * Shared marker markup used by BOTH platform renderers, so the center
 * selection marker, origin and destination all share one geometry language:
 * layered ground halo → teardrop pin with soft shadow → white ring → glyph.
 * The tip is the anchor (bottom center): the rotated pin's tip lands at
 * (17, 29) in the 34×34 container, matching iconAnchor [17, 29].
 */
export function pinHtml(color: string, label?: string, glyph: 'dot' | 'flag' = 'dot'): string {
  const isFlag = glyph === 'flag';
  const icon = isFlag
    ? `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M5 21V4" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><path d="M5 4h12l-2 5 2 5H5" fill="#fff"/></svg>`
    : `<div style="width:7px;height:7px;border-radius:50%;background:#fff;box-shadow:0 0 4px rgba(255,255,255,0.8)"></div>`;

  const labelHtml = label
    ? `<div style="position:absolute;left:50%;bottom:48px;transform:translateX(-50%);white-space:nowrap;` +
      `font-family:Vazirmatn,Tahoma,sans-serif;font-size:12px;font-weight:700;color:#0F172A;` +
      `background:rgba(255,255,255,0.96);backdrop-filter:blur(10px);border:1px solid rgba(0,0,0,0.06);` +
      `padding:5px 12px;border-radius:999px;box-shadow:0 4px 16px rgba(15,23,42,0.16);letter-spacing:-0.2px">` +
      `${label}` +
      `</div>`
    : '';

  return (
    `<div style="position:relative;width:40px;height:48px;display:flex;align-items:center;justify-content:center">` +
    // Ground ripple / pulse halo
    `<div style="position:absolute;left:50%;top:38px;transform:translateX(-50%);` +
    `width:24px;height:8px;border-radius:50%;background:${color}33;filter:blur(1px);box-shadow:0 0 8px ${color}66"></div>` +
    // Modern Enterprise Teardrop Pin
    `<div style="position:absolute;left:50%;top:4px;transform:translateX(-50%);width:32px;height:38px;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 6px 12px rgba(15,23,42,0.28))">` +
    `<svg width="32" height="38" viewBox="0 0 32 38" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="M16 38C16 38 31 23.5 31 15.5C31 7.49187 24.2843 1 16 1C7.71573 1 1 7.49187 1 15.5C1 23.5 16 38 16 38Z" fill="${color}" stroke="#FFFFFF" stroke-width="2.5" stroke-linejoin="round"/>` +
    `</svg>` +
    `<div style="position:absolute;top:6px;left:50%;transform:translateX(-50%);display:flex;align-items:center;justify-content:center;width:18px;height:18px">` +
    `${icon}` +
    `</div>` +
    `</div>` +
    labelHtml +
    `</div>`
  );
}

/** Coordinated origin→destination gradient by slicing the polyline. */
export function gradientSegments(
  coords: Array<{ latitude: number; longitude: number }>,
  from: string,
  to: string,
  slices = 24
): Array<{ coordinates: Array<{ latitude: number; longitude: number }>; color: string }> {
  if (coords.length < 2) return [];
  const parse = (hex: string) => {
    const h = hex.replace('#', '');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const a = parse(from);
  const b = parse(to);
  const n = Math.min(slices, Math.max(1, coords.length - 1));
  const per = Math.max(1, Math.floor((coords.length - 1) / n));
  const segs: Array<{ coordinates: Array<{ latitude: number; longitude: number }>; color: string }> = [];
  for (let i = 0; i < coords.length - 1; i += per) {
    const end = Math.min(i + per, coords.length - 1);
    const t = end / (coords.length - 1);
    const color = `#${a.map((c, k) => Math.round(c + (b[k] - c) * t).toString(16).padStart(2, '0')).join('')}`;
    segs.push({ coordinates: coords.slice(i, end + 1), color });
  }
  return segs;
}
