import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator,
} from 'react-native';
import { api } from '../../services/api';
import { socketService } from '../../services/socket';
import { initNotifications, notifyEvent } from '../../services/notifications';
import { useAuth } from '../../context/AuthContext';
import { CabMap, NeshanMapRef } from '../../components/CabMap';
import { PersonIcon, PhoneIcon, ArrowRightIcon, AlertIcon } from '../../components/Icons';
import ConfirmDialog from '../../components/ConfirmDialog';
import { COLORS, FONTS, SPACING, RADIUS, SHADOW, formatToman } from '../../utils/theme';
import { decodePolyline } from '../../utils/geo';
import { Trip, TripStatus } from '../../types';

/**
 * Status copy mirrors the actual backend lifecycle
 * (SEARCHING → OFFERED → ACCEPTED → DRIVER_ARRIVING → DRIVER_ARRIVED → IN_PROGRESS → terminal).
 * Nothing is declared before the backend reports it.
 */
const STATUS_META: Record<TripStatus, { label: string; tone: 'searching' | 'info' | 'ok' | 'error' }> = {
  SEARCHING: { label: 'در حال ارسال درخواست به سفیران...', tone: 'searching' },
  OFFERED: { label: 'درخواست به سفیران ارسال شد؛ در انتظار پذیرش...', tone: 'searching' },
  ACCEPTED: { label: 'سفیر سفر را پذیرفت', tone: 'ok' },
  DRIVER_ARRIVING: { label: 'سفیر در مسیر رسیدن به مبدأ', tone: 'ok' },
  DRIVER_ARRIVED: { label: 'سفیر منتظر شماست', tone: 'ok' },
  IN_PROGRESS: { label: 'سفر در جریان است', tone: 'ok' },
  COMPLETED: { label: 'سفر با موفقیت به پایان رسید', tone: 'info' },
  CANCELLED: { label: 'سفر لغو شد', tone: 'error' },
  NO_DRIVER_AVAILABLE: { label: 'سفیری یافت نشد؛ می‌توانید درخواست جدید ثبت کنید', tone: 'error' },
};

/** Bounded retry policy (§ride-search):
 *  - The search window is 150 s. The backend — not a local timer — decides
 *    whether the request is still pending; the window only gates how often we
 *    re-verify and re-dispatch.
 *  - At most ONE automatic re-dispatch per trip, on the SAME trip id via
 *    `PUT /trips/:id/retry` (no duplicate ride creation). A second 150 s window
 *    runs after the retry; beyond that the honest final state is shown.
 *  - The counter lives in refs: re-renders, reconnects and screen re-entries
 *    never reset it. Driver acceptance always preempts any pending retry.
 */
const SEARCH_WINDOW_MS = 150_000;
const MAX_RETRIES = 1;
const ACTIVE_STATUSES: TripStatus[] = ['SEARCHING', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED', 'IN_PROGRESS'];

export default function ActiveTripScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { tripId } = useLocalSearchParams<{ tripId: string }>();
  const { user } = useAuth();

  const [trip, setTrip] = useState<Trip | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [driverLoc, setDriverLoc] = useState<{ lat: number; lng: number } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const retriedTripIds = useRef<Set<string>>(new Set()); // ≤1 retry per trip, screen re-entries included
  const verifyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localCancel = useRef(false);
  const retryNoticeRef = useRef<string | null>(null);
  const prevStatus = useRef<TripStatus | null>(null);
  const tripIdRef = useRef<string | null>(null);
  tripIdRef.current = trip?.id ?? null;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => () => { if (verifyTimer.current) clearTimeout(verifyTimer.current); }, []);
  useEffect(() => {
    initNotifications().catch(() => {});
  }, []);

  // Fit both confirmed points once per trip (never on every state change, so
  // the camera never jumps back to defaults while the passenger pans).
  useEffect(() => {
    if (!trip || fitted.current === trip.id) return;
    fitted.current = trip.id;
    const route = trip.routeGeoJson ? decodePolyline(trip.routeGeoJson) : [];
    mapRef.current?.fitToCoordinates(route.length > 1 ? route : [
      { latitude: trip.originLat, longitude: trip.originLng },
      { latitude: trip.destLat, longitude: trip.destLng },
    ], 140);
  }, [trip?.id]);

  // Initial fetch: by explicit tripId, falling back to the active trip.
  const fetchTrip = useCallback(async () => {
    try {
      const r = tripId ? await api.getTrip(tripId) : await api.getActiveTrip();
      if (mounted.current) setTrip(r);
      return r;
    } catch (e: any) {
      if (mounted.current) setError(e?.message || 'خطا در دریافت وضعیت سفر');
    } finally {
      if (mounted.current) setLoading(false);
    }
    return null;
  }, [tripId]);

  useEffect(() => {
    fetchTrip();
  }, [fetchTrip]);

  const status = trip?.status as TripStatus | undefined;

  /**
   * Re-dispatch policy. Runs whenever the backend itself confirms
   * NO_DRIVER_AVAILABLE (event or poll — the source of truth is always the
   * server). At most one retry per trip id, on the same trip; a late driver
   * acceptance immediately supersedes it.
   */
  const attemptRetry = useCallback(async (cur: Trip) => {
    if (retriedTripIds.current.has(cur.id)) return;
    retriedTripIds.current.add(cur.id);
    setRetryNotice('هنوز سفیری پیدا نشده؛ در حال تلاش مجدد...');
    try {
      const updated = await api.retryTrip(cur.id);
      if (mounted.current && updated?.status) setTrip(updated);
    } catch {
      if (mounted.current) setRetryNotice(null); // fall back to the honest final state
    }
  }, []);

  // Window re-verification: every 150 s while the request is still SEARCHING/
  // OFFERED, re-check the authoritative status instead of trusting the timer.
  // A retry (status flipped back to SEARCHING) re-arms its own fresh window.
  useEffect(() => {
    if (verifyTimer.current) clearTimeout(verifyTimer.current);
    if (!status || !['SEARCHING', 'OFFERED'].includes(status)) return;
    const id = tripIdRef.current;
    verifyTimer.current = setTimeout(async () => {
      if (!mounted.current || !id) return;
      const r = await api.getTrip(id).catch(() => null);
      if (!mounted.current || !r) return;
      setTrip((p) => (p && p.id === r.id ? { ...p, ...r } : p));
    }, SEARCH_WINDOW_MS);
    return () => { if (verifyTimer.current) clearTimeout(verifyTimer.current); };
  }, [status]);

  // Backend-confirmed "no driver": the server finished its search pass —
  // initiate the single re-dispatch immediately (acceptance preempts it).
  useEffect(() => { retryNoticeRef.current = retryNotice; }, [retryNotice]);
  useEffect(() => {
    if (status === 'NO_DRIVER_AVAILABLE' && trip?.id) attemptRetry(trip);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // While the request is still being offered around, a light poll keeps the
  // passenger's copy in sync (socket events remain the primary channel).
  useEffect(() => {
    if (!status || !['SEARCHING', 'OFFERED'].includes(status)) return;
    const t = setInterval(() => { fetchTrip(); }, 7000);
    return () => clearInterval(t);
  }, [status, fetchTrip]);

  // Socket updates.
  useEffect(() => {
    if (!trip) return;
    socketService.joinTrip(trip.id);
    const unsubs = [
      socketService.on('trip:status', (d: { tripId: string; status: string }) => {
        if (d.tripId !== trip.id || !d.status) return;
        setTrip((p) => (p ? { ...p, status: d.status as TripStatus } : p));
      }),
      socketService.on('trip:accepted', (_d: unknown) => {
        if (!mounted.current) return;
        notifyEvent({ tag: `accepted:${trip.id}`, title: 'سفیر سفر را پذیرفت', body: 'جزئیات سفیر نمایش داده شد' });
        fetchTrip(); // pull full trip record incl. driver info
      }),
      socketService.on('trip:cancelled', () => {
        setTrip((p) => (p ? { ...p, status: 'CANCELLED' } : p));
      }),
      socketService.on('driver:location', (d: { tripId: string; latitude: number; longitude: number }) => {
        if (d.tripId === trip.id) setDriverLoc({ lat: d.latitude, lng: d.longitude });
      }),
    ];
    // Reconnect: rooms are dropped server-side — rejoin and reconcile.
    const offConnect = socketService.onConnect(() => {
      socketService.joinTrip(trip.id);
      fetchTrip();
    });
    return () => { unsubs.forEach((u) => u()); offConnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.id]);

  // ---- Lifecycle announcements (sound + local notification) --------------------
  // Fired on real backend transitions only; self-initiated cancellations stay
  // quiet, and the tag dedupes repeated deliveries of the same event.
  useEffect(() => {
    if (!status || !trip?.id) return;
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (prev === status) return;
    if (prev === null && status !== 'ACCEPTED' && status !== 'DRIVER_ARRIVED' && status !== 'COMPLETED') return;
    switch (status) {
      case 'ACCEPTED':
        notifyEvent({ tag: `accepted:${trip.id}`, title: 'سفیر سفر را پذیرفت', body: trip.driver ? `${trip.driver.firstName} ${trip.driver.lastName}` : undefined });
        break;
      case 'DRIVER_ARRIVED':
        notifyEvent({ tag: `arrived:${trip.id}`, title: 'سفیر به مبدأ رسید', body: 'سفیر منتظر شماست' });
        break;
      case 'IN_PROGRESS':
        notifyEvent({ tag: `started:${trip.id}`, title: 'سفر شروع شد', body: 'سفر در جریان است' });
        break;
      case 'COMPLETED':
        notifyEvent({ tag: `completed:${trip.id}`, title: 'سفر به پایان رسید', body: 'ممنون از همراهی شما' });
        break;
      case 'CANCELLED':
        if (localCancel.current) break;
        notifyEvent({ tag: `cancelled:${trip.id}`, title: 'سفر لغو شد', body: undefined });
        break;
      case 'NO_DRIVER_AVAILABLE':
        if (retriedTripIds.current.has(trip.id)) {
          notifyEvent({ tag: `nodriver:${trip.id}`, title: 'سفیری در دسترس نیست', body: 'می‌توانید درخواست جدیدی ثبت کنید' });
        }
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);
  const [cancelDialog, setCancelDialog] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const mapRef = useRef<NeshanMapRef>(null);
  const fitted = useRef<string | null>(null);
  const handleCancel = useCallback(() => {
    if (!trip || cancelling) return;
    setCancelDialog(true);
  }, [trip, cancelling]);

  const doCancel = useCallback(async () => {
    if (!trip) return;
    setCancelDialog(false);
    localCancel.current = true;
    setCancelling(true);
    try {
      await api.cancelTrip(trip.id);
      router.replace('/(passenger)');
    } catch (e: any) {
      localCancel.current = false;
      setDialogError(e?.message || 'لغو ناموفق بود. دوباره تلاش کنید');
    } finally {
      setCancelling(false);
    }
  }, [trip, router]);

  const stats = useMemo(() => {
    if (!trip) return null;
    return { distanceKm: trip.distanceKm, durationMin: trip.durationMin, estimatedPrice: trip.estimatedPrice };
  }, [trip?.distanceKm, trip?.durationMin, trip?.estimatedPrice]);

  const markers = useMemo(() => {
    if (!trip) return [];
    const m: any[] = [{ id: 'origin', latitude: trip.originLat, longitude: trip.originLng, color: COLORS.pinOrigin, label: 'مبدأ' }];
    m.push({ id: 'dest', latitude: trip.destLat, longitude: trip.destLng, color: COLORS.pinDest, label: 'مقصد' });
    if (driverLoc) m.push({ id: 'driver', latitude: driverLoc.lat, longitude: driverLoc.lng, color: COLORS.pinDriver, label: 'سفیر' });
    return m;
  }, [trip?.id, trip?.originLat, trip?.originLng, trip?.destLat, trip?.destLng, driverLoc?.lat, driverLoc?.lng]);

  // Real road geometry captured at trip creation; nothing is drawn when the
  // provider did not return a route (no misleading straight line).
  const polyline = useMemo(() => {
    if (!trip) return null;
    if (trip.routeGeoJson) {
      const decoded = decodePolyline(trip.routeGeoJson);
      if (decoded.length > 1) {
        return { coordinates: decoded, color: COLORS.pinOrigin, to: COLORS.pinDest, width: 5 };
      }
    }
    return null;
  }, [trip?.id, trip?.routeGeoJson, trip?.originLat, trip?.originLng, trip?.destLat, trip?.destLng]);

  if (loading) {
    return (
      <View style={[s.centerWrap, { paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={COLORS.brand} />
        <Text style={s.centerText}>در حال بررسی وضعیت سفر...</Text>
      </View>
    );
  }

  if (error || !trip) {
    return (
      <View style={[s.centerWrap, { paddingTop: insets.top }]}>
        <AlertIcon size={40} color={COLORS.error} />
        <Text style={[s.centerText, { marginTop: SPACING.md }]}>
          {error || 'سفر فعالی یافت نشد'}
        </Text>
        <Pressable style={s.btnPrimary} onPress={() => router.replace('/(passenger)')}>
          <Text style={s.btnPrimaryText}>بازگشت به صفحه اصلی</Text>
        </Pressable>
      </View>
    );
  }

  const meta = STATUS_META[trip.status as TripStatus] || { label: trip.status, tone: 'info' as const };
  const canCancel = ['SEARCHING', 'OFFERED', 'ACCEPTED', 'DRIVER_ARRIVING', 'DRIVER_ARRIVED'].includes(trip.status);
  const ended = ['COMPLETED', 'CANCELLED', 'NO_DRIVER_AVAILABLE'].includes(trip.status);

  return (
    <View style={s.container}>
      <View style={s.mapArea}>
        <CabMap
          mapRef={mapRef}
          initialRegion={{ latitude: trip.originLat, longitude: trip.originLng, zoom: 14 }}
          markers={markers}
          polyline={polyline}
        />
      </View>

      <View style={[s.header, { top: insets.top + 10 }]}>
        <Pressable style={s.headerBtn} onPress={() => router.back()} accessibilityLabel="بازگشت">
          <ArrowRightIcon size={18} />
        </Pressable>
        <Text style={s.headerTitle}>{ended ? 'نتیجه سفر' : 'سفر فعال'}</Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={[s.panel, { paddingBottom: insets.bottom + 18 }]}>
        <View style={[s.statusCard, { borderStartColor: toneColor(meta.tone) }]}>
          <View style={s.statusRow}>
            {meta.tone === 'searching' && <ActivityIndicator size="small" color={COLORS.brand} />}
            <Text style={[s.statusText, meta.tone === 'error' && { color: COLORS.error }]}>{meta.label}</Text>
          </View>
        </View>

        {/* Driver info appears only once the backend actually assigned one. */}
        {trip.driver ? (
          <View style={s.driverCard}>
            <PersonIcon size={40} color={COLORS.brand} />
            <View style={s.driverTextWrap}>
              <Text style={s.driverName}>{trip.driver.firstName} {trip.driver.lastName}</Text>
              <View style={s.driverPhoneRow}>
                <PhoneIcon size={13} color={COLORS.textSecondary} />
                <Text style={s.driverPhone}>{trip.driver.phone}</Text>
              </View>
            </View>
          </View>
        ) : meta.tone === 'searching' ? (
          <Text style={s.driverPending}>به‌محض پذیرش سفیر، اطلاعات او اینجا نمایش داده می‌شود.</Text>
        ) : null}

        {stats && (
          <View style={s.infoCard}>
            <InfoRow label="مبدأ" value={trip.originAddress} />
            <InfoRow label="مقصد" value={trip.destAddress} />
            <View style={s.infoDivider} />
            <InfoRow label="مسافت" value={`${stats.distanceKm.toLocaleString('fa-IR')} کیلومتر`} />
            <InfoRow label="مدت" value={`حدود ${stats.durationMin.toLocaleString('fa-IR')} دقیقه`} />
            <InfoRow label="کرایه" value={`${formatToman(stats.estimatedPrice)} تومان`} accent />
          </View>
        )}

        {canCancel && (
          <Pressable style={({ pressed }) => [s.btnGhost, pressed && { opacity: 0.9 }, cancelling && { opacity: 0.5 }]}
            onPress={handleCancel} disabled={cancelling}>
            {cancelling ? <ActivityIndicator size="small" color={COLORS.error} /> : null}
            <Text style={s.btnGhostText}>لغو درخواست</Text>
          </Pressable>
        )}
        {ended && (
          <Pressable style={s.btnPrimary} onPress={() => router.replace('/(passenger)')}>
            <Text style={s.btnPrimaryText}>بازگشت به صفحه اصلی</Text>
          </Pressable>
        )}
      </View>

      <ConfirmDialog
        visible={cancelDialog}
        title="لغو سفر"
        description="آیا از لغو این درخواست مطمئن هستید؟"
        confirmText="لغو سفر"
        danger
        onCancel={() => setCancelDialog(false)}
        onConfirm={doCancel}
      />
      <ConfirmDialog
        visible={!!dialogError}
        title="لغو ناموفق بود"
        description={dialogError || ''}
        confirmText="متوجه شدم"
        onCancel={() => setDialogError(null)}
        onConfirm={() => setDialogError(null)}
      />
    </View>
  );
}

function toneColor(tone: string): string {
  return tone === 'error' ? COLORS.error : tone === 'info' ? COLORS.textTertiary : COLORS.brand;
}

function InfoRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <View style={s.infoRow}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={[s.infoValue, accent && s.infoValueAccent]} numberOfLines={1}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  mapArea: { flex: 1 },

  header: {
    position: 'absolute', left: SPACING.lg, right: SPACING.lg, zIndex: 50,
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
  },
  headerBtn: {
    width: 42, height: 42, borderRadius: 21, backgroundColor: COLORS.surface,
    borderWidth: 1, borderColor: COLORS.border,
    justifyContent: 'center', alignItems: 'center', ...SHADOW.md,
  },
  headerTitle: {
    fontFamily: FONTS.bold, fontSize: 15, color: COLORS.text,
    backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border,
    paddingVertical: 8, paddingHorizontal: 18, borderRadius: RADIUS.full, overflow: 'hidden',
  },

  panel: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    borderTopWidth: 1, borderTopColor: COLORS.border,
    paddingTop: SPACING.lg, paddingHorizontal: SPACING.xl,
  },

  statusCard: {
    borderRadius: RADIUS.md, backgroundColor: COLORS.bg,
    borderRightWidth: 3.5, paddingVertical: 10, paddingHorizontal: SPACING.md,
    marginBottom: SPACING.md,
  },
  statusRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 10 },
  statusText: { flex: 1, fontFamily: FONTS.semibold, fontSize: 14, color: COLORS.text, textAlign: 'right', lineHeight: 21 },

  driverCard: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 12,
    backgroundColor: COLORS.brandSoft, borderRadius: RADIUS.md,
    padding: SPACING.md, marginBottom: SPACING.md,
  },
  driverTextWrap: { flex: 1 },
  driverName: { fontFamily: FONTS.bold, fontSize: 15, color: COLORS.text, textAlign: 'right' },
  driverPhoneRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 5, marginTop: 2 },
  driverPhone: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textSecondary, writingDirection: 'ltr' as any },
  driverPending: {
    fontFamily: FONTS.regular, fontSize: 12, color: COLORS.textTertiary,
    textAlign: 'center', marginBottom: SPACING.md,
  },

  infoCard: { marginBottom: SPACING.md },
  infoRow: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 5 },
  infoLabel: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textSecondary },
  infoValue: { flex: 1, fontFamily: FONTS.medium, fontSize: 13, color: COLORS.text, textAlign: 'left', marginLeft: SPACING.md },
  infoValueAccent: { fontFamily: FONTS.bold, color: COLORS.brand, fontSize: 15 },
  infoDivider: { height: 1, backgroundColor: COLORS.divider, marginVertical: 6 },

  btnGhost: {
    flexDirection: 'row-reverse', justifyContent: 'center', gap: 8,
    borderWidth: 1.2, borderColor: COLORS.error, borderRadius: RADIUS.lg,
    paddingVertical: 13,
  },
  btnGhostText: { fontFamily: FONTS.semibold, fontSize: 15, color: COLORS.error },
  btnPrimary: {
    backgroundColor: COLORS.brand, borderRadius: RADIUS.lg,
    paddingVertical: 15, alignItems: 'center', justifyContent: 'center',
  },
  btnPrimaryText: { fontFamily: FONTS.bold, fontSize: 15, color: '#fff' },

  centerWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: SPACING.xxl, backgroundColor: COLORS.bg },
  centerText: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.textSecondary, textAlign: 'center', marginTop: 16 },
});
