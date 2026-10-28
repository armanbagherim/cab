import React, {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useCallback,
} from 'react';
import { View, StyleSheet } from 'react-native';
// Web-only module: bundled exclusively through the `.web.tsx` platform split,
// so the native bundle never includes Leaflet and the web bundle never
// includes react-native-webview.
import * as L from 'leaflet';
import { COLORS, SHADOW } from '../../utils/theme';
import {
  MapMarker, MapLine, NeshanMapProps, NeshanMapRef, NeshanMapComponent,
  tileUrlTemplate, MAP_ATTRIBUTION, TEHRAN_CENTER,
  pinHtml, gradientSegments,
} from './types';

// Leaflet's stylesheet loads from the same CDN build the native WebView uses.
// Metro's CSS pipeline cannot inline Leaflet's local image assets
// (marker-icon.png, layers.png), so the npm CSS import produced bundling
// warnings and broken default icons on web.
function ensureLeafletCss() {
  if (typeof document === 'undefined') return;
  if (!document.querySelector('link[data-leaflet-css]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    link.setAttribute('data-leaflet-css', '');
    document.head.appendChild(link);
  }
  if (document.querySelector('style[data-rahino-markers]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-rahino-markers', '');
  style.textContent = '.vehicle-marker-icon { transition: transform .45s linear !important; }';
  document.head.appendChild(style);
}

/**
 * Web build of the Neshan map.
 *
 * `react-native-webview` has no browser implementation (its web entry renders
 * "React Native WebView does not support this platform"), so the web app must
 * run Leaflet directly on the DOM instead of inside a WebView. This component
 * mirrors the native component's props and imperative API, so screens need no
 * platform-specific code.
 *
 * The map is created exactly once per component lifetime; markers and route
 * lines are applied in-place (no source/tile-layer recreation on camera moves).
 */

const NeshanMapWeb = forwardRef<NeshanMapRef, NeshanMapProps>((props, ref) => {
  const { initialRegion, markers, polyline, circle, onCenterChange, onPress, onMapMove, onMapSettle, onReady } = props;

  const wrapRef = useRef<any>(null);
  ensureLeafletCss();
  const mapRef = useRef<L.Map | null>(null);
  const pinLayerRef = useRef<any>(null);
  const lineLayersRef = useRef<any[]>([]);
  const markerRefs = useRef<Map<string, any>>(new Map());
  const circleRef = useRef<any>(null);
  const readyRef = useRef(false);
  const centerRef = useRef({ lat: TEHRAN_CENTER.lat, lng: TEHRAN_CENTER.lng });

  // Latest callbacks kept in refs so event registrations never need re-binding.
  const cb = useRef({ onCenterChange, onPress, onMapMove, onMapSettle, onReady });
  useEffect(() => {
    cb.current = { onCenterChange, onPress, onMapMove, onMapSettle, onReady };
  });

  // ---- Map lifecycle: created exactly once, never remounted on prop changes ----
  useEffect(() => {
    let disposed = false;
    const el = document.createElement('div');
    el.style.cssText = 'width:100%;height:100%;';
    wrapRef.current.appendChild(el);

    const map: L.Map = L.map(el, {
      center: [initialRegion?.latitude ?? TEHRAN_CENTER.lat, initialRegion?.longitude ?? TEHRAN_CENTER.lng],
      zoom: initialRegion?.zoom ?? 14,
      zoomControl: false,
      attributionControl: true,
      minZoom: 10,
      maxZoom: 18,
      zoomSnap: 0.5,
      zoomAnimation: true,
    });

    L.tileLayer(tileUrlTemplate(), {
      maxNativeZoom: 18,
      maxZoom: 18,
      attribution: MAP_ATTRIBUTION,
    }).addTo(map);

    pinLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;

    map.on('moveend', () => {
      const c = map.getCenter();
      centerRef.current = { lat: c.lat, lng: c.lng };
      cb.current.onMapSettle?.(c.lat, c.lng);
      cb.current.onCenterChange?.(c.lat, c.lng);
    });
    map.on('movestart', () => {
      cb.current.onMapMove?.();
    });
    map.on('click', (e: any) => {
      cb.current.onPress?.(e.latlng.lat, e.latlng.lng);
    });

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);

    map.whenReady(() => {
      if (disposed) return;
      readyRef.current = true;
      const c = map.getCenter();
      centerRef.current = { lat: c.lat, lng: c.lng };
      cb.current.onReady?.();
    });

    return () => {
      disposed = true;
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      pinLayerRef.current = null;
      lineLayersRef.current = [];
      readyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Markers: diffed by a stable key so lists are only re-applied on change ----
  const markerKey = markers
    ? markers.map((m) => `${m.id}:${m.latitude.toFixed(6)},${m.longitude.toFixed(6)},${m.color || ''},${m.glyph || ''},${m.heading || 0}`).join('|')
    : '';
  useEffect(() => {
    const pinLayer = pinLayerRef.current;
    if (!pinLayer) return;
    const markerMap = markerRefs.current;
    const incoming = new Set<string>();
    (markers || []).forEach((m) => {
      incoming.add(m.id);
      const vehicle = m.glyph === 'car';
      const marker = markerMap.get(m.id);
      if (!marker) {
        markerMap.set(m.id, L.marker([m.latitude, m.longitude], {
          icon: L.divIcon({ className: vehicle ? 'vehicle-marker-icon' : '', html: pinHtml(m.color || COLORS.brand, m.label, m.glyph, m.heading || 0), iconSize: vehicle ? [34, 34] : [40, 48], iconAnchor: vehicle ? [17, 17] : [20, 44] }),
        }).addTo(pinLayer));
      } else {
        marker.setLatLng([m.latitude, m.longitude]);
        if (vehicle) {
          const rotor = marker.getElement()?.querySelector('.vehicle-rotor') as HTMLElement | null;
          if (rotor) rotor.style.transform = `rotate(${m.heading || 0}deg)`;
        }
      }
    });
    markerMap.forEach((marker: any, id: string) => {
      if (!incoming.has(id)) { pinLayer.removeLayer(marker); markerMap.delete(id); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerKey]);

  // ---- Route line: only re-applied when it actually changes ----
  const lineKey = polyline
    ? polyline.coordinates.map((c) => `${c.latitude.toFixed(6)},${c.longitude.toFixed(6)}`).join('|') + (polyline.color || '')
    : '';
  const lastLineKey = useRef<string | null>(null);
  useEffect(() => {
    if (lineKey === lastLineKey.current) return;
    lastLineKey.current = lineKey;
    const map = mapRef.current;
    if (!map) return;
    if (lineLayersRef.current.length) {
      lineLayersRef.current.forEach((l: any) => map.removeLayer(l));
      lineLayersRef.current = [];
    }
    if (polyline && polyline.coordinates.length > 1) {
      const cs = polyline.coordinates.map((c) => [c.latitude, c.longitude] as [number, number]);
      const w = polyline.width || 4;
      const base = polyline.color || COLORS.brand;
      const add = (coords: [number, number][], opts: any) => {
        const l = L.polyline(coords, opts).addTo(map);
        lineLayersRef.current.push(l);
      };
      // 1) soft outer halo   2) depth shadow underlay   3) crisp foreground
      add(cs, { color: '#0B1512', weight: w + 8, opacity: 0.07, lineCap: 'round', lineJoin: 'round' });
      add(cs, { color: '#0B1512', weight: w + 3, opacity: 0.16, lineCap: 'round', lineJoin: 'round' });
      if (polyline.to) {
        gradientSegments(polyline.coordinates, base, polyline.to).forEach((seg) => {
          add(seg.coordinates.map((c) => [c.latitude, c.longitude] as [number, number]), {
            color: seg.color, weight: w, opacity: 0.98, lineCap: 'round', lineJoin: 'round',
          });
        });
      } else {
        add(cs, { color: base, weight: w, opacity: 0.98, lineCap: 'round', lineJoin: 'round' });
      }
      // Route stays underneath pins and labels.
      pinLayerRef.current?.eachLayer((l: any) => l.bringToFront && l.bringToFront());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineKey]);

  const circleKey = circle ? `${circle.latitude},${circle.longitude},${circle.radiusKm},${circle.color || ''}` : '';
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (circleRef.current) { map.removeLayer(circleRef.current); circleRef.current = null; }
    if (circle) {
      circleRef.current = L.circle([circle.latitude, circle.longitude], {
        radius: circle.radiusKm * 1000, color: circle.color || '#111111', weight: 2,
        fillColor: circle.color || '#111111', fillOpacity: 0.10,
      }).addTo(map);
    }
  }, [circleKey]);

  useImperativeHandle(
    ref,
    () => ({
      animateTo: (lat: number, lng: number, zoom?: number) => {
        mapRef.current?.setView([lat, lng], zoom ?? mapRef.current.getZoom(), { animate: true, duration: 0.6 });
      },
      getCenter: () => centerRef.current,
      fitToCoordinates: (coords: Array<{ latitude: number; longitude: number }>, padding = 70) => {
        const map = mapRef.current;
        if (!map || !coords || coords.length === 0) return;
        const cs = coords.map((c) => [c.latitude, c.longitude] as [number, number]);
        if (cs.length === 1) map.flyTo(cs[0], map.getZoom());
        else
          map.flyToBounds(L.latLngBounds(cs), {
            paddingTopLeft: [padding, padding],
            paddingBottomRight: [padding, padding],
          });
      },
    }),
    []
  );

  return (
    <View style={[styles.container, props.style]}>
      <View ref={wrapRef} style={styles.domHost} />
      {props.showCenterPin ? (
        <View pointerEvents="none" style={styles.pinWrap}>
          <View
            style={[
              styles.pinBody,
              { backgroundColor: props.pinColor || COLORS.brand },
            ]}
          >
            <View style={styles.pinGlyph} />
          </View>
          <View style={[styles.pinHalo, { backgroundColor: `${props.pinColor || COLORS.brand}22` }]} />
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
  domHost: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, overflow: 'hidden' },
  pinWrap: {
    position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
    justifyContent: 'center', alignItems: 'center', zIndex: 100,
  },
  // Mirrors the native center pin geometry (teardrop anchored at center).
  pinBody: {
    width: 30, height: 30, borderRadius: 15,
    borderBottomRightRadius: 2,
    transform: [{ rotate: '-45deg' }],
    borderWidth: 2.5, borderColor: '#FFFFFF',
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 16,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 8,
  },
  pinGlyph: {
    width: 10, height: 10, borderRadius: 5, backgroundColor: '#FFFFFF',
    transform: [{ rotate: '45deg' }],
  },
  pinHalo: {
    position: 'absolute', bottom: '50%', marginBottom: -3,
    width: 22, height: 8, borderRadius: 11,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 4,
  },
});

export default NeshanMapWeb as NeshanMapComponent;
export type { MapMarker, MapLine, NeshanMapProps, NeshanMapRef };
