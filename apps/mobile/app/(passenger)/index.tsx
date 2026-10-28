import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator,
  FlatList, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { CabMap, NeshanMapRef } from '../../components/CabMap';
import { LocateIcon, LocateOffIcon, SearchIcon, LogoutIcon, CloseIcon, ClockIcon, RoadIcon, HistoryIcon, PersonIcon } from '../../components/Icons';
import { api } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { COLORS, FONTS, SPACING, RADIUS, SHADOW, formatToman } from '../../utils/theme';
import { decodePolyline, thinPolyline, coordKey, makeArc } from '../../utils/geo';

type Point = { lat: number; lng: number; addr: string };
type Stage = 'origin' | 'dest' | 'result';
type LocationPhase = 'idle' | 'acquiring' | 'error';

const TEHRAN = { lat: 35.6892, lng: 51.389 };

/** Addresses resolved at confirmation time, cached by normalized coordinate. */
let geocodeCache: Record<string, string> = {};
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
  const { logout } = useAuth();
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

  // ---- Fare / submission -----------------------------------------------------
  const [estimate, setEstimate] = useState<{ distanceKm: number; durationMin: number; estimatedPrice: number } | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [creatingTrip, setCreatingTrip] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<'CASH' | 'WALLET'>('CASH');
  const [tripError, setTripError] = useState<string | null>(null);
  const panelH = useRef(0);

  // ---- Reverse geocoding: single cached lookup per CONFIRMED point -------------
  // The service is expensive: it is never called while the user pans, zooms
  // or browses search results. Lookups happen only when a point is explicitly
  // confirmed (or on-demand for the preview), behind this cache; failures keep
  // the neutral fallback (no fabricated address) and stay retryable.
  const resolveAddress = useCallback(async (lat: number, lng: number): Promise<string> => {
    const key = coordKey(lat, lng);
    const cached = geocodeCache[key];
    if (cached) return cached;
    try {
      const r = await api.reverseGeocode(lat, lng);
      if (r?.address) geocodeCache[key] = r.address;
      return r?.address || '';
    } catch {
      return ''; // neutral fallback, no fabricated address
    }
  }, []);

  // Reported by the map itself after every camera settle.
  // No service calls here — moving the map costs nothing.
  const onMapSettle = useCallback((lat: number, lng: number) => {
    centerRef.current = { lat, lng, addr: '' };
  }, []);

  // ---- Locate me: explicit request, loading state, no auto-confirm ------------
  const runLocate = useCallback(async () => {
    if (locating.current) return; // no duplicate requests
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
    if (typeof lat === 'number' && typeof lng === 'number') {
      mapRef.current?.animateTo(lat, lng, 16.5);
      centerRef.current = { lat, lng, addr: '' };
      // Seed the address cache with the provider's own data — no geocode call needed.
      const addr = [item.title, item.address].filter(Boolean).join('، ');
      if (addr) geocodeCache[coordKey(lat, lng)] = addr;
    }
    setSearchOpen(false);
    setSearchQ('');
    setSearchResults([]);
  }, []);

  // ---- Explicit stage transitions ---------------------------------------------
  // Confirming a point snapshots the coordinate immediately; its address is
  // then filled in from the single cached lookup (or the provider fallback)
  // without ever re-associating the address with a different coordinate.
  const confirmOrigin = useCallback(() => {
    const c = centerRef.current;
    const point: Point = { lat: c.lat, lng: c.lng, addr: 'موقعیت انتخاب‌شده' };
    setEstimate(null);
    setEstimateError(null);
    // If a destination already exists (origin edited later) → back to review,
    // keeping the untouched destination. Never silently erase it.
    setStage(dest ? 'result' : 'dest');
    setOrigin(point);
    resolveAddress(point.lat, point.lng).then((addr) => {
      // Guard: user may have re-confirmed a different point meanwhile.
      setOrigin((p) => (p && p.lat === point.lat && p.lng === point.lng ? { ...p, addr: addr || p.addr } : p));
    });
  }, [dest, resolveAddress]);

  const confirmDest = useCallback(() => {
    const c = centerRef.current;
    const point: Point = { lat: c.lat, lng: c.lng, addr: 'موقعیت انتخاب‌شده' };
    setDest(point);
    setStage('result');
    resolveAddress(point.lat, point.lng).then((addr) => {
      setDest((p) => (p && p.lat === point.lat && p.lng === point.lng ? { ...p, addr: addr || p.addr } : p));
    });
  }, [resolveAddress]);

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
      setEstimate({ distanceKm: cached.distanceKm, durationMin: cached.durationMin, estimatedPrice: cached.estimatedPrice });
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
      setEstimate({ distanceKm: r.distanceKm, durationMin: r.durationMin, estimatedPrice: r.estimatedPrice });
      // Lookups resolved with the estimate are authoritative for these exact
      // coordinates — fill the itinerary rows without extra geocode calls.
      if (r.originAddress) geocodeCache[coordKey(o.lat, o.lng)] = r.originAddress;
      if (r.destAddress) geocodeCache[coordKey(d.lat, d.lng)] = r.destAddress;
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
    const enc = estimateCache[key]?.route;
    if (enc) {
      // Real road geometry from the routing API is authoritative.
      const decoded = thinPolyline(decodePolyline(enc));
      if (decoded.length > 1) {
        return { coordinates: decoded, color: COLORS.pinOrigin, to: COLORS.pinDest, width: 5 };
      }
    }
    // No road geometry available: a restrained decorative arc keeps the
    // preview readable and is never presented as a navigable route.
    return {
      coordinates: makeArc(
        { latitude: origin.lat, longitude: origin.lng },
        { latitude: dest.lat, longitude: dest.lng }
      ),
      color: COLORS.pinOrigin,
      to: COLORS.pinDest,
      width: 5,
    };
  }, [stage, origin?.lat, origin?.lng, dest?.lat, dest?.lng]);

  useEffect(() => {
    if (stage === 'result' && origin && dest) {
      fetchEstimate(origin, dest);
      mapRef.current?.fitToCoordinates(
        [
          { latitude: origin.lat, longitude: origin.lng },
          { latitude: dest.lat, longitude: dest.lng },
        ],
        100
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  const retryEstimate = useCallback(() => {
    if (origin && dest) fetchEstimate(origin, dest);
  }, [origin, dest, fetchEstimate]);

  // ---- Submit -----------------------------------------------------------------
  const submitTrip = useCallback(async () => {
    if (!origin || !dest || creatingTrip) return;
    setCreatingTrip(true);
    setTripError(null);
    try {
      const trip = await api.createTrip(origin.lat, origin.lng, origin.addr, dest.lat, dest.lng, dest.addr, paymentMethod);
      router.push({ pathname: '/(passenger)/active-trip', params: { tripId: trip.id } } as any);
    } catch (e: any) {
      setTripError(e?.message && e.message !== 'Request failed' ? e.message : 'ثبت درخواست سفر ناموفق بود. دوباره تلاش کنید.');
    } finally {
      setCreatingTrip(false);
    }
  }, [origin, dest, creatingTrip, router]);

  const handleLogout = useCallback(async () => {
    try {
      await logout();
    } catch (e) {
      console.warn('[Passenger] logout error', e);
    }
  }, [logout]);

  // ---- Derived, remount-safe map data ------------------------------------------
  const markers = useMemo(() => {
    const m: Array<{ id: string; latitude: number; longitude: number; color?: string; label?: string }> = [];
    if (origin) m.push({ id: 'origin', latitude: origin.lat, longitude: origin.lng, color: COLORS.pinOrigin, label: 'مبدأ' });
    if (stage === 'result' && dest) m.push({ id: 'dest', latitude: dest.lat, longitude: dest.lng, color: COLORS.pinDest, label: 'مقصد' });
    return m;
  }, [origin?.lat, origin?.lng, dest?.lat, dest?.lng, stage]);

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
      {!searchOpen ? (
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
          <View style={[s.headerActions, { top: insets.top + 10 }]}>
            <Pressable
              accessibilityLabel="سفرهای من"
              onPress={() => router.push('/(passenger)/trip-history')}
              style={({ pressed }) => [s.headerBtn, pressed && { opacity: 0.85 }]}
            >
              <HistoryIcon size={20} color={COLORS.textSecondary} />
            </Pressable>
            <Pressable
              accessibilityLabel="پروفایل"
              onPress={() => router.push('/profile')}
              style={({ pressed }) => [s.headerBtn, pressed && { opacity: 0.85 }]}
            >
              <PersonIcon size={20} color={COLORS.textSecondary} />
            </Pressable>
            <Pressable
              accessibilityLabel="خروج از حساب"
              onPress={handleLogout}
              style={({ pressed }) => [s.headerBtn, pressed && { opacity: 0.85 }]}
            >
              <LogoutIcon size={20} color={COLORS.error} />
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
      )}

      {/* ---------------- Locate-me FAB ---------------- */}
      <Pressable
        accessibilityLabel="موقعیت فعلی من"
        disabled={locatePhase === 'acquiring'}
        onPress={runLocate}
        style={({ pressed }) => [s.locateFab, pressed && { opacity: 0.85 }, { bottom: insets.bottom + (panelH.current || 0) + 18 }]}
      >
        {acquiring ? <LocateOffIcon size={22} color={COLORS.textTertiary} /> : <LocateIcon size={22} color={COLORS.brand} />}
      </Pressable>

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
                    {m === 'CASH' ? 'پرداخت نقدی' : 'کیف پول (موجودی)'}
                  </Text>
                </Pressable>
              ))}
            </View>

            {tripError ? <Text style={s.tripError} numberOfLines={2}>{tripError}</Text> : null}
          </View>
        )}

        <Pressable
          style={({ pressed }) => [
            s.mainBtn,
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
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
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
    position: 'absolute', left: SPACING.lg, right: 164,
    flexDirection: 'row-reverse', alignItems: 'center', gap: 10,
    backgroundColor: '#FFFFFF', borderRadius: RADIUS.full,
    paddingVertical: 13, paddingHorizontal: 16,
    borderWidth: 1, borderColor: '#E2E8F0', zIndex: 50,
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
    borderWidth: 1, borderColor: '#E2E8F0',
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
    borderWidth: 1, borderColor: COLORS.border,
    paddingHorizontal: 10, paddingVertical: 6,
    ...SHADOW.md,
  },
  searchClose: { width: 36, height: 36, justifyContent: 'center', alignItems: 'center' },
  searchInput: { flex: 1, fontFamily: FONTS.regular, fontSize: 14, color: COLORS.text, paddingVertical: 8, textAlign: 'right' },
  searchMeta: { alignItems: 'center', paddingTop: 4 },
  searchMetaCard: {
    width: '100%', backgroundColor: COLORS.surface, borderRadius: RADIUS.lg,
    paddingVertical: 12, paddingHorizontal: SPACING.lg, marginTop: 6,
    borderWidth: 1, borderColor: COLORS.border,
  },
  searchMetaText: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textSecondary, textAlign: 'right' },
  resultList: {
    backgroundColor: COLORS.surface, borderRadius: RADIUS.lg,
    marginTop: 6, borderWidth: 1, borderColor: COLORS.border, maxHeight: 260,
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
    backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E2E8F0',
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
  itinLabel: { fontFamily: FONTS.regular, fontSize: 11, color: COLORS.textTertiary },
  itinText: { fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.text, marginTop: 1, textAlign: 'right' },
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
  payBtnActive: { borderColor: COLORS.brand, backgroundColor: 'rgba(15, 169, 88, 0.06)' },
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
});
