import React, { useMemo, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator,
  KeyboardAvoidingView, Platform, Image,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useRouter } from 'expo-router';
import { ArrowRightIcon } from '../components/Icons';
import { api } from '../services/api';
import ConfirmDialog from '../components/ConfirmDialog';
import { COLORS, FONTS, SPACING, RADIUS, SHADOW } from '../utils/theme';

/** Persian (۰-۹) and Arabic-Indic (٠-٩) digits → ASCII equivalents. */
function normalizeDigits(raw: string): string {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';
  return raw.replace(/[۰-۹٠-٩]/g, (ch) => {
    const i = fa.indexOf(ch);
    return i >= 0 ? String(i) : String(ar.indexOf(ch));
  });
}

/** Iranian mobile numbers: 09xxxxxxxxx (11 digits, starts with 09).
 * Persian/Arabic-Indic digits are treated as equivalent to ASCII. */
function normalizePhone(raw: string): string | null {
  const digits = normalizeDigits(raw).replace(/[^0-9]/g, '');
  let v = digits;
  if (v.startsWith('98')) v = '0' + v.slice(2);
  if (v.startsWith('9') && v.length === 10) v = '0' + v;
  return /^09\d{9}$/.test(v) ? v : null;
}

export default function LoginScreen() {
  const router = useRouter();
  const { role } = useLocalSearchParams<{ role?: string }>();
  const insets = useSafeAreaInsets();
  const isDriver = role === 'DRIVER';

  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const canSubmit = useMemo(() => normalizePhone(phone) !== null, [phone]);

  async function handleSendOtp() {
    const normalized = normalizePhone(phone);
    if (!normalized) {
      setError('شماره موبایل معتبر نیست؛ باید با ۰۹ شروع شود و ۱۱ رقم باشد');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await api.sendOtp(normalized, isDriver ? 'DRIVER' : 'PASSENGER');
      router.push({ pathname: '/verify-otp', params: { phone: normalized, role: isDriver ? 'DRIVER' : 'PASSENGER' } } as any);
    } catch (err: any) {
      const msg = err?.message && err.message !== 'Request failed' ? err.message : 'خطا در ارسال کد تأیید';
      setDialogError(msg);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      {/* Hero */}
      <View style={styles.hero}>
        <Image
          source={require('../assets/images/login-hero.jpg')}
          style={styles.heroImage}
          resizeMode="cover"
          fadeDuration={0}
        />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(9, 20, 16, 0.42)' }]} />
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(9, 20, 16, 0.2)' }]} />
        <View style={styles.heroContent}>
          <View style={styles.brandBadge}>
            <Text style={styles.brandLetter}>س</Text>
          </View>
        </View>
        {/* Back to role selection */}
        <Pressable
          accessibilityLabel="بازگشت"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.backBtn, pressed && { opacity: 0.7 }, { top: insets.top + 10 }]}
          hitSlop={12}
        >
          <ArrowRightIcon size={18} color="#fff" />
        </Pressable>
      </View>

      {/* Sheet */}
      <KeyboardAvoidingView
        style={styles.sheetWrap}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom + SPACING.lg, 28) }]}>
          <View style={styles.sheetGrabber} />

          <Text style={styles.greeting}>
            {isDriver ? 'ورود یا ثبت‌نام سفیر' : 'ورود یا ثبت‌نام مسافر'}
          </Text>
          <Text style={styles.greetingSub}>
            شماره موبایل خود را وارد کنید؛ کد تأیید پیامک خواهد شد.
          </Text>

          <View style={styles.inputWrap}>
            <View style={[styles.inputGroup, error && styles.inputGroupError]}>
              <Text style={styles.inputPrefix}>+۹۸</Text>
              <TextInput
                style={styles.input}
                value={phone}
                onChangeText={(t) => {
                  setPhone(t);
                  setError(null);
                }}
                placeholder="09123456789"
                placeholderTextColor={COLORS.textTertiary}
                keyboardType="phone-pad"
                inputMode="numeric"
                maxLength={11}
                returnKeyType="done"
                onSubmitEditing={handleSendOtp}
                blurOnSubmit={false}
                textAlign="right"
                autoComplete="tel"
                textContentType="telephoneNumber"
              />
            </View>
            {error ? <Text style={styles.inputError}>{error}</Text> : null}
          </View>

          <Pressable
            style={({ pressed }) => [
              styles.primaryBtn,
              (!canSubmit || loading) && styles.primaryBtnDisabled,
              (pressed && canSubmit && !loading) && { opacity: 0.9 },
            ]}
            onPress={handleSendOtp}
            disabled={!canSubmit || loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <Text style={styles.primaryBtnText}>ادامه</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },

  hero: { height: '42%', minHeight: 260, backgroundColor: '#0B1512' },
  heroImage: { ...StyleSheet.absoluteFill as any, width: '100%', height: '100%' },
  heroContent: {
    flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 30,
  },
  brandBadge: {
    width: 72, height: 72, borderRadius: 24,
    backgroundColor: COLORS.brand, justifyContent: 'center', alignItems: 'center',
    borderWidth: 4, borderColor: 'rgba(255,255,255,0.92)', ...SHADOW.md,
  },
  brandLetter: { fontFamily: FONTS.bold, fontSize: 34, color: '#fff', marginTop: -3 },

  backBtn: {
    position: 'absolute', left: SPACING.lg,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(9, 20, 16, 0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
    justifyContent: 'center', alignItems: 'center',
  },
  sheetWrap: { flex: 1 },
  sheet: {
    flex: 1, backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    marginTop: -RADIUS.xl,
    paddingHorizontal: SPACING.xxl, paddingTop: 10,
    ...SHADOW.lg,
  },
  sheetGrabber: {
    alignSelf: 'center', width: 36, height: 4, borderRadius: 2,
    backgroundColor: COLORS.borderStrong, marginBottom: SPACING.lg,
  },

  greeting: { fontFamily: FONTS.bold, fontSize: 22, color: COLORS.text, textAlign: 'right' },
  greetingSub: {
    fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textSecondary,
    textAlign: 'right', marginTop: 6, lineHeight: 21,
  },

  inputWrap: { marginTop: 'auto', paddingTop: SPACING.xxl },
  inputGroup: {
    flexDirection: 'row-reverse', alignItems: 'center',
    backgroundColor: COLORS.bg, borderRadius: RADIUS.lg,
    borderWidth: 1.2, borderColor: COLORS.border, overflow: 'hidden',
  },
  inputGroupError: { borderColor: COLORS.error },
  inputPrefix: {
    fontFamily: FONTS.medium, fontSize: 16, color: COLORS.textSecondary,
    paddingHorizontal: SPACING.lg, paddingVertical: 16,
    borderLeftWidth: 1, borderLeftColor: COLORS.divider,
  },
  input: { flex: 1, fontFamily: FONTS.medium, fontSize: 17, color: COLORS.text, paddingVertical: 16, paddingHorizontal: SPACING.lg, alignContent: 'flex-start' },
  inputError: {
    fontFamily: FONTS.regular, fontSize: 12, color: COLORS.error,
    textAlign: 'right', marginTop: SPACING.sm, marginHorizontal: SPACING.xs,
  },

  primaryBtn: {
    marginTop: SPACING.lg, backgroundColor: COLORS.brand,
    borderRadius: RADIUS.lg, paddingVertical: 16, alignItems: 'center', justifyContent: 'center',
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { fontFamily: FONTS.bold, fontSize: 16, color: '#fff' },
});
