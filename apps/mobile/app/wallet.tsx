import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator, TextInput, Modal,
} from 'react-native';
import { ArrowRightIcon, CashIcon } from '../components/Icons';
import { api } from '../services/api';
import { COLORS, FONTS, SPACING, RADIUS, SHADOW, formatToman } from '../utils/theme';

const SOURCE_LABELS: Record<string, string> = {
  SIGNUP_BONUS: 'اعتبار اولیه ثبت‌نام',
  RIDE_PAYMENT: 'پرداخت کرایه سفر',
  REFUND: 'بازگشت وجه',
  TOPUP: 'افزایش موجودی',
};

export default function WalletScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [balance, setBalance] = useState<number | null>(null);
  const [transactions, setTransactions] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupMsg, setTopupMsg] = useState('');
  const [topupAmount, setTopupAmount] = useState('200000');
  const [topupLoading, setTopupLoading] = useState(false);

  const load = useCallback(async () => {
    setError('');
    try {
      const r = await api.getWallet();
      setBalance(r?.balance ?? 0);
      setTransactions(r?.transactions || []);
    } catch (e: any) {
      setError(e?.message || 'خطا در دریافت کیف پول');
      setTransactions([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const tryTopup = useCallback(async () => {
    const amount = Number(topupAmount.replace(/[^0-9]/g, ''));
    if (!Number.isInteger(amount) || amount < 50_000) {
      setTopupMsg('مبلغ افزایش موجودی نباید کمتر از ۵۰ هزار تومان باشد');
      return;
    }
    setTopupLoading(true);
    setTopupMsg('در حال انجام پرداخت آزمایشی...');
    try {
      await new Promise((resolve) => setTimeout(resolve, 900));
      await api.topupWallet(amount);
      setTopupMsg('پرداخت موفق بود و موجودی کیف پول افزایش یافت');
      await load();
    } catch (e: any) {
      setTopupMsg(e?.message || 'افزایش موجودی در دسترس نیست');
    } finally {
      setTopupLoading(false);
    }
  }, [load, topupAmount]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} accessibilityLabel="بازگشت">
          <ArrowRightIcon size={18} />
        </Pressable>
        <Text style={styles.title}>کیف پول</Text>
        <View style={{ width: 40 }} />
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryBtn} onPress={load}><Text style={styles.retryText}>تلاش مجدد</Text></Pressable>
        </View>
      ) : balance === null ? (
        <View style={styles.center}><ActivityIndicator size="large" color={COLORS.brand} /></View>
      ) : (
        <>
          <View style={styles.balanceCard}>
            <Text style={styles.balanceLabel}>موجودی فعلی</Text>
            <Text style={styles.balanceValue}>{formatToman(balance)} <Text style={styles.balanceUnit}>تومان</Text></Text>
            <Pressable
              style={({ pressed }) => [styles.topupBtn, pressed && { opacity: 0.9 }]}
              onPress={() => setTopupOpen(true)}
            >
              <CashIcon size={16} color="#fff" />
              <Text style={styles.topupText}>افزایش موجودی</Text>
            </Pressable>
          </View>

          <Text style={styles.sectionTitle}>تاریخچه تراکنش‌ها</Text>
          {transactions !== null && transactions.length === 0 ? (
            <View style={styles.empty}>
              <Text style={styles.emptyText}>هنوز تراکنشی ثبت نشده است</Text>
            </View>
          ) : (
            <FlatList
              data={transactions || []}
              keyExtractor={(t) => t.id}
              contentContainerStyle={{ padding: SPACING.lg, paddingBottom: 40 }}
              renderItem={({ item }) => {
                const isCredit = item.type === 'CREDIT';
                return (
                  <View style={styles.txRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.txTitle}>{SOURCE_LABELS[item.source] || item.description || 'تراکنش'}</Text>
                      <Text style={styles.txDate}>
                        {new Date(item.createdAt).toLocaleDateString('fa-IR')} — {new Date(item.createdAt).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' })}
                      </Text>
                    </View>
                    <Text style={[styles.txAmount, { color: isCredit ? COLORS.success : COLORS.error }]}>
                      {isCredit ? '+' : '−'} {formatToman(item.amount)}
                    </Text>
                  </View>
                );
              }}
            />
          )}
        </>
      )}

      <Modal visible={topupOpen} transparent animationType="fade" onRequestClose={() => setTopupOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.topupModal}>
            <Text style={styles.modalTitle}>افزایش موجودی</Text>
            {topupMsg ? <Text style={styles.modalMessage}>{topupMsg}</Text> : null}
            {!topupLoading && !topupMsg.includes('موفق') ? (
              <>
                <View style={styles.presets}>
                  {[200_000, 500_000, 1_000_000].map((amount) => (
                    <Pressable key={amount} style={styles.preset} onPress={() => setTopupAmount(String(amount))}>
                      <Text style={styles.presetText}>{formatToman(amount)} تومان</Text>
                    </Pressable>
                  ))}
                </View>
                <TextInput
                  value={topupAmount}
                  onChangeText={setTopupAmount}
                  keyboardType="number-pad"
                  placeholder="مبلغ دلخواه"
                  placeholderTextColor={COLORS.textTertiary}
                  style={styles.amountInput}
                  textAlign="right"
                />
              </>
            ) : null}
            {topupLoading ? <ActivityIndicator color={COLORS.brand} style={{ marginVertical: SPACING.lg }} /> : (
              <View style={styles.modalActions}>
                <Pressable style={styles.modalCancel} onPress={() => { setTopupOpen(false); setTopupMsg(''); }}>
                  <Text style={styles.modalCancelText}>{topupMsg ? 'بستن' : 'انصراف'}</Text>
                </Pressable>
                {!topupMsg.includes('موفق') ? <Pressable style={styles.modalConfirm} onPress={tryTopup}><Text style={styles.modalConfirmText}>پرداخت آزمایشی</Text></Pressable> : null}
              </View>
            )}
          </View>
        </View>
      </Modal>
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
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  errorText: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.error, textAlign: 'center' },
  retryBtn: {
    marginTop: SPACING.lg, backgroundColor: COLORS.brand,
    paddingHorizontal: SPACING.xl, paddingVertical: 12, borderRadius: RADIUS.lg,
  },
  retryText: { fontFamily: FONTS.semibold, fontSize: 14, color: '#fff' },

  balanceCard: {
    marginHorizontal: SPACING.lg, backgroundColor: COLORS.brand,
    borderRadius: RADIUS.xl, padding: SPACING.xl, alignItems: 'center', ...SHADOW.md,
  },
  balanceLabel: { fontFamily: FONTS.medium, fontSize: 13, color: 'rgba(255,255,255,0.85)' },
  balanceValue: { fontFamily: FONTS.bold, fontSize: 30, color: '#fff', marginTop: 6 },
  balanceUnit: { fontFamily: FONTS.regular, fontSize: 14, color: 'rgba(255,255,255,0.85)' },
  topupBtn: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,255,255,0.18)', borderRadius: RADIUS.full,
    paddingVertical: 9, paddingHorizontal: SPACING.lg, marginTop: SPACING.lg,
  },
  topupText: { fontFamily: FONTS.semibold, fontSize: 13, color: '#fff' },

  sectionTitle: {
    fontFamily: FONTS.bold, fontSize: 14, color: COLORS.text,
    marginHorizontal: SPACING.lg, marginTop: SPACING.xl, textAlign: 'right',
  },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: SPACING.xxl },
  emptyText: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.textTertiary, textAlign: 'center' },

  txRow: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: SPACING.md,
    backgroundColor: COLORS.surface, borderRadius: RADIUS.lg,
    padding: SPACING.lg, marginBottom: SPACING.sm, ...SHADOW.sm,
  },
  txTitle: { fontFamily: FONTS.medium, fontSize: 14, color: COLORS.text, textAlign: 'right' },
  txDate: { fontFamily: FONTS.regular, fontSize: 11, color: COLORS.textTertiary, marginTop: 3, textAlign: 'right' },
  txAmount: { fontFamily: FONTS.bold, fontSize: 14 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.42)', justifyContent: 'center', padding: SPACING.xl },
  topupModal: { backgroundColor: COLORS.surface, borderRadius: RADIUS.xl, padding: SPACING.xl },
  modalTitle: { fontFamily: FONTS.bold, fontSize: 18, color: COLORS.text, textAlign: 'right' },
  modalMessage: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textSecondary, textAlign: 'right', marginTop: SPACING.md },
  presets: { gap: SPACING.sm, marginTop: SPACING.lg },
  preset: { backgroundColor: COLORS.brandSoft, borderRadius: RADIUS.md, padding: SPACING.md },
  presetText: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.text, textAlign: 'right' },
  amountInput: { marginTop: SPACING.md, backgroundColor: COLORS.bg, borderRadius: RADIUS.md, padding: SPACING.md, fontFamily: FONTS.medium, color: COLORS.text },
  modalActions: { flexDirection: 'row-reverse', gap: SPACING.sm, marginTop: SPACING.lg },
  modalCancel: { flex: 1, padding: SPACING.md, borderRadius: RADIUS.md, backgroundColor: COLORS.bg, alignItems: 'center' },
  modalCancelText: { fontFamily: FONTS.medium, color: COLORS.textSecondary },
  modalConfirm: { flex: 1, padding: SPACING.md, borderRadius: RADIUS.md, backgroundColor: COLORS.brand, alignItems: 'center' },
  modalConfirmText: { fontFamily: FONTS.bold, color: '#fff' },
});
