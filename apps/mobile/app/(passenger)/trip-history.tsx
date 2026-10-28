import React, { useCallback, useEffect, useState } from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator, RefreshControl,
} from 'react-native';
import { ArrowRightIcon, HistoryIcon, CarIcon, CloseIcon, AlertIcon } from '../../components/Icons';
import { api } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { COLORS, FONTS, SPACING, RADIUS, SHADOW, formatToman } from '../../utils/theme';
import { Trip, TripStatus } from '../../types';

const STATUS_META: Partial<Record<TripStatus, { label: string; color: string }>> = {
  COMPLETED: { label: 'انجام شده', color: COLORS.success },
  CANCELLED: { label: 'لغو شده', color: COLORS.error },
  NO_DRIVER_AVAILABLE: { label: 'سفیر نیامد', color: COLORS.textTertiary },
};

function fmtDate(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' }) +
    ' — ' + d.toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' });
}

export default function TripHistoryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const isDriver = user?.role === 'DRIVER';

  const [trips, setTrips] = useState<Trip[] | null>(null);
  const [summary, setSummary] = useState<{ completedCount: number; cancelledCount: number; totalFare: number } | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      if (isDriver) {
        const r = await api.getDriverHistory();
        setTrips(r?.trips || []);
        setSummary(r?.summary || null);
      } else {
        const r = await api.getHistory();
        setTrips(r?.trips || []);
      }
    } catch (e: any) {
      setError(e?.message || 'خطا در دریافت سفرها');
      setTrips([]);
    }
  }, [isDriver]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const renderItem = ({ item }: { item: Trip }) => {
    const meta = STATUS_META[item.status as TripStatus] || { label: item.status, color: COLORS.textSecondary };
    const isDone = item.status === 'COMPLETED';
    return (
      <Pressable
        style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}
        onPress={() => router.push({ pathname: '/(passenger)/active-trip', params: { tripId: item.id } } as any)}
      >
        <View style={s.cardTop}>
          <View style={[s.statusBadge, { backgroundColor: meta.color + '22' }]}>
            <Text style={[s.statusText, { color: meta.color }]}>{meta.label}</Text>
          </View>
          <Text style={s.date}>{fmtDate(item.createdAt)}</Text>
        </View>
        <View style={s.routeCol}>
          <View style={s.routeRow}>
            <View style={[s.dot, { backgroundColor: COLORS.pinOrigin }]} />
            <Text style={s.addr} numberOfLines={1}>{item.originAddress || 'مبدأ'}</Text>
          </View>
          <View style={s.routeRow}>
            <View style={[s.dot, { backgroundColor: COLORS.pinDest }]} />
            <Text style={s.addr} numberOfLines={1}>{item.destAddress || 'مقصد'}</Text>
          </View>
        </View>
        <View style={s.cardBottom}>
          <Text style={s.meta}>
            {item.distanceKm.toLocaleString('fa-IR')} کیلومتر
            {item.driver && !isDriver ? ` — سفیر: ${item.driver.firstName} ${item.driver.lastName}` : ''}
            {isDriver && item.passenger ? ` — مسافر: ${item.passenger.firstName} ${item.passenger.lastName}` : ''}
          </Text>
          <Text style={[s.fare, !isDone && { color: COLORS.textTertiary }]}>
            {isDone ? `${formatToman(item.estimatedPrice)} تومان` : '—'}
          </Text>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} accessibilityLabel="بازگشت">
          <ArrowRightIcon size={18} />
        </Pressable>
        <Text style={styles.title}>سفرهای من</Text>
        <View style={{ width: 40 }} />
      </View>

      {isDriver && summary ? (
        <View style={styles.summaryCard}>
          <Text style={styles.summaryTitle}>خلاصه فعالیت</Text>
          <View style={styles.summaryRow}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{summary.completedCount.toLocaleString('fa-IR')}</Text>
              <Text style={styles.summaryLabel}>سفر انجام‌شده</Text>
            </View>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{summary.cancelledCount.toLocaleString('fa-IR')}</Text>
              <Text style={styles.summaryLabel}>لغو شده</Text>
            </View>
            <View style={styles.summaryItem}>
              <Text style={[styles.summaryValue, { color: COLORS.brand }]}>{formatToman(summary.totalFare)}</Text>
              <Text style={styles.summaryLabel}>مجموع کرایه سفرها (تومان)</Text>
            </View>
          </View>
        </View>
      ) : null}

      {error ? (
        <View style={styles.empty}>
          <AlertIcon size={30} color={COLORS.error} />
          <Text style={styles.emptyTitle}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={load}>
            <Text style={styles.retryText}>تلاش مجدد</Text>
          </Pressable>
        </View>
      ) : trips === null ? (
        <View style={styles.empty}><ActivityIndicator size="large" color={COLORS.brand} /></View>
      ) : trips.length === 0 ? (
        <View style={styles.empty}>
          <View style={styles.emptyIconWrap}>
            <HistoryIcon size={26} color={COLORS.textTertiary} />
          </View>
          <Text style={styles.emptyTitle}>هنوز سفری ثبت نشده است</Text>
          <Text style={styles.emptyDesc}>سفرهای انجام‌شده و لغو‌شده شما پس از پایان، اینجا نمایش داده می‌شود.</Text>
        </View>
      ) : (
        <FlatList
          data={trips}
          keyExtractor={(t) => t.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: SPACING.lg, paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  headerRow: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: SPACING.md,
    paddingHorizontal: SPACING.lg, paddingVertical: SPACING.md,
  },
  backBtn: {
    width: 40, height: 40, borderRadius: RADIUS.sm,
    backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border,
    justifyContent: 'center', alignItems: 'center',
  },
  title: { fontFamily: FONTS.bold, fontSize: 17, color: COLORS.text },
  summaryCard: {
    marginHorizontal: SPACING.lg, marginBottom: SPACING.md,
    backgroundColor: COLORS.surface, borderRadius: RADIUS.lg,
    padding: SPACING.lg, ...SHADOW.sm,
  },
  summaryTitle: { fontFamily: FONTS.bold, fontSize: 14, color: COLORS.text, marginBottom: SPACING.md, textAlign: 'right' },
  summaryRow: { flexDirection: 'row-reverse', justifyContent: 'space-between' },
  summaryItem: { alignItems: 'center', flex: 1 },
  summaryValue: { fontFamily: FONTS.bold, fontSize: 18, color: COLORS.text },
  summaryLabel: { fontFamily: FONTS.regular, fontSize: 11, color: COLORS.textSecondary, marginTop: 4, textAlign: 'center' },
  empty: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    paddingHorizontal: SPACING.xxl, paddingBottom: 80,
  },
  emptyIconWrap: {
    width: 64, height: 64, borderRadius: 20, backgroundColor: COLORS.divider,
    justifyContent: 'center', alignItems: 'center', marginBottom: SPACING.lg,
  },
  emptyTitle: { fontFamily: FONTS.bold, fontSize: 16, color: COLORS.text, marginBottom: 8 },
  emptyDesc: {
    fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textTertiary,
    textAlign: 'center', lineHeight: 22,
  },
  retryBtn: {
    marginTop: SPACING.lg, backgroundColor: COLORS.brand,
    paddingHorizontal: SPACING.xl, paddingVertical: 12, borderRadius: RADIUS.lg,
  },
  retryText: { fontFamily: FONTS.semibold, fontSize: 14, color: '#fff' },
});

const s = StyleSheet.create({
  card: {
    backgroundColor: COLORS.surface, borderRadius: RADIUS.lg,
    padding: SPACING.lg, marginBottom: SPACING.md, ...SHADOW.sm,
  },
  cardTop: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACING.md },
  statusBadge: { borderRadius: RADIUS.full, paddingHorizontal: 12, paddingVertical: 5 },
  statusText: { fontFamily: FONTS.semibold, fontSize: 12 },
  date: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.textSecondary },
  routeCol: { gap: 8, marginBottom: SPACING.md },
  routeRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  addr: { flex: 1, fontFamily: FONTS.medium, fontSize: 13, color: COLORS.text, textAlign: 'right' },
  cardBottom: {
    flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center',
    borderTopWidth: 1, borderTopColor: COLORS.divider, paddingTop: SPACING.md,
  },
  meta: { flex: 1, fontFamily: FONTS.regular, fontSize: 12, color: COLORS.textSecondary, textAlign: 'right' },
  fare: { fontFamily: FONTS.bold, fontSize: 14, color: COLORS.brand },
});
