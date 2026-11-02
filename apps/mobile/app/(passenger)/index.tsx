import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator,
  FlatList, KeyboardAvoidingView, Platform,
} from 'react-native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import { CabMap, NeshanMapRef } from '../../components/CabMap';
import { LocateIcon, LocateOffIcon, SearchIcon, LogoutIcon, CloseIcon, ClockIcon, RoadIcon, HistoryIcon, PersonIcon, MenuIcon } from '../../components/Icons';
import PopoverMenu from '../../components/PopoverMenu';
import { api } from '../../services/api';
import { socketService } from '../../services/socket';
import { useAuth } from '../../context/AuthContext';
import { COLORS, FONTS, SPACING, RADIUS, SHADOW, formatToman } from '../../utils/theme';
import { decodePolyline, coordKey } from '../../utils/geo';

type Point = { lat: number; lng: number; addr: string };
type Stage = 'origin' | 'dest' | 'result';
type LocationPhase = 'idle' | 'acquiring' | 'error';

const TEHRAN = { lat: 35.6892, lng: 51.389 };

/** Final reverse-geocode results are cached for this app session. */
let reverseGeocodeCache: Record<string, string> = {};
const reverseGeocodeInflight: Partial<Record<string, Promise<string>>> = {};
/** Fare/route lookups cached per confirmed pair so re-entering the preview
 * stage never repeats a successful request; a changed point = a new key. */
interface CachedEstimate {
  distanceKm: number;
  durationMin: number;
  estimatedPrice: number;
  originAddress: string;
  destAddress: string;
  route: string | null;
}
let estimateCache: Record<string, CachedEstimate> = {};

export default function PassengerHomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { logout, token, user, isLoading } = useAuth();
  const mapRef = useRef<NeshanMapRef>(null);

  // ---- Selection state -------------------------------------------------------
  const [stage, setStage] = useState<Stage>('origin');
  const [origin, setOrigin] = useState<Point | null>(null);
  const [dest, setDest] = useState<Point | null>(null);

  // Authoritative camera center — always read back from the map SDK itself.
  const centerRef = useRef<Point>({ lat: TEHRAN.lat, lng: TEHRAN.lng, addr: '' });

  // ---- GPS -------------------------------------------------------------------
  const [locatePhase, setLocatePhase] = useState<LocationPhase>('idle');
  const locating = useRef(false);
  const gpsRan = useRef(false);

  // ---- Search ----------------------------------------------------------------
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchSeq = useRef(0); // stale-response guard for the search API
  const cameraCommandSeq = useRef(0); // latest search/GPS action wins

  // ---- Fare / submission -----------------------------------------------------
  const [estimate, setEstimate] = useState<CachedEstimate | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [creatingTrip, setCreatingTrip] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'WALLET'>('CASH');
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [nearbyDrivers, setNearbyDrivers] = useState<Array<{ id: string; latitude: number; longitude: number; heading?: number; isAccepting: boolean; distanceKm: number; lastSeenAt?: string | number }>>([]);
  const [tripError, setTripError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const panelH = useRef(0);
  const reverseKeyRef = useRef<string | null>(null);
  const reverseAbortRef = useRef<AbortController | null>(null);

  const resolveAddress = useCallback((lat: number, lng: number, signal: AbortSignal) => {
    const key = coordKey(lat, lng);
    if (reverseGeocodeCache[key]) return Promise.resolve(reverseGeocodeCache[key]);
    if (reverseGeocodeInflight[key]) return reverseGeocodeInflight[key];
    const request = api.reverseGeocode(lat, lng, signal)
      .then((result) => {
        const address = result?.address || '';
        if (address) reverseGeocodeCache[key] = address;
        return address;
      })
      .finally(() => { delete reverseGeocodeInflight[key]; });
    reverseGeocodeInflight[key] = request;
    return request;
  }, []);

  // Reported by the map itself after every camera settle.
  // No service calls here — moving the map costs nothing.
  const onMapSettle = useCallback((lat: number, lng: number) => {
    centerRef.current = { lat, lng, addr: '' };
  }, []);

  // ---- Locate me: explicit request, loading state, no auto-confirm ------------
  const runLocate = useCallback(async () => {
    if (locating.current) return; // no duplicate requests
    const commandSeq = ++cameraCommandSeq.current;
    locating.current = true;
    setLocatePhase('acquiring');
    try {
      const servicesOn = await Location.hasServicesEnabledAsync().catch(() => true);
      if (!servicesOn) {
        setLocatePhase('error');
        return;
      }
      let perm = await Location.getForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        perm = await Location.requestForegroundPermissionsAsync();
      }
      if (perm.status !== 'granted') {
        setLocatePhase('error');
        return;
      }
      let loc: Location.LocationObject;
      try {
        loc = await Location.getCurrentPositionAsync({ accuracy: 4 });
      } catch {
        // Transient kCLErrorLocationUnknown-type failures: one soft retry with
        // relaxed accuracy. Still no fallback coordinate when it fails.
        loc = await Location.getCurrentPositionAsync({ accuracy: 3 });
      }
      const lat = loc.coords.latitude;
      const lng = loc.coords.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        setLocatePhase('error');
        return;
      }
      if (commandSeq !== cameraCommandSeq.current) return;
      mapRef.current?.animateTo(lat, lng, 15.5);
      centerRef.current = { lat, lng, addr: '' };
      setLocatePhase('idle');
    } catch {
      setLocatePhase('error'); // actionable error; interaction restored below
    } finally {
      locating.current = false;
    }
  }, []);

  // Only locate when user explicitly taps the locate FAB button.
  // Initial map uses default Tehran coordinates without blocking or pending UI.

  // ---- Active-ride gate: the passenger may hold exactly one live ride ----
  // On mount (and on every return to this screen) the authoritative backend
  // state decides whether the new-ride flow is even reachable. A live trip
  // (searching / offered / accepted / in progress) takes over the screen
  // immediately; terminal states never do.
  useFocusEffect(
    useCallback(() => {
      let stale = false;
      api.getActiveTrip()
        .then((active) => {
          if (!stale && active?.id) {
            router.replace({ pathname: '/(passenger)/active-trip', params: { tripId: active.id } } as any);
          }
        })
        .catch(() => {}); // no active trip / auth error — normal new-ride flow
      return () => { stale = true; };
    }, [router])
  );

  useFocusEffect(useCallback(() => {
    api.getWallet().then((wallet) => setWalletBalance(wallet?.balance ?? 0)).catch(() => {});
  }, []));

  useFocusEffect(useCallback(() => {
    let active = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = async () => {
      if (!token) return;
      const last = await Location.getLastKnownPositionAsync().catch(() => null);
      const lat = last?.coords.latitude ?? centerRef.current.lat;
      const lng = last?.coords.longitude ?? centerRef.current.lng;
      try {
        const drivers = await api.getNearbyDrivers(lat, lng);
        console.log('[Passenger][NEARBY_HTTP]', { lat, lng, count: drivers?.length || 0 });
        if (active) setNearbyDrivers(drivers || []);
      } catch (error: any) {
        console.warn('[Passenger][NEARBY_RETRY]', error?.message || error);
        if (active) retryTimer = setTimeout(refresh, 5000);
      }
    };
    const unsubs = [
      socketService.on('drivers:location', (driver: any) => {
        console.log('[Passenger][NEARBY_SOCKET_LOCATION]', driver);
        if (!driver?.id || !driver.isOnline || !driver.isAccepting) return;
        setNearbyDrivers((prev) => {
           const next = { id: driver.id, latitude: driver.latitude, longitude: driver.longitude, heading: driver.heading, isAccepting: true, distanceKm: 0, lastSeenAt: Date.now() };
          return prev.some((item) => item.id === next.id) ? prev.map((item) => item.id === next.id ? { ...item, ...next } : item) : [...prev, next];
        });
      }),
      socketService.on('drivers:status', (driver: any) => {
        console.log('[Passenger][NEARBY_SOCKET_STATUS]', driver);
        if (!driver?.id) return;
        setNearbyDrivers((prev) => driver.isOnline && driver.isAccepting
          ? prev.map((item) => item.id === driver.id ? { ...item, isAccepting: !!driver.isAccepting } : item)
          : prev.filter((item) => item.id !== driver.id));
      }),
      socketService.onConnect(refresh),
    ];
    refresh();
    const timer = setInterval(() => {
      setNearbyDrivers((prev) => prev.filter((driver) => !driver.lastSeenAt || Date.now() - new Date(driver.lastSeenAt).getTime() <= 60 * 60 * 1000));
      refresh();
    }, 30_000);
    return () => { active = false; clearInterval(timer); if (retryTimer) clearTimeout(retryTimer); unsubs.forEach((unsubscribe) => unsubscribe()); };
  }, [token]));

  // ---- Search ----------------------------------------------------------------
  useEffect(() => {
    if (searchQ.trim().length < 2 || !searchOpen) {
      setSearchResults([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      const c = centerRef.current;
      const seq = ++searchSeq.current;
      try {
        // Real Neshan Search API (POI) via the server proxy; reference
        // coordinates bias results toward the currently viewed area.
        const r = await api.searchPlaces(searchQ.trim(), c.lat, c.lng);
        if (seq !== searchSeq.current) return; // an older, slower query must not overwrite newer results
        setSearchResults(r?.items || []);
      } catch {
        if (seq === searchSeq.current) setSearchResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 500);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [searchQ, searchOpen]);

  // Search selection moves the camera only — confirmation stays explicit.
  // The result's real coordinates and title are used everywhere downstream
  // (map, preview, estimate, trip payload) so they always stay consistent.
  const handleSearchSelect = useCallback((item: any) => {
    const lat = item.location?.y ?? item.location?.latitude;
    const lng = item.location?.x ?? item.location?.longitude;
    if (typeof lat === 'number' && typeof lng === 'number'
      && Number.isFinite(lat) && Number.isFinite(lng)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      cameraCommandSeq.current += 1;
      mapRef.current?.animateTo(lat, lng, 16.5);
      centerRef.current = { lat, lng, addr: '' };
    }
    setSearchOpen(false);
    setSearchQ('');
    setSearchResults([]);
  }, []);

  // ---- Explicit stage transitions ---------------------------------------------
  // Confirming a point only snapshots local coordinates. Address resolution
  // starts once both points are finalized below.
  const confirmOrigin = useCallback(() => {
    const c = centerRef.current;
    const point: Point = { lat: c.lat, lng: c.lng, addr: '' };
    setEstimate(null);
    setEstimateError(null);
    // If a destination already exists (origin edited later) → back to review,
    // keeping the untouched destination. Never silently erase it.
    setStage(dest ? 'result' : 'dest');
    setOrigin(point);
  }, [dest]);

  const confirmDest = useCallback(() => {
    const c = centerRef.current;
    const point: Point = { lat: c.lat, lng: c.lng, addr: '' };
    setDest(point);
    setStage('result');
  }, []);

  const editOrigin = useCallback(() => {
    setStage('origin');
    setEstimate(null);
    setEstimateError(null);
  }, []);

  const editDest = useCallback(() => {
    setStage('dest');
    setEstimate(null);
    setEstimateError(null);
  }, []);

  const fetchEstimate = useCallback(async (o: Point, d: Point) => {
    // Cache per confirmed pair: returning to the preview with unchanged
    // points never repeats the request; editing either point produces a new
    // key, which is equivalent to invalidating the old result.
    const key = `${coordKey(o.lat, o.lng)}|${coordKey(d.lat, d.lng)}`;
    const cached = estimateCache[key];
    if (cached) {
      setEstimate(cached);
      return;
    }
    setEstimating(true);
    setEstimateError(null);
    try {
      const r: {
        distanceKm: number; durationMin: number; estimatedPrice: number;
        originAddress?: string; destAddress?: string; route?: string | null;
      } = await api.estimateTrip(o.lat, o.lng, d.lat, d.lng);
      // Type the storage shape explicitly to keep the cache self-validating.
      const stored = {
        distanceKm: r.distanceKm,
        durationMin: r.durationMin,
        estimatedPrice: r.estimatedPrice,
        originAddress: r.originAddress || '',
        destAddress: r.destAddress || '',
        route: r.route || null,
      };
      estimateCache[key] = stored;
      setEstimate(stored);
    } catch (e: any) {
      setEstimate(null);
      setEstimateError(e?.message && e.message !== 'Request failed' ? e.message : 'محاسبه کرایه ممکن نشد. دوباره تلاش کنید.');
    } finally {
      setEstimating(false);
    }
  }, []);

  // Real road geometry from the routing API (decoded from the encoded
  // polyline). The straight-line fallback is gone: when no valid geometry
  // exists we draw nothing rather than a misleading line.
  const routeLine = useMemo(() => {
    if (!(stage === 'result' && origin && dest)) return null;
    const key = `${coordKey(origin.lat, origin.lng)}|${coordKey(dest.lat, dest.lng)}`;
    const enc = estimate?.route || estimateCache[key]?.route;
    if (enc) {
      // Real road geometry from the routing API is authoritative.
      const decoded = decodePolyline(enc);
      if (decoded.length > 1) {
        return { coordinates: decoded, color: COLORS.pinOrigin, to: COLORS.pinDest, width: 5 };
      }
    }
    return null;
  }, [stage, origin?.lat, origin?.lng, dest?.lat, dest?.lng, estimate?.route]);

  useEffect(() => {
    if (stage === 'result' && origin && dest) {
      fetchEstimate(origin, dest);
      mapRef.current?.fitToCoordinates(
        [
          { latitude: origin.lat, longitude: origin.lng },
          { latitude: dest.lat, longitude: dest.lng },
        ],
        260
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  useEffect(() => {
    if (stage !== 'result' || !origin || !dest) return;
    const key = `${coordKey(origin.lat, origin.lng)}|${coordKey(dest.lat, dest.lng)}`;
    if (reverseKeyRef.current !== key) {
      reverseAbortRef.current?.abort();
      reverseKeyRef.current = key;
      reverseAbortRef.current = new AbortController();
    }
    const controller = reverseAbortRef.current || new AbortController();
    reverseAbortRef.current = controller;
    const signal = controller.signal;
    const originPoint = { lat: origin.lat, lng: origin.lng };
    const destPoint = { lat: dest.lat, lng: dest.lng };
    Promise.all([
      resolveAddress(originPoint.lat, originPoint.lng, signal),
      resolveAddress(destPoint.lat, destPoint.lng, signal),
    ]).then(([originAddress, destAddress]) => {
      if (reverseKeyRef.current !== key || signal.aborted) return;
      setOrigin((point) => point && coordKey(point.lat, point.lng) === coordKey(originPoint.lat, originPoint.lng)
        ? { ...point, addr: originAddress || point.addr } : point);
      setDest((point) => point && coordKey(point.lat, point.lng) === coordKey(destPoint.lat, destPoint.lng)
        ? { ...point, addr: destAddress || point.addr } : point);
    }).catch(() => {});
  }, [stage, origin?.lat, origin?.lng, dest?.lat, dest?.lng, resolveAddress]);

  useEffect(() => {
    const coordinates = routeLine?.coordinates;
    if (stage === 'result' && coordinates && coordinates.length > 1) {
      mapRef.current?.fitToCoordinates(coordinates, 260);
    }
  }, [stage, routeLine]);

  const retryEstimate = useCallback(() => {
    if (origin && dest) fetchEstimate(origin, dest);
  }, [origin, dest, fetchEstimate]);

  // ---- Submit -----------------------------------------------------------------
  const submitTrip = useCallback(async () => {
    if (!origin || !dest || creatingTrip) return;
    if (paymentMethod === 'WALLET' && estimate && (walletBalance ?? 0) < estimate.estimatedPrice) {
      setTripError('موجودی کیف پول کافی نیست؛ ابتدا کیف پول را شارژ کنید.');
      router.push('/wallet');
      return;
    }
    setCreatingTrip(true);
    setTripError(null);
    try {
      const key = `${coordKey(origin.lat, origin.lng)}|${coordKey(dest.lat, dest.lng)}`;
      if (reverseKeyRef.current !== key) {
        reverseAbortRef.current?.abort();
        reverseKeyRef.current = key;
        reverseAbortRef.current = new AbortController();
      }
      const reverseController = reverseAbortRef.current || new AbortController();
      reverseAbortRef.current = reverseController;
      const reverseSignal = reverseController.signal;
      const [originAddress, destAddress] = await Promise.all([
        origin.addr || resolveAddress(origin.lat, origin.lng, reverseSignal),
        dest.addr || resolveAddress(dest.lat, dest.lng, reverseSignal),
      ]);
      setOrigin((point) => point && coordKey(point.lat, point.lng) === coordKey(origin.lat, origin.lng) ? { ...point, addr: originAddress } : point);
      setDest((point) => point && coordKey(point.lat, point.lng) === coordKey(dest.lat, dest.lng) ? { ...point, addr: destAddress } : point);
      const trip = await api.createTrip(origin.lat, origin.lng, originAddress, dest.lat, dest.lng, destAddress, paymentMethod);
      router.push({ pathname: '/(passenger)/active-trip', params: { tripId: trip.id } } as any);
    } catch (e: any) {
      setTripError(e?.message && e.message !== 'Request failed' ? e.message : 'ثبت درخواست سفر ناموفق بود. دوباره تلاش کنید.');
    } finally {
      setCreatingTrip(false);
    }
  }, [origin, dest, creatingTrip, estimate, paymentMethod, walletBalance, router, resolveAddress]);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch (e) {
      console.warn('[Passenger] logout error', e);
    }
  }, [logout]);

  // Logout safety net: AuthContext owns cleanup, and replace('/') lands on
  // the Super App home. Enforce the destination here too so a failure in the
  // global navigation never leaves the app stuck inside the cab section.
  useEffect(() => {
    if (!isLoading && !user) router.replace({ pathname: '/login', params: { role: 'PASSENGER' } } as any);
  }, [user, isLoading, router]);

  // ---- Derived, remount-safe map data ------------------------------------------
  const markers = useMemo(() => {
    const m: Array<{ id: string; latitude: number; longitude: number; color?: string; label?: string; glyph?: 'dot' | 'car' }> = nearbyDrivers
      .filter((driver) => driver.isAccepting && (!driver.lastSeenAt || Date.now() - new Date(driver.lastSeenAt).getTime() <= 60 * 60 * 1000))
      .map((driver) => ({
      id: `driver-${driver.id}`,
      latitude: driver.latitude,
      longitude: driver.longitude,
      heading: driver.heading,
      color: '#2563EB',
      glyph: 'car',
      }));
    if (origin) m.push({ id: 'origin', latitude: origin.lat, longitude: origin.lng, color: COLORS.pinOrigin, label: 'مبدأ' });
    if (stage === 'result' && dest) m.push({ id: 'dest', latitude: dest.lat, longitude: dest.lng, color: COLORS.pinDest, label: 'مقصد' });
    return m;
  }, [origin?.lat, origin?.lng, dest?.lat, dest?.lng, stage, nearbyDrivers]);

  const polyline = routeLine;

  const acquiring = locatePhase === 'acquiring';
  const mainDisabled = stage === 'result' ? !estimate || creatingTrip : false;
  const mainLabel =
    stage === 'origin' ? 'تأیید مبدأ' : stage === 'dest' ? 'تأیید مقصد' : 'ثبت درخواست سفر';
  const mainHandler =
    stage === 'origin' ? confirmOrigin : stage === 'dest' ? confirmDest : submitTrip;

  return (
    <View style={s.container}>
      {/* ---------------- Map ---------------- */}
      {/* Gestures are held off only during the actual GPS acquisition window. */}
      <View style={s.mapArea} pointerEvents={acquiring ? 'none' : 'auto'}>
        <CabMap
          mapRef={mapRef}
          initialRegion={{ latitude: TEHRAN.lat, longitude: TEHRAN.lng, zoom: 14 }}
          onMapSettle={onMapSettle}
          showCenterPin={stage !== 'result'}
          centerPinLabel={stage === 'dest' ? 'مقصد' : 'مبدأ'}
          pinColor={stage === 'origin' ? COLORS.pinOrigin : COLORS.pinDest}
          markers={markers}
          polyline={polyline}
        />
      </View>

      {/* --------------- GPS acquisition overlay + error --------------- */}
      {acquiring && (
        <View pointerEvents="none" style={[s.locateOverlay, { top: insets.top + 78 }]}>
          <View style={s.locateOverlayCard}>
            <ActivityIndicator size="small" color={COLORS.brand} />
            <Text style={s.locateOverlayText}>در حال دریافت موقعیت فعلی...</Text>
          </View>
        </View>
      )}
      {locatePhase === 'error' && (
        <View pointerEvents="box-none" style={[s.locateOverlay, { top: insets.top + 78 }]}>
          <View style={[s.locateOverlayCard, s.locateErrorCard]}>
            <Text style={s.locateErrorText}>دریافت موقعیت ممکن نشد</Text>
            <Pressable onPress={runLocate} hitSlop={6} style={s.locateRetry}>
              <Text style={s.locateRetryText}>تلاش مجدد</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* ---------------- Top bar: search pill + logout ---------------- */}
      {stage !== 'result' && (!searchOpen ? (
        <>
          <Pressable
            style={({ pressed }) => [s.searchPill, pressed && { opacity: 0.94 }, { top: insets.top + 10 }]}
            onPress={() => setSearchOpen(true)}
          >
            <SearchIcon size={20} />
            <Text style={s.searchPillText} numberOfLines={1}>
              جست‌وجوی آدرس یا انتخاب روی نقشه
            </Text>
          </Pressable>
          {/* Single menu button — Trips / Profile / Logout live in a popover
              instead of a row of buttons beside the search pill. */}
          <View style={[s.headerActions, { top: insets.top + 10 }]}>
            <Pressable
              accessibilityLabel="منو"
              accessibilityRole="button"
              onPress={() => setMenuOpen(true)}
              style={({ pressed }) => [s.headerBtn, pressed && { opacity: 0.85 }]}
            >
              <MenuIcon size={22} color={COLORS.textSecondary} />
            </Pressable>
          </View>
        </>
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[s.searchOverlay, { top: insets.top + 8 }]}>
          <View style={s.searchRow}>
            <Pressable
              accessibilityLabel="بستن جست‌وجو"
              onPress={() => { setSearchOpen(false); setSearchQ(''); setSearchResults([]); }}
              style={s.searchClose}
              hitSlop={6}
            >
              <CloseIcon size={18} />
            </Pressable>
            <TextInput
              style={s.searchInput}
              value={searchQ}
              onChangeText={setSearchQ}
              placeholder="جست‌وجوی آدرس در تهران..."
              placeholderTextColor={COLORS.textTertiary}
               textAlign="right"
              autoFocus
              returnKeyType="search"
            />
          </View>
          {searching && (
            <View style={s.searchMeta}><ActivityIndicator size="small" color={COLORS.brand} /></View>
          )}
          {!searching && searchResults.length === 0 && searchQ.trim().length >= 2 && (
            <View style={[s.searchMeta, { paddingBottom: 12 }]}>
              <View style={s.searchMetaCard}><Text style={s.searchMetaText}>نتیجه‌ای یافت نشد. عبارت دیگری را جست‌وجو کنید.</Text></View>
            </View>
          )}
          {searchResults.length > 0 && (
            <FlatList
              data={searchResults}
              keyExtractor={(_, i) => i.toString()}
              style={s.resultList}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [s.resultItem, pressed && s.resultItemPressed]}
                  onPress={() => handleSearchSelect(item)}
                >
                  <SearchIcon size={16} color={COLORS.brand} />
                  <View style={s.resultTextWrap}>
                    <Text style={s.resultTitle} numberOfLines={1}>{item.title || item.neighbourhood || 'آدرس'}</Text>
                    <Text style={s.resultAddr} numberOfLines={1}>
                      {[item.neighbourhood, item.city].filter(Boolean).join('، ') || item.city || 'تهران'}
                    </Text>
                  </View>
                </Pressable>
              )}
            />
          )}
        </KeyboardAvoidingView>
      ))}

      {/* ---------------- Popover menu (Trips / Profile / Logout) ---------------- */}
      <PopoverMenu
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        // headerActions is pinned to the physical right edge — same side here,
        // and screen-edge clipping is impossible (Modal layer).
        side="right"
        top={insets.top + 62}
        items={[
          {
            key: 'trips',
            label: 'سفرهای من',
            icon: <HistoryIcon size={20} color={COLORS.textSecondary} />,
           onPress: () => router.push('/(passenger)/trip-history'),
          },
          {
            key: 'profile',
            label: 'پروفایل',
            icon: <PersonIcon size={20} color={COLORS.textSecondary} />,
           onPress: () => router.push('/profile'),
         },
          {
            key: 'home',
            label: 'صفحه اصلی',
            icon: <MaterialCommunityIcons name="home-outline" size={20} color={COLORS.textSecondary} />,
            onPress: () => router.replace('/home' as any),
          },
          {
            key: 'logout',
            label: 'خروج از حساب',
            icon: <LogoutIcon size={20} color={COLORS.error} />,
            danger: true,
            onPress: handleLogout,
          },
        ]}
      />

      {/* ---------------- Locate-me FAB ---------------- */}
      {stage !== 'result' ? <Pressable
        accessibilityLabel="موقعیت فعلی من"
        disabled={locatePhase === 'acquiring'}
        onPress={runLocate}
        style={({ pressed }) => [s.locateFab, pressed && { opacity: 0.85 }, { bottom: insets.bottom + (panelH.current || 0) + 18 }]}
      >
        {acquiring ? <LocateOffIcon size={22} color={COLORS.textTertiary} /> : <LocateIcon size={22} color={COLORS.brand} />}
      </Pressable> : null}

      {/* ---------------- Bottom panel (Enterprise Clean Sheet) ---------------- */}
      <View
        style={[s.panel, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}
        onLayout={(e) => { panelH.current = e.nativeEvent.layout.height; }}
      >
        <View style={s.panelHandle} />

        {stage === 'dest' && origin && (
          <View style={s.originBadgeRow}>
            <View style={s.badgeDot} />
            <Text style={s.originBadgeLabel}>مبدأ انتخاب‌شده:</Text>
            <Text style={s.originBadgeAddr} numberOfLines={1}>{origin.addr || 'انتخاب روی نقشه'}</Text>
            <Pressable onPress={editOrigin} hitSlop={8} style={s.badgeEditBtn}>
              <Text style={s.badgeEditText}>تغییر</Text>
            </Pressable>
          </View>
        )}

        {stage === 'result' && origin && dest && (
          <View style={s.resultWrap}>
            <View style={s.routeCard}>
              <View style={s.itinRow}>
                <View style={[s.pointDot, { backgroundColor: COLORS.pinOrigin }]} />
                <View style={s.itinContent}>
                  <Text style={s.itinLabel}>مبدأ</Text>
                  <Text style={s.itinText} numberOfLines={1}>{origin.addr || 'مبدأ روی نقشه'}</Text>
                </View>
                <Pressable onPress={editOrigin} hitSlop={6} style={s.editChipWrap}>
                  <Text style={s.editChip}>تغییر</Text>
                </Pressable>
              </View>

              <View style={s.connectorLine} />

              <View style={s.itinRow}>
                <View style={[s.pointDot, { backgroundColor: COLORS.pinDest }]} />
                <View style={s.itinContent}>
                  <Text style={s.itinLabel}>مقصد</Text>
                  <Text style={s.itinText} numberOfLines={1}>{dest.addr || 'مقصد روی نقشه'}</Text>
                </View>
                <Pressable onPress={editDest} hitSlop={6} style={s.editChipWrap}>
                  <Text style={s.editChip}>تغییر</Text>
                </Pressable>
              </View>
            </View>

            <View style={s.fareCard}>
              {estimating ? (
                <View style={s.fareLoading}>
                  <ActivityIndicator size="small" color={COLORS.brand} />
                  <Text style={s.fareLoadingText}>در حال استعلام بهترین مسیر و قیمت...</Text>
                </View>
              ) : estimate ? (
                <>
                  <View style={s.fareRow}>
                    <View style={s.farePriceGroup}>
                      <Text style={s.farePrice}>{formatToman(estimate.estimatedPrice)}</Text>
                      <Text style={s.fareCurrency}>تومان</Text>
                    </View>
                    <View style={s.fareMetrics}>
                      <View style={s.fareMetricBadge}>
                        <RoadIcon size={13} color={COLORS.textSecondary} />
                        <Text style={s.fareMetricText}>{estimate.distanceKm.toLocaleString('fa-IR')} کیلومتر</Text>
                      </View>
                      <View style={s.fareMetricBadge}>
                        <ClockIcon size={13} color={COLORS.textSecondary} />
                        <Text style={s.fareMetricText}>{estimate.durationMin.toLocaleString('fa-IR')} دقیقه</Text>
                      </View>
                    </View>
                  </View>
                </>
              ) : (
                <View style={s.fareError}>
                  <Text style={s.fareErrorText} numberOfLines={2}>{estimateError || 'محاسبه کرایه ناموفق بود'}</Text>
                  <Pressable onPress={retryEstimate} hitSlop={6} style={s.fareRetry}>
                    <Text style={s.fareRetryText}>تلاش مجدد</Text>
                  </Pressable>
                </View>
              )}
            </View>

            <View style={s.payRow}>
              {(['CASH', 'WALLET'] as const).map((m) => (
                <Pressable
                  key={m}
                  onPress={() => setPaymentMethod(m)}
                  style={({ pressed }) => [
                    s.payBtn,
                    paymentMethod === m && s.payBtnActive,
                    pressed && { opacity: 0.9 },
                  ]}
                >
                  <Text style={[s.payText, paymentMethod === m && s.payTextActive]}>
                    {m === 'CASH' ? 'پرداخت نقدی' : `کیف پول (${formatToman(walletBalance ?? 0)} تومان)`}
                  </Text>
                </Pressable>
              ))}
            </View>

            {tripError ? <Text style={s.tripError} numberOfLines={2}>{tripError}</Text> : null}
          </View>
        )}

        <View style={stage === 'result' ? s.resultActions : undefined}>
          <Pressable
            style={({ pressed }) => [
              s.mainBtn,
              stage === 'result' && s.resultMainBtn,
              (mainDisabled || creatingTrip) && s.mainBtnDisabled,
              pressed && !mainDisabled && { opacity: 0.92 },
            ]}
            onPress={mainHandler}
            disabled={mainDisabled || creatingTrip}
          >
            {creatingTrip ? (
              <View style={s.mainBtnBusy}>
                <ActivityIndicator color="#fff" size="small" />
                <Text style={s.mainBtnText}>در حال هماهنگی با سفیران...</Text>
              </View>
            ) : (
              <Text style={s.mainBtnText}>{mainLabel}</Text>
            )}
          </Pressable>
          {stage === 'result' ? (
            <Pressable style={({ pressed }) => [s.cancelPreviewBtn, pressed && { opacity: 0.8 }]} onPress={() => {
              setStage('origin'); setOrigin(null); setDest(null); setEstimate(null); setTripError(null); setPaymentMethod('CASH');
            }}>
              <Text style={s.cancelPreviewText}>انصراف</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg, position: 'relative' },
  mapArea: { flex: 1 },

  locateOverlay: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 60 },
  locateOverlayCard: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 10,
    backgroundColor: COLORS.surface, borderRadius: RADIUS.full,
    paddingVertical: 10, paddingHorizontal: SPACING.lg,
    borderWidth: 1, borderColor: COLORS.border, ...SHADOW.md,
  },
  locateOverlayText: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.text },
  locateErrorCard: { gap: 0, paddingHorizontal: SPACING.md },
  locateErrorText: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.error, paddingHorizontal: SPACING.sm },
  locateRetry: {
    backgroundColor: COLORS.error, borderRadius: RADIUS.full,
    paddingVertical: 6, paddingHorizontal: SPACING.md, marginHorizontal: SPACING.sm,
  },
  locateRetryText: { fontFamily: FONTS.medium, fontSize: 12, color: '#fff' },

  searchPill: {
    position: 'absolute', left: SPACING.lg, right: 76, // room for the single menu button (44 + gaps)
    flexDirection: 'row-reverse', alignItems: 'center', gap: 10,
    backgroundColor: '#FFFFFF', borderRadius: RADIUS.full,
    paddingVertical: 13, paddingHorizontal: 16,
     zIndex: 50,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 8,
  },
  searchPillText: { flex: 1, fontFamily: FONTS.medium, fontSize: 13, color: COLORS.textSecondary, textAlign: 'right' },

  headerActions: {
    position: 'absolute', right: SPACING.lg, flexDirection: 'row-reverse', gap: 8, zIndex: 60,
  },
  headerBtn: {
    width: 44, height: 44, borderRadius: 22, backgroundColor: '#FFFFFF',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 8,
  },

  searchOverlay: { position: 'absolute', left: 0, right: 0, zIndex: 70, paddingHorizontal: SPACING.lg },
  searchRow: {
    flexDirection: 'row-reverse', alignItems: 'center',
    backgroundColor: COLORS.surface, borderRadius: RADIUS.lg,
     paddingHorizontal: 10, paddingVertical: 6,
    ...SHADOW.md,
  },
  searchClose: { width: 36, height: 36, justifyContent: 'center', alignItems: 'center' },
  searchInput: { flex: 1, fontFamily: FONTS.regular, fontSize: 14, color: COLORS.text, paddingVertical: 8, textAlign: 'right', writingDirection: 'rtl' as any, outlineStyle: 'none' as any },
  searchMeta: { alignItems: 'center', paddingTop: 4 },
  searchMetaCard: {
    width: '100%', backgroundColor: COLORS.surface, borderRadius: RADIUS.lg,
    paddingVertical: 12, paddingHorizontal: SPACING.lg, marginTop: 6,
  },
  searchMetaText: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textSecondary, textAlign: 'right' },
  resultList: {
    backgroundColor: COLORS.surface, borderRadius: RADIUS.lg,
     marginTop: 6, maxHeight: 260,
  },
  resultItem: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: SPACING.md,
    borderBottomWidth: 1, borderBottomColor: COLORS.divider,
  },
  resultItemPressed: { backgroundColor: COLORS.bg },
  resultTextWrap: { flex: 1 },
  resultTitle: { fontFamily: FONTS.medium, fontSize: 14, color: COLORS.text, textAlign: 'right' },
  resultAddr: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.textSecondary, marginTop: 2, textAlign: 'right' },

  locateFab: {
    position: 'absolute', right: SPACING.lg, zIndex: 50,
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: '#FFFFFF',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 8,
  },

  panel: {
    position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 40,
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)',
    paddingTop: 12, paddingHorizontal: SPACING.xl,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 24,
  },
  panelHandle: {
    width: 38, height: 4.5, borderRadius: 3,
    backgroundColor: '#CBD5E1',
    alignSelf: 'center', marginBottom: 14,
  },

  originBadgeRow: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 8,
    backgroundColor: '#F8FAFC', borderRadius: RADIUS.lg,
    paddingVertical: 10, paddingHorizontal: 14,
    marginBottom: 14,
    borderWidth: 1, borderColor: '#E2E8F0',
  },
  badgeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.pinOrigin },
  originBadgeLabel: { fontFamily: FONTS.medium, fontSize: 12, color: COLORS.textSecondary },
  originBadgeAddr: { flex: 1, fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.text, textAlign: 'right' },
  badgeEditBtn: {
    backgroundColor: 'rgba(15, 169, 88, 0.1)',
    borderRadius: RADIUS.full, paddingVertical: 4, paddingHorizontal: 10,
  },
  badgeEditText: { fontFamily: FONTS.bold, fontSize: 11, color: COLORS.brand },

  resultWrap: { width: '100%', marginBottom: 8 },
  routeCard: {
    backgroundColor: '#F8FAFC', borderRadius: RADIUS.lg,
    padding: 14, borderWidth: 1, borderColor: '#E2E8F0',
    marginBottom: 12,
  },
  itinRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  pointDot: { width: 10, height: 10, borderRadius: 5 },
  itinContent: { flex: 1, alignItems: 'flex-end' },
  itinLabel: { fontFamily: FONTS.regular, fontSize: 11, color: COLORS.textTertiary, textAlign: 'right', writingDirection: 'rtl' as any },
  itinText: { fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.text, marginTop: 1, textAlign: 'right', writingDirection: 'rtl' as any },
  connectorLine: { width: 2, height: 16, backgroundColor: '#CBD5E1', marginRight: 4, marginVertical: 3 },
  editChipWrap: {
    backgroundColor: 'rgba(15, 169, 88, 0.1)', borderRadius: RADIUS.full,
    paddingVertical: 4, paddingHorizontal: 10,
  },
  editChip: { fontFamily: FONTS.bold, fontSize: 11, color: COLORS.brand },

  fareCard: {
    backgroundColor: '#FFFFFF', borderRadius: RADIUS.lg,
    padding: 16, marginBottom: 12,
    borderWidth: 1, borderColor: '#E2E8F0',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 2,
  },
  fareRow: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between' },
  farePriceGroup: { flexDirection: 'row-reverse', alignItems: 'baseline', gap: 5 },
  farePrice: { fontFamily: FONTS.bold, fontSize: 24, color: COLORS.text, letterSpacing: -0.5 },
  fareCurrency: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.textSecondary },
  fareMetrics: { flexDirection: 'row-reverse', gap: 8 },
  fareMetricBadge: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 4,
    backgroundColor: '#F1F5F9', borderRadius: RADIUS.full,
    paddingVertical: 5, paddingHorizontal: 10,
  },
  fareMetricText: { fontFamily: FONTS.medium, fontSize: 12, color: COLORS.textSecondary },
  fareLoading: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 10 },
  fareLoadingText: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textSecondary },
  fareError: { alignItems: 'center', paddingVertical: 6 },
  fareErrorText: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.error, textAlign: 'center' },
  fareRetry: { marginTop: 8 },
  fareRetryText: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.brand },

  payRow: {
    flexDirection: 'row-reverse', gap: SPACING.sm, marginBottom: 14,
  },
  payBtn: {
    flex: 1, borderWidth: 1.5, borderColor: '#E2E8F0', borderRadius: RADIUS.lg,
    paddingVertical: 12, alignItems: 'center', backgroundColor: '#FFFFFF',
  },
   payBtnActive: { borderColor: COLORS.success, backgroundColor: 'rgba(22, 163, 74, 0.08)' },
  payText: { fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.textSecondary },
  payTextActive: { color: COLORS.brand, fontFamily: FONTS.bold },
  tripError: {
    fontFamily: FONTS.regular, fontSize: 12, color: COLORS.error,
    textAlign: 'center', marginBottom: 10,
  },

  mainBtn: {
    backgroundColor: COLORS.brand, borderRadius: RADIUS.lg,
    paddingVertical: 17, alignItems: 'center', justifyContent: 'center',
    shadowColor: COLORS.brand,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 8,
  },
  mainBtnDisabled: { opacity: 0.5, shadowOpacity: 0 },
  mainBtnText: { fontFamily: FONTS.bold, fontSize: 16, color: '#FFFFFF', letterSpacing: -0.2 },
  mainBtnBusy: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  resultActions: { flexDirection: 'row-reverse', gap: SPACING.sm },
  resultMainBtn: { flex: 1 },
  cancelPreviewBtn: { width: 84, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.bg, alignItems: 'center', justifyContent: 'center' },
  cancelPreviewText: { fontFamily: FONTS.bold, fontSize: 14, color: COLORS.textSecondary },
});
