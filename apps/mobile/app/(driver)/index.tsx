import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View, Text, StyleSheet, Pressable, ActivityIndicator, Linking, Modal, Platform, ScrollView,
} from 'react-native';
import * as Location from 'expo-location';
import { CabMap, NeshanMapRef } from '../../components/CabMap';
import { api } from '../../services/api';
import { socketService } from '../../services/socket';
import { useAuth } from '../../context/AuthContext';
import { LogoutIcon, PersonIcon, PhoneIcon, CarIcon, CloseIcon, HistoryIcon } from '../../components/Icons';
import ConfirmDialog from '../../components/ConfirmDialog';
import { COLORS, FONTS, SPACING, RADIUS, SHADOW, formatToman, toPersianDigits } from '../../utils/theme';
import { decodePolyline } from '../../utils/geo';
import { Trip, TripStatus } from '../../types';

/** Driver action buttons follow the server's real transition map:
 *  ACCEPTED → DRIVER_ARRIVING → DRIVER_ARRIVED → IN_PROGRESS → COMPLETED.
 */
function driverActions(status: TripStatus | undefined) {
  switch (status) {
    case 'ACCEPTED':
      return { next: 'DRIVER_ARRIVING', label: 'در مسیر به مبدأ' } as const;
    case 'DRIVER_ARRIVING':
      return { next: 'DRIVER_ARRIVED', label: 'رسیدم به مبدأ' } as const;
    case 'DRIVER_ARRIVED':
      return { next: 'IN_PROGRESS', label: 'شروع سفر' } as const;
    case 'IN_PROGRESS':
      return { next: 'COMPLETED', label: 'اتمام سفر' } as const;
    default:
      return null;
  }
}

function bearingBetween(from: { latitude: number; longitude: number }, to: { latitude: number; longitude: number }) {
  const lat1 = from.latitude * Math.PI / 180;
  const lat2 = to.latitude * Math.PI / 180;
  const dLng = (to.longitude - from.longitude) * Math.PI / 180;
  return (Math.atan2(Math.sin(dLng) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)) * 180 / Math.PI + 360) % 360;
}

export default function DriverScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const mapRef = useRef<NeshanMapRef>(null);

  const [isOnline, setIsOnline] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [offers, setOffers] = useState<any[]>([]);
  const [offerIndex, setOfferIndex] = useState(0);
  const [tick, setTick] = useState(Date.now());
  const [loading, setLoading] = useState(true);
  const [toggleBusy, setToggleBusy] = useState<null | 'online' | 'accepting'>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [dialog, setDialog] = useState<null | { title: string; message?: string; danger?: boolean; onConfirm?: () => void; confirmText?: string }>(null);
  const [navSheetVisible, setNavSheetVisible] = useState(false);
  const [routePicking, setRoutePicking] = useState(false);
  const [selectedRoute, setSelectedRoute] = useState<{ latitude: number; longitude: number; radiusKm: number; active: boolean } | null>(null);

  const coordsRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const lastCoordsRef = useRef<{ latitude: number; longitude: number } | null>(null);
  const headingRef = useRef(0);
  const isOnlineRef = useRef(isOnline);
  useEffect(() => { isOnlineRef.current = isOnline; }, [isOnline]);

  const sendDriverLocation = useCallback((latitude: number, longitude: number, nativeHeading?: number | null) => {
    const next = { latitude, longitude };
    const heading = typeof nativeHeading === 'number' && nativeHeading >= 0
      ? nativeHeading
      : lastCoordsRef.current ? bearingBetween(lastCoordsRef.current, next) : headingRef.current;
    coordsRef.current = next;
    lastCoordsRef.current = next;
    headingRef.current = heading;
    if (isOnlineRef.current) socketService.emit('driver:location', { ...next, heading });
  }, []);

  const driverName = user ? `${user.firstName} ${user.lastName}`.trim() : 'سفیر';

  // ---- Init ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let watching: Location.LocationSubscription | null = null;

    (async () => {
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted' && !cancelled) {
          try {
            const currentPos = await Location.getCurrentPositionAsync({ accuracy: 3 });
            if (currentPos?.coords) {
              const lat = currentPos.coords.latitude;
              const lng = currentPos.coords.longitude;
              sendDriverLocation(lat, lng, currentPos.coords.heading);
            }
          } catch {}

          // Keep the driver's stored coordinates fresh for dispatch.
          watching = await Location.watchPositionAsync({ accuracy: 3, timeInterval: 4000, distanceInterval: 10 }, (loc) => {
            const lat = loc.coords.latitude;
            const lng = loc.coords.longitude;
            sendDriverLocation(lat, lng, loc.coords.heading);
          });
        }
        const profile = await api.getProfile();
        if (cancelled) return;
        setIsOnline(!!profile?.driverStatus?.isOnline);
        setIsAccepting(!!profile?.driverStatus?.isAccepting);
        isOnlineRef.current = !!profile?.driverStatus?.isOnline;
        if (isOnlineRef.current && coordsRef.current) {
          sendDriverLocation(coordsRef.current.latitude, coordsRef.current.longitude);
        }
        if (profile?.driverStatus?.selectedLat != null && profile?.driverStatus?.selectedLng != null) {
          console.log('[Driver][SELECTED_ROUTE_PROFILE]', profile.driverStatus);
          setSelectedRoute({
            latitude: profile.driverStatus.selectedLat,
            longitude: profile.driverStatus.selectedLng,
            radiusKm: profile.driverStatus.selectedRadiusKm || 5,
            active: !!profile.driverStatus.selectedActive,
          });
        }
        // Also hit the driver status endpoint on login so the server wakes
        // pending searches even when the trip was created before this socket connected.
        const persistedStatus = await api.getDriverStatus();
        console.log('[Driver][STATUS_ON_LOGIN]', persistedStatus);

        const active = await api.getDriverActiveTrip();
        if (cancelled) return;
        if (active?.id) {
          setTrip(active);
          socketService.joinTrip(active.id);
        }
      } catch (e) {
        console.warn('[Driver] init error:', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    // ---- Socket listeners (real backend events) ----
    const unsubs = [
      // Multiple concurrent requests are kept in a deduplicated list, each
      // with its own independent 15 s expiry — one expiring (or being
      // accepted) never erases the others.
      socketService.on('trip:offer', (data: any) => {
        console.log('[Driver][TRIP_OFFER]', data);
        if (!data?.tripId) return;
        setOffers((prev) => {
          if (prev.some((o) => o.tripId === data.tripId)) return prev;
          const next = [...prev, { ...data, expiresAt: Date.now() + 15000 }];
          // Nearest pickup first — real driver distance from the offer payload.
          return next.sort((a, b) => (a.driverDistanceKm ?? Infinity) - (b.driverDistanceKm ?? Infinity));
        });
      }),
      socketService.on('trip:offer_expired', (data: any) => {
        console.log('[Driver][TRIP_OFFER_EXPIRED]', data);
        setOffers((prev) => prev.filter((o) => o.tripId !== data?.tripId));
      }),
      socketService.on('trip:accepted', (data: any) => {
        console.log('[Driver][TRIP_ACCEPTED]', data);
        setOffers([]);
        if (data?.tripId) {
          api.getTrip(data.tripId).then((t) => {
            if (t && t.driverId === user?.id) {
              setTrip(t);
              socketService.joinTrip(t.id);
              mapRef.current?.animateTo(t.originLat, t.originLng, 15);
            }
          }).catch(() => {});
        }
      }),
      socketService.on('trip:cancelled', () => {
        setTrip(null);
      }),
      socketService.on('trip:status', (data: { tripId: string; status: string }) => {
        setTrip((p) => (p && p.id === data.tripId ? { ...p, status: data.status as TripStatus } : p));
      }),
    ];

    // On every (re)connect — re-join active trip room and pull any offers that
    // arrived while the socket was down (HTTP fallback polling).
    const unsubConnect = socketService.onConnect(async () => {
      // Re-join the trip room so we keep receiving status events after reconnect.
      const activeTripId = await api.getDriverActiveTrip().then((t: any) => t?.id).catch(() => null);
      console.log('[Driver][SOCKET_RECONNECT]', { activeTripId });
      if (activeTripId) socketService.joinTrip(activeTripId);
      // Merge any pending offers we missed during the disconnect window.
      try {
        const pending = await api.getPendingOffers();
        console.log('[Driver][PENDING_OFFERS]', { count: pending?.length || 0, pending });
        if (pending && pending.length > 0) {
          setOffers((prev) => {
            const fresh = pending.filter((o: any) => !prev.some((p) => p.tripId === o.tripId));
            if (!fresh.length) return prev;
            const merged = [...prev, ...fresh.map((o: any) => ({ ...o, expiresAt: Date.now() + 15000 }))];
            return merged.sort((a, b) => (a.driverDistanceKm ?? Infinity) - (b.driverDistanceKm ?? Infinity));
          });
        }
      } catch { /* reconnect polling is best-effort */ }
    });

    return () => {
      cancelled = true;
      if (watching) watching.remove();
      unsubs.forEach((u) => u());
      unsubConnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sendDriverLocation]);

  // ---- Toggles ----------------------------------------------------------------
  const toggleOnline = useCallback(async () => {
    if (toggleBusy) return;
    setToggleBusy('online');
    const next = !isOnline;
    try {
      let coords = coordsRef.current;
      if (next && !coords) {
        try {
          const fresh = await Location.getCurrentPositionAsync({ accuracy: 3 });
          if (fresh?.coords) {
            coords = { latitude: fresh.coords.latitude, longitude: fresh.coords.longitude };
            coordsRef.current = coords;
          }
        } catch {}
      }

      await api.updateDriverStatus({
        isOnline: next,
        ...(next && coords ? { latitude: coords.latitude, longitude: coords.longitude } : {}),
      });
      setIsOnline(next);
      if (next) {
        socketService.emit('driver:status', { isOnline: true });
        if (coords) {
          socketService.emit('driver:location', { ...coords, heading: headingRef.current });
        }
      } else {
        socketService.emit('driver:status', { isOnline: false });
        setIsAccepting(false);
      }
    } catch (e: any) {
      setDialog({ title: 'تغییر وضعیت ناموفق بود', message: e?.message || 'دوباره تلاش کنید' });
    } finally {
      setToggleBusy(null);
    }
  }, [isOnline, toggleBusy]);

  const toggleAccepting = useCallback(async () => {
    if (toggleBusy || !isOnline) return;
    setToggleBusy('accepting');
    const next = !isAccepting;
    try {
      await api.updateDriverStatus({ isAccepting: next });
      console.log('[Driver][ACCEPTING_TOGGLE]', { next, online: isOnline, selectedRoute });
      setIsAccepting(next);
      socketService.emit('driver:status', { isAccepting: next });
    } catch (e: any) {
      setDialog({ title: 'تغییر وضعیت ناموفق بود', message: e?.message || 'دوباره تلاش کنید' });
    } finally {
      setToggleBusy(null);
    }
  }, [isAccepting, isOnline, toggleBusy]);

  const chooseRoutePoint = useCallback(async (latitude: number, longitude: number) => {
    const next = { latitude, longitude, radiusKm: selectedRoute?.radiusKm || 5, active: true };
    try {
      await api.updateSelectedRoute(next);
      console.log('[Driver][SELECTED_ROUTE_SAVE]', next);
      setSelectedRoute(next);
      setRoutePicking(false);
    } catch (e: any) {
      setDialog({ title: 'ذخیره مسیر منتخب ناموفق بود', message: e?.message || 'دوباره تلاش کنید' });
    }
  }, [selectedRoute?.radiusKm]);

  const toggleSelectedRoute = useCallback(async () => {
    if (!selectedRoute) { setRoutePicking(true); return; }
    const next = { ...selectedRoute, active: !selectedRoute.active };
    try {
      await api.updateSelectedRoute(next);
      console.log('[Driver][SELECTED_ROUTE_TOGGLE]', next);
      setSelectedRoute(next);
    } catch (e: any) {
      setDialog({ title: 'تغییر مسیر منتخب ناموفق بود', message: e?.message || 'دوباره تلاش کنید' });
    }
  }, [selectedRoute]);

  // ---- Offer accept/reject — server payload is { tripId, accepted } ------------
  const respondToOffer = useCallback((accepted: boolean) => {
    const current = offers[offerIndex];
    if (!current) return;
    socketService.emit('trip:respond', { tripId: current.tripId, accepted });
    // Optimistically drop it locally; the server confirms via events.
    setOffers((prev) => prev.filter((o) => o.tripId !== current.tripId));
    setOfferIndex(0);
  }, [offers, offerIndex]);

  // One lightweight tick drives every countdown; expired entries are pruned
  // individually so other valid requests survive.
  useEffect(() => {
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setOffers((prev) => {
      const alive = prev.filter((o) => o.expiresAt > tick);
      return alive.length === prev.length ? prev : alive;
    });
  }, [tick]);
  useEffect(() => {
    if (offerIndex >= offers.length) setOfferIndex(Math.max(0, offers.length - 1));
  }, [offers.length, offerIndex]);

  // ---- Trip actions -------------------------------------------------------------
  const doTripAction = useCallback(async () => {
    if (!trip || actionBusy) return;
    const action = driverActions(trip.status as TripStatus);
    if (!action) return;

    if (action.next === 'COMPLETED') {
      // Confirm completion in-app (Alert.alert is a no-op on web), then
      // optimistically block duplicates while the backend persists COMPLETED.
      setDialog({
        title: 'اتمام سفر',
        message: 'آیا از اتمام سفر مطمئن هستید؟',
        confirmText: 'تأیید',
        onConfirm: async () => {
          setDialog(null);
          if (actionBusy) return;
          setActionBusy(true);
          try {
            await api.updateTripStatus(trip.id, 'COMPLETED');
            // Only clear on backend confirmation; socket status event keeps
            // the passenger's screen in sync via the trip room.
            setTrip(null);
          } catch (e: any) {
            setDialog({ title: 'انجام نشد', message: e?.message || 'دوباره تلاش کنید' });
            // Re-sync with authoritative state in case of a transition mismatch.
            api.getTrip(trip.id).then((t) => { if (t) setTrip(t); }).catch(() => {});
          } finally {
            setActionBusy(false);
          }
        },
      });
      return;
    }

    setActionBusy(true);
    try {
      await api.updateTripStatus(trip.id, action.next);
      setTrip((p) => (p ? { ...p, status: action.next as TripStatus } : p));
    } catch (e: any) {
      setDialog({ title: 'انجام نشد', message: e?.message || 'دوباره تلاش کنید' });
      // Re-sync with authoritative state (e.g. stale status mismatch).
      api.getTrip(trip.id).then((t) => { if (t) setTrip(t); }).catch(() => {});
    } finally {
      setActionBusy(false);
    }
  }, [trip, actionBusy]);

  const cancelTrip = useCallback(() => {
    if (!trip || actionBusy) return;
    setDialog({
      title: 'لغو سفر',
      message: 'آیا از لغو این سفر مطمئن هستید؟',
      confirmText: 'لغو سفر',
      danger: true,
      onConfirm: async () => {
        setDialog(null);
        if (actionBusy) return;
        setActionBusy(true);
        try {
          await api.cancelTrip(trip.id);
          setTrip(null);
        } catch (e: any) {
          setDialog({ title: 'لغو ناموفق بود', message: e?.message || 'دوباره تلاش کنید' });
        } finally {
          setActionBusy(false);
        }
      },
    });
  }, [trip, actionBusy]);

  const handleLogout = useCallback(async () => {
    try {
      if (isOnline) await api.updateDriverStatus({ isOnline: false }).catch(() => {});
    } catch (e) {
      console.warn('[Driver] status-off error', e);
    }
    // Always sign out + redirect, even if the status call failed.
    try {
      await logout();
    } catch (e) {
      console.warn('[Driver] logout error', e);
    }
  }, [isOnline, logout]);

  // ---- Map data -----------------------------------------------------------------
  const markers = useMemo(() => {
    const m: any[] = [];
    if (trip) m.push(
      { id: 'origin', latitude: trip.originLat, longitude: trip.originLng, color: COLORS.pinOrigin, label: 'مبدأ' },
      { id: 'dest', latitude: trip.destLat, longitude: trip.destLng, color: COLORS.pinDest, label: 'مقصد' },
    );
    if (selectedRoute) m.push({ id: 'selected-route', latitude: selectedRoute.latitude, longitude: selectedRoute.longitude, color: COLORS.success, label: 'مسیر منتخب' });
    return m;
  }, [trip?.id, trip?.originLat, trip?.originLng, trip?.destLat, trip?.destLng, selectedRoute]);

  // Use only the encoded road geometry captured at trip creation.
  const polyline = useMemo(() => {
    if (!trip) return null;
    if (trip.routeGeoJson) {
      const decoded = decodePolyline(trip.routeGeoJson);
      if (decoded.length > 1) {
        return { coordinates: decoded, color: COLORS.pinOrigin, to: COLORS.pinDest, width: 5 };
      }
    }
    return null;
  }, [trip?.id, trip?.originLat, trip?.originLng, trip?.destLat, trip?.destLng, trip?.routeGeoJson]);

  useEffect(() => {
    if (trip) {
      const route = trip.routeGeoJson ? decodePolyline(trip.routeGeoJson) : [];
      mapRef.current?.fitToCoordinates(route.length > 1 ? route : [
        { latitude: trip.originLat, longitude: trip.originLng },
        { latitude: trip.destLat, longitude: trip.destLng },
      ], 140);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trip?.id, trip?.status]);

  if (loading) {
    return (
      <View style={s.centerWrap}>
        <ActivityIndicator size="large" color={COLORS.brand} />
        <Text style={s.centerText}>در حال آماده‌سازی پنل سفیر...</Text>
      </View>
    );
  }

  const action = trip ? driverActions(trip.status as TripStatus) : null;

  return (
    <View style={s.container}>
      {/* Map */}
      <View style={s.mapArea}>
          <CabMap
          mapRef={mapRef}
          initialRegion={{ latitude: trip?.originLat ?? 35.6892, longitude: trip?.originLng ?? 51.389, zoom: 13 }}
          markers={markers}
          polyline={polyline}
            showCenterPin={false}
            onPress={routePicking ? chooseRoutePoint : undefined}
            circle={selectedRoute?.active ? { latitude: selectedRoute.latitude, longitude: selectedRoute.longitude, radiusKm: selectedRoute.radiusKm, color: COLORS.success } : null}
          />
      </View>

      {/* Header */}
      <View style={[s.header, { top: insets.top + 10 }]}>
        <View style={s.headerCard}>
          <CarIcon size={20} color={isOnline ? COLORS.success : COLORS.textTertiary} />
          <View style={s.headerTextWrap}>
            <Text style={s.headerName} numberOfLines={1}>{driverName}</Text>
            <Text style={[s.headerStatus, { color: isOnline ? COLORS.success : COLORS.textTertiary }]}>
              {isOnline ? (isAccepting ? 'آنلاین — دریافت درخواست فعال' : 'آنلاین — دریافت غیرفعال') : 'غیرفعال'}
            </Text>
          </View>
        </View>
        <View style={s.headerActions}>
          <Pressable
            accessibilityLabel="سفرهای من"
            onPress={() => router.push('/(passenger)/trip-history' as any)}
            style={({ pressed }) => [s.headerBtn, pressed && { opacity: 0.85 }]}
          >
            <HistoryIcon size={20} color={COLORS.textSecondary} />
          </Pressable>
          <Pressable
            accessibilityLabel="پروفایل"
            onPress={() => router.push('/profile' as any)}
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
      </View>

      {/* Incoming requests — swipeable carousel, one countdown per request */}
      {offers.length > 0 ? (
        <View style={[s.offerCard, { bottom: insets.bottom + 190 }]}>
          {(() => {
            const offer = offers[Math.min(offerIndex, offers.length - 1)];
            const remaining = Math.max(0, Math.ceil((offer.expiresAt - tick) / 1000));
            return (
              <>
                <View style={s.offerHeader}>
                  <View style={s.offerBadge}>
                    <PersonIcon size={18} color={COLORS.brand} />
                    <Text style={s.offerBadgeText}>
                      درخواست سفر{offers.length > 1 ? ` (${(offerIndex + 1).toLocaleString('fa-IR')} از ${offers.length.toLocaleString('fa-IR')})` : ''}
                    </Text>
                  </View>
                  <View style={s.timerBadge}>
                    <Text style={s.timerText}>{remaining.toLocaleString('fa-IR')}</Text>
                  </View>
                </View>
                <OfferRow label="مبدأ" value={offer.originAddress || 'نامشخص'} />
                <OfferRow label="مقصد" value={offer.destAddress || 'نامشخص'} />
                <View style={s.offerStatsRow}>
                  <Text style={s.offerStat}>
                    {offer.driverDistanceKm ? `فاصله تا مبدأ: ${offer.driverDistanceKm.toLocaleString('fa-IR')} کیلومتر` : ' '}
                  </Text>
                  <Text style={s.offerStat}>{offer.distanceKm ? `${offer.distanceKm.toLocaleString('fa-IR')} کیلومتر مسیر` : ' '}</Text>
                </View>
                <View style={s.offerPriceRow}>
                  <Text style={s.offerPriceLabel}>کرایه پیشنهادی</Text>
                  <Text style={s.offerPrice}>{offer.estimatedPrice ? `${formatToman(offer.estimatedPrice)} تومان` : '—'}</Text>
                </View>
                <View style={s.offerActions}>
                  <Pressable
                    style={({ pressed }) => [s.btnAccept, pressed && { opacity: 0.9 }]}
                    onPress={() => respondToOffer(true)}
                  >
                    <Text style={s.btnAcceptText}>پذیرش</Text>
                  </Pressable>
                  <Pressable
                    style={({ pressed }) => [s.btnReject, pressed && { opacity: 0.9 }]}
                    onPress={() => respondToOffer(false)}
                  >
                    <CloseIcon size={16} color={COLORS.error} />
                    <Text style={s.btnRejectText}>رد</Text>
                  </Pressable>
                </View>

                {offers.length > 1 ? (
                  <View style={s.pagerRow}>
                    <Pressable
                      disabled={offerIndex === 0}
                      onPress={() => setOfferIndex((i) => Math.max(0, i - 1))}
                      style={[s.pagerBtn, offerIndex === 0 && { opacity: 0.35 }]}
                    >
                      <Text style={s.pagerText}>قبلی</Text>
                    </Pressable>
                    <View style={s.dotsRow}>
                      {offers.map((o, i) => (
                        <View key={o.tripId} style={[s.dot, i === offerIndex && s.dotActive]} />
                      ))}
                    </View>
                    <Pressable
                      disabled={offerIndex >= offers.length - 1}
                      onPress={() => setOfferIndex((i) => Math.min(offers.length - 1, i + 1))}
                      style={[s.pagerBtn, offerIndex >= offers.length - 1 && { opacity: 0.35 }]}
                    >
                      <Text style={s.pagerText}>بعدی</Text>
                    </Pressable>
                  </View>
                ) : null}
              </>
            );
          })()}
        </View>
      ) : null}

      {/* Active trip card */}
      {trip && offers.length === 0 ? (
        <View style={[s.tripCard, { paddingBottom: insets.bottom + SPACING.lg }]}> 
          <View style={s.sheetHandle} />
          <View style={s.tripHeader}>
            <View style={s.tripBadge}>
              <CarIcon size={18} color={COLORS.brand} />
              <Text style={s.tripBadgeText}>سفر فعال</Text>
            </View>
            {action ? (
              <Text style={s.tripStatusChip}>{action.label}</Text>
            ) : null}
          </View>
          <OfferRow label="مسافر" value={trip.passenger ? `${trip.passenger.firstName} ${trip.passenger.lastName}` : '—'} />
          {trip.passenger ? (
            <View style={s.tripPhoneRow}>
              <PhoneIcon size={13} color={COLORS.brand} />
              <Text style={s.tripPhone}>{toPersianDigits(trip.passenger.phone ?? '')}</Text>
            </View>
          ) : null}
          <OfferRow label="مبدأ" value={trip.originAddress || '—'} />
          <OfferRow label="مقصد" value={trip.destAddress || '—'} />
          <View style={s.tripFareRow}>
            <Text style={s.tripFareLabel}>کرایه</Text>
            <Text style={s.tripFare}>{formatToman(trip.estimatedPrice)} تومان</Text>
          </View>

          {/* External navigation — single button opens app-picker sheet */}
          <View style={s.tripActions}>
            <Pressable
              style={({ pressed }) => [s.navBtn, pressed && { opacity: 0.88 }]}
              onPress={() => setNavSheetVisible(true)}
            >
              <Text style={s.navBtnText}>🧭  مسیریابی</Text>
            </Pressable>
          </View>

          {action ? (
            <View style={s.tripActions}>
              <Pressable
                style={({ pressed }) => [s.btnPrimary, s.flexBtn, pressed && { opacity: 0.9 }, actionBusy && { opacity: 0.5 }]}
                onPress={doTripAction}
                disabled={actionBusy}
              >
                {actionBusy ? <ActivityIndicator size="small" color="#fff" /> : null}
                <Text style={s.btnPrimaryText}>{action.label}</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [s.btnDanger, s.flexBtn, pressed && { opacity: 0.9 }]}
                onPress={cancelTrip}
              >
                <Text style={s.btnDangerText}>لغو</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Bottom control bar */}
      {!trip ? <View style={[s.bottomBar, { paddingBottom: insets.bottom + 14 }]}> 
        {!trip ? (
          <Pressable style={s.selectedRouteBtn} onPress={routePicking ? undefined : selectedRoute?.active ? () => setRoutePicking(true) : toggleSelectedRoute}>
            <Text style={s.selectedRouteText}>{routePicking ? 'روی نقشه نقطه مسیر منتخب را انتخاب کنید' : selectedRoute?.active ? 'تغییر نقطه مسیر منتخب' : 'مسیر منتخب — انتخاب محدوده'}</Text>
          </Pressable>
        ) : null}
        {!trip && selectedRoute?.active && !routePicking ? (
          <Pressable style={s.allTripsBtn} onPress={toggleSelectedRoute}>
            <Text style={s.allTripsText}>خروج از مسیر منتخب و دریافت همه سفرها</Text>
          </Pressable>
        ) : null}
        {routePicking ? <Pressable style={s.routeCancel} onPress={() => setRoutePicking(false)}><Text style={s.routeCancelText}>انصراف</Text></Pressable> : null}
        {!isOnline ? (
          <Pressable
            style={({ pressed }) => [s.bottomBtnFull, pressed && { opacity: 0.92 }]}
            onPress={toggleOnline}
            disabled={toggleBusy === 'online'}
          >
            {toggleBusy === 'online' ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={s.bottomBtnText}>ورود به مدار — آماده دریافت سفر</Text>
            )}
          </Pressable>
        ) : (
          <View style={s.bottomBtnsRow}>
            {/* Active ride locks availability: the driver must stay on the line
                until the trip is completed or cancelled (backend enforces too). */}
            <Pressable
              style={({ pressed }) => [s.bottomBtn, s.btnOnline, pressed && !trip && { opacity: 0.92 }, trip && { opacity: 0.5 }]}
              onPress={toggleOnline}
              disabled={!!toggleBusy || !!trip}
            >
               {toggleBusy === 'online' ? <ActivityIndicator color="#fff" size="small" /> : <Text style={s.bottomBtnText}>خروج از مدار</Text>}
            </Pressable>
            <Pressable
              style={({ pressed }) => [s.bottomBtn, isAccepting ? s.btnAccepting : s.btnNotAccepting, pressed && !trip && { opacity: 0.92 }, trip && { opacity: 0.5 }]}
              onPress={toggleAccepting}
              disabled={!!toggleBusy || !isOnline || !!trip}
            >
              {toggleBusy === 'accepting' ? <ActivityIndicator color="#fff" size="small" /> : (
                <Text style={s.bottomBtnText}>{trip ? 'سفر فعال' : isAccepting ? 'دریافت فعال است' : 'دریافت غیرفعال است'}</Text>
              )}
            </Pressable>
          </View>
        )}
        {isOnline && !trip && offers.length === 0 ? (
          <Text style={s.idleText}>
            {isAccepting ? 'در انتظار درخواست سفر...' : 'برای دریافت درخواست، حالت دریافت را فعال کنید'}
          </Text>
        ) : null}
      </View> : null}

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title || ''}
        description={dialog?.message}
        confirmText={dialog?.confirmText || 'تأیید'}
        danger={dialog?.danger}
        onCancel={() => setDialog(null)}
        onConfirm={() => { dialog?.onConfirm ? dialog.onConfirm() : setDialog(null); }}
      />

      {/* Navigation app picker — bottom-sheet style Modal */}
      {trip ? (
        <NavSheet
          visible={navSheetVisible}
          lat={trip.destLat}
          lng={trip.destLng}
          address={trip.destAddress || ''}
          onClose={() => setNavSheetVisible(false)}
        />
      ) : null}
    </View>
  );
}

// ---- Navigation App Picker -------------------------------------------------------

type NavApp = {
  id: string;
  label: string;
  emoji: string;
  platform?: 'ios' | 'android';
  getDeepLink: (lat: number, lng: number) => string;
  getFallback?: (lat: number, lng: number) => string;
};

const NAV_APPS: NavApp[] = [
  {
    id: 'neshan',
    label: 'نشان',
    emoji: '🗺️',
    getDeepLink: (lat, lng) => `nshn://map?type=d&latitude=${lat}&longitude=${lng}`,
    getFallback: (lat, lng) => `https://maps.google.com/?daddr=${lat},${lng}&travelmode=driving`,
  },
  {
    id: 'googlemaps',
    label: 'گوگل مپ',
    emoji: '📍',
    getDeepLink: (lat, lng) =>
      Platform.OS === 'ios'
        ? `comgooglemaps://?daddr=${lat},${lng}&directionsmode=driving`
        : `google.navigation:q=${lat},${lng}`,
    getFallback: (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
  },
  {
    id: 'waze',
    label: 'ویز',
    emoji: '🚗',
    getDeepLink: (lat, lng) => `waze://?ll=${lat},${lng}&navigate=yes`,
    getFallback: (lat, lng) => `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`,
  },
  {
    id: 'applemaps',
    label: 'Apple Maps',
    emoji: '🍎',
    platform: 'ios',
    getDeepLink: (lat, lng) => `maps://?daddr=${lat},${lng}`,
  },
  {
    id: 'balad',
    label: 'بلد',
    emoji: '🧿',
    getDeepLink: (lat, lng) => `balad://map?lat=${lat}&lon=${lng}&navigate=true`,
    getFallback: (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`,
  },
];

function NavSheet({
  visible,
  lat,
  lng,
  address,
  onClose,
}: {
  visible: boolean;
  lat: number;
  lng: number;
  address: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();

  const openApp = useCallback(async (app: NavApp) => {
    const deepLink = app.getDeepLink(lat, lng);
    const canOpen = await Linking.canOpenURL(deepLink).catch(() => false);
    if (canOpen) {
      await Linking.openURL(deepLink).catch(() => {});
    } else if (app.getFallback) {
      await Linking.openURL(app.getFallback(lat, lng)).catch(() => {});
    }
    onClose();
  }, [lat, lng, onClose]);

  const apps = NAV_APPS.filter(
    (a) => !a.platform || a.platform === Platform.OS
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={ns.overlay} onPress={onClose} />
      <View style={[ns.sheet, { paddingBottom: insets.bottom + 12 }]}>
        {/* Handle */}
        <View style={ns.handle} />

        {/* Title */}
        <View style={ns.sheetHeader}>
          <Text style={ns.sheetTitle}>انتخاب اپ مسیریابی</Text>
          {address ? (
            <Text style={ns.sheetSub} numberOfLines={1}>{address}</Text>
          ) : null}
        </View>

        <ScrollView style={ns.list} showsVerticalScrollIndicator={false}>
          {apps.map((app) => (
            <Pressable
              key={app.id}
              style={({ pressed }) => [ns.appRow, pressed && ns.appRowPressed]}
              onPress={() => openApp(app)}
            >
              <Text style={ns.appEmoji}>{app.emoji}</Text>
              <Text style={ns.appLabel}>{app.label}</Text>
              <Text style={ns.appChevron}>›</Text>
            </Pressable>
          ))}
        </ScrollView>

        <Pressable style={({ pressed }) => [ns.cancelBtn, pressed && { opacity: 0.8 }]} onPress={onClose}>
          <Text style={ns.cancelText}>انصراف</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const ns = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 12,
    paddingHorizontal: 0,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.16,
    shadowRadius: 24,
    elevation: 32,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#CBD5E1',
    alignSelf: 'center',
    marginBottom: 16,
  },
  sheetHeader: {
    paddingHorizontal: 24,
    marginBottom: 8,
  },
  sheetTitle: {
    fontFamily: FONTS.bold,
    fontSize: 17,
    color: COLORS.text,
    textAlign: 'right',
  },
  sheetSub: {
    fontFamily: FONTS.regular,
    fontSize: 12,
    color: COLORS.textSecondary,
    textAlign: 'right',
    marginTop: 3,
  },
  list: {
    maxHeight: 320,
  },
  appRow: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 24,
    gap: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#F1F5F9',
  },
  appRowPressed: {
    backgroundColor: '#F8FAFC',
  },
  appEmoji: {
    fontSize: 26,
    width: 36,
    textAlign: 'center',
  },
  appLabel: {
    flex: 1,
    fontFamily: FONTS.semibold,
    fontSize: 15,
    color: COLORS.text,
    textAlign: 'right',
  },
  appChevron: {
    fontFamily: FONTS.bold,
    fontSize: 22,
    color: COLORS.textTertiary,
  },
  cancelBtn: {
    marginHorizontal: 20,
    marginTop: 12,
    backgroundColor: '#F1F5F9',
    borderRadius: RADIUS.lg,
    paddingVertical: 14,
    alignItems: 'center',
  },
  cancelText: {
    fontFamily: FONTS.bold,
    fontSize: 15,
    color: COLORS.text,
  },
});

function OfferRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.offerRow}>
      <Text style={s.offerLabel}>{label}</Text>
      <Text style={s.offerValue} numberOfLines={1}>{value}</Text>
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
  headerCard: {
    flex: 1, flexDirection: 'row-reverse', alignItems: 'center', gap: 10,
    backgroundColor: '#FFFFFF', borderRadius: RADIUS.full,
    paddingVertical: 10, paddingHorizontal: 16,
    borderWidth: 1, borderColor: '#E2E8F0', marginRight: SPACING.md,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 8,
  },
  headerTextWrap: { flex: 1 },
  headerName: { fontFamily: FONTS.bold, fontSize: 13, color: COLORS.text, textAlign: 'right' },
  headerStatus: { fontFamily: FONTS.medium, fontSize: 11, textAlign: 'right', marginTop: 1 },
  headerActions: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 8,
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

  offerCard: {
    position: 'absolute', left: SPACING.lg, right: SPACING.lg, zIndex: 60,
    backgroundColor: '#FFFFFF', borderRadius: 24,
    padding: SPACING.xl, borderWidth: 1.5, borderColor: COLORS.brand,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.16,
    shadowRadius: 24,
    elevation: 16,
  },
  offerHeader: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.sm },
  offerBadge: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6 },
  offerBadgeText: { fontFamily: FONTS.bold, fontSize: 14, color: COLORS.text },
  timerBadge: {
    backgroundColor: '#FEF3C7', borderRadius: RADIUS.full,
    borderWidth: 1, borderColor: '#FDE68A',
    minWidth: 32, height: 32, justifyContent: 'center', alignItems: 'center', overflow: 'hidden',
  },
  timerText: { fontFamily: FONTS.bold, fontSize: 14, color: '#D97706' },
  offerRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, paddingVertical: 3 },
  offerLabel: { fontFamily: FONTS.medium, fontSize: 12, color: COLORS.textSecondary, minWidth: 40 },
  offerValue: { flex: 1, fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.text, textAlign: 'right' },
  offerStatsRow: { flexDirection: 'row-reverse', gap: 12, marginTop: 8 },
  offerStat: { fontFamily: FONTS.medium, fontSize: 11, color: COLORS.textSecondary },
  offerPriceRow: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 12, backgroundColor: '#F8FAFC', borderRadius: RADIUS.lg,
    paddingVertical: 10, paddingHorizontal: SPACING.md,
    borderWidth: 1, borderColor: '#E2E8F0',
  },
  offerPriceLabel: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.textSecondary },
  offerPrice: { fontFamily: FONTS.bold, fontSize: 18, color: COLORS.brand },
  offerActions: { flexDirection: 'row-reverse', gap: SPACING.sm, marginTop: SPACING.md },

  tripCard: {
    position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 60,
    backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28,
    padding: SPACING.xl,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.16,
    shadowRadius: 24,
    elevation: 16,
    borderTopWidth: 1, borderColor: '#E2E8F0',
  },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#CBD5E1', alignSelf: 'center', marginBottom: SPACING.md },
  tripHeader: { flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACING.sm },
  tripBadge: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6 },
  tripBadgeText: { fontFamily: FONTS.bold, fontSize: 14, color: COLORS.text },
  tripStatusChip: {
    fontFamily: FONTS.bold, fontSize: 11, color: COLORS.brand,
    backgroundColor: 'rgba(15, 169, 88, 0.1)', borderRadius: RADIUS.full,
    overflow: 'hidden', paddingVertical: 4, paddingHorizontal: 12,
  },
  tripPhoneRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 6, marginBottom: 6 },
  tripPhone: { fontFamily: FONTS.medium, fontSize: 12, color: COLORS.textSecondary, writingDirection: 'ltr' as any },
  tripFareRow: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 10, backgroundColor: '#F8FAFC', borderRadius: RADIUS.lg,
    paddingVertical: 10, paddingHorizontal: SPACING.md,
    borderWidth: 1, borderColor: '#E2E8F0',
  },
  tripFareLabel: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.textSecondary },
  tripFare: { fontFamily: FONTS.bold, fontSize: 18, color: COLORS.brand },
  tripActions: { flexDirection: 'row-reverse', gap: SPACING.sm, marginTop: SPACING.md },
  pagerRow: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'space-between',
    marginTop: SPACING.md,
  },
  pagerBtn: {
    borderWidth: 1, borderColor: '#E2E8F0', borderRadius: RADIUS.full,
    paddingVertical: 6, paddingHorizontal: SPACING.md,
  },
  pagerText: { fontFamily: FONTS.medium, fontSize: 12, color: COLORS.textSecondary },
  dotsRow: { flexDirection: 'row', gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#CBD5E1' },
  dotActive: { backgroundColor: COLORS.brand, width: 18 },
  navBtn: {
    flex: 1, borderWidth: 1.5, borderColor: COLORS.brand, borderRadius: RADIUS.lg,
    paddingVertical: 11, alignItems: 'center', backgroundColor: 'rgba(15,169,88,0.06)',
    flexDirection: 'row', justifyContent: 'center', gap: 6,
  },
  navBtnText: { fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.brand },
  flexBtn: { flex: 1 },
  btnPrimary: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: COLORS.brand, borderRadius: RADIUS.lg, paddingVertical: 14,
    shadowColor: COLORS.brand,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
  },
  btnPrimaryText: { fontFamily: FONTS.bold, fontSize: 14, color: '#fff' },
  btnDanger: {
    backgroundColor: '#FFFFFF', borderWidth: 1.5, borderColor: '#FEE2E2',
    borderRadius: RADIUS.lg, paddingVertical: 14, alignItems: 'center',
  },
  btnDangerText: { fontFamily: FONTS.bold, fontSize: 14, color: COLORS.error },

  bottomBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 55,
    backgroundColor: '#FFFFFF',
    paddingTop: 16, paddingHorizontal: SPACING.xl,
    borderTopLeftRadius: 28, borderTopRightRadius: 28,
    borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)',
    alignItems: 'center',
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: -8 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    elevation: 24,
  },
  bottomBtnFull: {
    width: '100%', backgroundColor: COLORS.brand, borderRadius: RADIUS.lg,
    paddingVertical: 16, alignItems: 'center', justifyContent: 'center',
    shadowColor: COLORS.brand,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  bottomBtnsRow: { flexDirection: 'row-reverse', gap: SPACING.sm, width: '100%' },
  bottomBtn: {
    flex: 1, borderRadius: RADIUS.lg, paddingVertical: 14,
    alignItems: 'center', justifyContent: 'center',
  },
  btnOnline: { backgroundColor: COLORS.success },
  btnAccepting: {
    backgroundColor: COLORS.brand,
    shadowColor: COLORS.brand,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
  },
  btnNotAccepting: { backgroundColor: '#94A3B8' },
  bottomBtnText: { fontFamily: FONTS.bold, fontSize: 14, color: '#fff' },
  idleText: { fontFamily: FONTS.medium, fontSize: 12, color: COLORS.textSecondary, marginTop: 10, textAlign: 'center' },
  selectedRouteBtn: { width: '100%', backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, borderWidth: 1, borderColor: COLORS.success, paddingVertical: 11, alignItems: 'center', marginBottom: SPACING.sm },
  selectedRouteText: { fontFamily: FONTS.bold, fontSize: 13, color: COLORS.success, textAlign: 'center' },
  routeCancel: { marginBottom: SPACING.sm, paddingVertical: 4 },
  routeCancelText: { fontFamily: FONTS.medium, fontSize: 12, color: COLORS.textSecondary },
  allTripsBtn: { width: '100%', backgroundColor: COLORS.success, borderRadius: RADIUS.lg, paddingVertical: 11, alignItems: 'center', marginBottom: SPACING.sm },
  allTripsText: { fontFamily: FONTS.bold, fontSize: 13, color: '#fff' },

  centerWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.bg, padding: SPACING.xxl },
  centerText: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.textSecondary, marginTop: 16, textAlign: 'center' },

  btnAccept: {
    flex: 1, backgroundColor: COLORS.brand, borderRadius: RADIUS.lg,
    paddingVertical: 14, alignItems: 'center',
    shadowColor: COLORS.brand,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
  },
  btnAcceptText: { fontFamily: FONTS.bold, fontSize: 15, color: '#fff' },
  btnReject: {
    flex: 1, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: '#FFFFFF', borderWidth: 1.5, borderColor: '#FEE2E2',
    borderRadius: RADIUS.lg, paddingVertical: 14,
  },
  btnRejectText: { fontFamily: FONTS.bold, fontSize: 15, color: COLORS.error },
});
