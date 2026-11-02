import React, { useMemo, useState } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator, Image,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useRouter } from 'expo-router';
import BackButton from '../components/BackButton';
import { api } from '../services/api';
import ConfirmDialog from '../components/ConfirmDialog';
import { useKeyboardBottomInset } from '../hooks/useKeyboardBottomInset';
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
  const keyboardInset = useKeyboardBottomInset();
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
      <Image
        source={require('../assets/images/login-hero.jpg')}
        style={styles.backgroundImage}
        resizeMode="cover"
        fadeDuration={0}
      />
      <View style={styles.backgroundScrim} />
      <View style={[styles.backBtnWrap, { top: insets.top + 10 }]}>
        <BackButton light onPress={() => router.back()} />
      </View>

      {/* Bottom sheet — padding lifts the Continue button above the keyboard
          on both native and iOS Safari/WebView (VisualViewport-based hook). */}
      <View style={styles.sheetWrap}>
        <View
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom + SPACING.lg, 28) + keyboardInset },
          ]}
        >
          <View style={styles.sheetGrabber} />

          <Text style={styles.greeting}>
            {isDriver ? 'ورود یا ثبت‌نام سفیر' : 'ورود یا ثبت‌نام مسافر'}
          </Text>
          <Text style={styles.greetingSub}>
            شماره موبایل خود را وارد کنید؛ کد تأیید پیامک خواهد شد.
          </Text>

          <View style={styles.inputWrap}>
            {/* Iran (+۹۸) is the only supported country for now, so the code
                is fixed and not shown as a redundant disabled field. The input
                is purely the Iranian mobile number (09xxxxxxxxx). */}
            <View style={[styles.inputGroup, error && styles.inputGroupError]}>
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
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },

  backgroundImage: { ...StyleSheet.absoluteFill as any, width: '100%', height: '100%' },
  backgroundScrim: { ...StyleSheet.absoluteFill as any, backgroundColor: 'rgba(8, 18, 15, 0.42)' },

  backBtnWrap: {
    position: 'absolute', left: SPACING.lg,
  },
  sheetWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '68%' },
  sheet: {
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderTopLeftRadius: RADIUS.xl, borderTopRightRadius: RADIUS.xl,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.75)',
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
  input: { flex: 1, fontFamily: FONTS.medium, fontSize: 17, color: COLORS.text, paddingVertical: 16, paddingHorizontal: SPACING.lg, alignContent: 'flex-start' },
  inputError: {
    fontFamily: FONTS.regular, fontSize: 12, color: COLORS.error,
    textAlign: 'right', marginTop: SPACING.sm, marginHorizontal: SPACING.xs,
  },

  primaryBtn: {
    marginTop: SPACING.lg, backgroundColor: COLORS.brand,
    borderRadius: RADIUS.lg, paddingVertical: 16, alignItems: 'center', justifyContent: 'center',
    ...SHADOW.md,
  },
  primaryBtnDisabled: { opacity: 0.5 },
  primaryBtnText: { fontFamily: FONTS.bold, fontSize: 16, color: '#fff' },
});
