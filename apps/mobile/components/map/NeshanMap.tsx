import React, {
  useRef,
  useMemo,
  useImperativeHandle,
  forwardRef,
  useCallback,
  useEffect,
} from 'react';
import { View, StyleSheet } from 'react-native';
import WebViewRaw from 'react-native-webview';
import { COLORS as THEME_COLORS, SHADOW } from '../../utils/theme';
import {
  MapMarker, MapLine, NeshanMapProps, NeshanMapRef,
  tileUrlTemplate, MAP_ATTRIBUTION, TEHRAN_CENTER,
  pinHtml, gradientSegments, NeshanMapComponent,
} from './types';

/**
 * react-native-webview's class default type argument (P = undefined) collapses
 * its JSX props to `never` under RN 0.88's generated typings — the runtime API
 * is unaffected. Alias to a pragmatic functional type for JSX + ref use.
 */
const WebView = WebViewRaw as unknown as React.ForwardRefExoticComponent<
  React.PropsWithoutRef<any> & React.RefAttributes<WebViewInstance>
>;

type WebViewInstance = {
  postMessage: (data: string) => void;
  injectJavaScript: (code: string) => void;
};

/**
 * Single-load Leaflet map (Neshan raster tiles) inside a native WebView.
 *
 * The HTML document is generated exactly once for the lifetime of the
 * component; markers, route lines and camera animations are applied through
 * postMessage, so marker/polyline changes never remount or reload the map.
 * The camera center is always read from Leaflet itself (`moveend`) — never
 * reconstructed from stale React state.
 *
 * iOS/Android only — the web build uses `NeshanMap.web.tsx`
 * (Metro prefers the platform-specific file over the plain `.tsx`).
 */
const mapHtml = (initialLat: number, initialLng: number, initialZoom: number) => `
<!DOCTYPE html>
<html dir="rtl" lang="fa">
<head>
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/rastikerdar/vazirmatn@v33.003/Vazirmatn-font-face.css" />
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #E9ECEF; }
  #map { width: 100%; height: 100%; }
  .leaflet-control-attribution { font-size: 9px; font-family: sans-serif; }
  .vk-pin { display: flex; align-items: center; justify-content: center;
    width: 14px; height: 14px; background: #0FA958; border: 3px solid #fff;
    border-radius: 50%; box-shadow: 0 1px 5px rgba(0,0,0,.35); }
  .vk-label { font-family: Vazirmatn, sans-serif; font-size: 11px; color: #111C27;
    background: rgba(255,255,255,.92); padding: 2px 8px; border-radius: 6px;
    box-shadow: 0 1px 4px rgba(0,0,0,.18); white-space: nowrap; }
</style>
</head>
<body>
  <div id="map"></div>
  <script>
    var map = L.map('map', {
      center: [${initialLat}, ${initialLng}],
      zoom: ${initialZoom},
      zoomControl: false,
      attributionControl: true,
      minZoom: 10,
      maxZoom: 18,
      zoomSnap: 0.5,
      fadeAnimation: true,
    });

    L.tileLayer('${tileUrlTemplate()}', {
      maxNativeZoom: 18,
      maxZoom: 18,
      attribution: '${MAP_ATTRIBUTION}'
    }).addTo(map);

    var pinLayer = L.layerGroup().addTo(map);
    var lineLayer = null;
    var isReady = false;
    var outbox = [];
    var rn = window.ReactNativeWebView || window.parent;

    function post(obj) {
      var raw = JSON.stringify(obj);
      if (isReady) {
        try { rn.postMessage(raw); } catch (e) { try { window.postMessage(raw, '*'); } catch (e2) {} }
      } else outbox.push(raw);
    }

    // Shared geometry/visual helpers are injected from the RN bundle
    // (transpiled to plain JS at runtime) so native and web markers are
    // produced by the exact same source.
    var pinHtml = ${pinHtml.toString()};
    var gradientSegments = ${gradientSegments.toString()};

    var lineLayers = [];

    function setMarkers(list) {
      pinLayer.clearLayers();
      (list || []).forEach(function (m) {
        L.marker([m.latitude, m.longitude], {
          icon: L.divIcon({ className: '', html: pinHtml(m.color || '#0FA958', m.label), iconSize: [40, 48], iconAnchor: [20, 44] })
        }).addTo(pinLayer);
      });
    }

    function clearLine() {
      lineLayers.forEach(function (l) { map.removeLayer(l); });
      lineLayers = [];
    }

    function addPoly(coords, opts) {
      var l = L.polyline(coords, opts).addTo(map);
      lineLayers.push(l);
      return l;
    }

    function setLine(line) {
      clearLine();
      if (!line || !line.coordinates || line.coordinates.length < 2) return;
      var cs = line.coordinates.map(function (c) { return [c.latitude, c.longitude]; });
      var w = line.width || 4;
      var base = line.color || '#0FA958';

      // 1) soft outer halo   2) depth shadow underlay   3) crisp foreground
      addPoly(cs, { color: '#0B1512', weight: w + 8, opacity: 0.07, lineCap: 'round', lineJoin: 'round' });
      addPoly(cs, { color: '#0B1512', weight: w + 3, opacity: 0.16, lineCap: 'round', lineJoin: 'round' });

      if (line.to) {
        gradientSegments(line.coordinates, base, line.to).forEach(function (seg) {
          addPoly(seg.coordinates.map(function (c) { return [c.latitude, c.longitude]; }),
            { color: seg.color, weight: w, opacity: 0.98, lineCap: 'round', lineJoin: 'round' });
        });
      } else {
        addPoly(cs, { color: base, weight: w, opacity: 0.98, lineCap: 'round', lineJoin: 'round' });
      }

      // Route stays underneath pins and labels.
      pinLayer.eachLayer(function (l) { if (l.bringToFront) l.bringToFront(); });
    }

    map.on('moveend', function () {
      var c = map.getCenter();
      post({ type: 'center', lat: c.lat, lng: c.lng });
    });
    map.on('movestart', function () { post({ type: 'movestart' }); });
    map.on('click', function (e) {
      post({ type: 'click', lat: e.latlng.lat, lng: e.latlng.lng });
    });

    window.addEventListener('message', function (e) {
      var d; try { d = JSON.parse(e.data); } catch (err) { return; }
      if (!d || !d.type) return;
      if (d.type === 'animate') {
        map.setView([d.lat, d.lng], d.zoom || map.getZoom(), { animate: true, duration: 0.6 });
      } else if (d.type === 'fly') {
        map.flyTo([d.lat, d.lng], d.zoom || map.getZoom(), { duration: 0.7 });
      } else if (d.type === 'markers') {
        setMarkers(d.markers);
      } else if (d.type === 'line') {
        setLine(d.line);
      } else if (d.type === 'fit') {
        var cs = (d.coords || []).map(function (c) { return [c.latitude, c.longitude]; });
        if (cs.length === 1) { map.flyTo(cs[0], map.getZoom()); }
        else if (cs.length > 1) {
          map.flyToBounds(L.latLngBounds(cs), { paddingTopLeft: [d.padding || 60, d.padding || 60], paddingBottomRight: [d.padding || 60, d.padding || 60] });
        }
      }
    });

    map.whenReady(function () {
      isReady = true;
      outbox.forEach(function (raw) { try { rn.postMessage(raw); } catch (e) {} });
      outbox = [];
      var c = map.getCenter();
      post({ type: 'ready', lat: c.lat, lng: c.lng });
    });
  </script>
</body>
</html>
`;

const NeshanMapNativeInner = forwardRef<NeshanMapRef, NeshanMapProps>((props, ref) => {
  const { initialRegion, markers, polyline, onCenterChange, onPress, onMapMove, onMapSettle, onReady } = props;

  const webRef = useRef<WebViewInstance>(null);
  const readyRef = useRef(false);
  const queueRef = useRef<string[]>([]);
  const centerRef = useRef({ lat: TEHRAN_CENTER.lat, lng: TEHRAN_CENTER.lng });

  // Latest callbacks kept in refs so `onMessage` never needs to be recreated.
  const cb = useRef({ onCenterChange, onPress, onMapMove, onMapSettle, onReady });
  useEffect(() => {
    cb.current = { onCenterChange, onPress, onMapMove, onMapSettle, onReady };
  });

  // Static document — created once; subsequent renders never regenerate it.
  const html = useMemo(
    () =>
      mapHtml(
        initialRegion?.latitude ?? TEHRAN_CENTER.lat,
        initialRegion?.longitude ?? TEHRAN_CENTER.lng,
        initialRegion?.zoom ?? 14
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const post = useCallback((msg: Record<string, unknown>) => {
    const raw = JSON.stringify(msg);
    if (readyRef.current) webRef.current?.postMessage(raw);
    else queueRef.current.push(raw);
  }, []);

  const onMessage = useCallback((event: any) => {
    let data: any;
    try {
      data = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (!data || !data.type) return;
    if (data.type === 'ready') {
      readyRef.current = true;
      centerRef.current = { lat: data.lat, lng: data.lng };
      const q = queueRef.current;
      queueRef.current = [];
      q.forEach((raw) => webRef.current?.postMessage(raw));
      cb.current.onReady?.();
      return;
    }
    if (data.type === 'center') {
      centerRef.current = { lat: data.lat, lng: data.lng };
      cb.current.onMapSettle?.(data.lat, data.lng);
      cb.current.onCenterChange?.(data.lat, data.lng);
    } else if (data.type === 'movestart') {
      cb.current.onMapMove?.();
    } else if (data.type === 'click') {
      cb.current.onPress?.(data.lat, data.lng);
    }
  }, []);

  // Sync markers/polyline through the channel (no re-mount, no reload).
  const markerKey = markers ? markers.map((m) => `${m.id}:${m.latitude.toFixed(6)},${m.longitude.toFixed(6)},${m.color || ''}`).join('|') : '';
  const lineKey = polyline ? polyline.coordinates.map((c) => `${c.latitude.toFixed(6)},${c.longitude.toFixed(6)}`).join('|') + (polyline.color || '') : '';

  useEffect(() => {
    // Always post the current list — an empty list clears the pin layer.
    post({ type: 'markers', markers: markers || [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markerKey, post]);

  // Line: post explicit clear when transitioning to no-line states.
  const lastLineKey = useRef<string | null>(null);
  useEffect(() => {
    if (lineKey === lastLineKey.current) return;
    lastLineKey.current = lineKey;
    post({ type: 'line', line: polyline || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineKey, post]);

  useImperativeHandle(
    ref,
    () => ({
      animateTo: (lat: number, lng: number, zoom?: number) => {
        post({ type: 'animate', lat, lng, zoom });
      },
      getCenter: () => centerRef.current,
      fitToCoordinates: (coords, padding = 70) => {
        if (!coords || coords.length === 0) return;
        post({ type: 'fit', coords, padding });
      },
    }),
    [post]
  );

  return (
    <View style={[styles.container, props.style]}>
      <WebView
        ref={webRef}
        source={{ html }}
        style={styles.webview}
        scrollEnabled={false}
        bounces={false}
        overScrollMode="never"
        setSupportMultipleWindows={false}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        onMessage={onMessage}
      />
      {props.showCenterPin ? (
        <View pointerEvents="none" style={styles.pinWrap}>
          <View
            style={[
              styles.pinBody,
              { backgroundColor: props.pinColor || THEME_COLORS.brand },
            ]}
          >
            <View style={styles.pinGlyph} />
          </View>
          <View style={[styles.pinHalo, { backgroundColor: `${props.pinColor || THEME_COLORS.brand}22` }]} />
        </View>
      ) : null}
    </View>
  );
});

NeshanMapNativeInner.displayName = 'NeshanMapNativeInner';

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
  webview: { flex: 1, backgroundColor: '#E9ECEF' },
  pinWrap: {
    position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
    justifyContent: 'center', alignItems: 'center', zIndex: 100,
  },
  // Center selection marker: same teardrop geometry language as the map pins.
  // A square rotated 45° with three rounded corners forms the pin silhouette;
  // its bottom corner is the exact viewport-center anchor.
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

export default NeshanMapNativeInner as NeshanMapComponent;
export type { MapMarker, MapLine, NeshanMapProps, NeshanMapRef };
