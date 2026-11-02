import React, { useMemo, useState } from 'react';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator,
} from 'react-native';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import BackButton from '../components/BackButton';
import OtpInput from '../components/OtpInput';
import ConfirmDialog from '../components/ConfirmDialog';
import { useKeyboardBottomInset } from '../hooks/useKeyboardBottomInset';
import { COLORS, FONTS, SPACING, RADIUS } from '../utils/theme';

const LENGTH = 6; // must match OtpInput's cell count

export default function VerifyOtpScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const keyboardInset = useKeyboardBottomInset();
  const { phone, role } = useLocalSearchParams<{ phone: string; role: string }>();
  const { login } = useAuth();

  const [otp, setOtp] = useState('');
  const [otpError, setOtpError] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [step, setStep] = useState<'otp' | 'name'>('otp');
  const [loading, setLoading] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const isDriver = role === 'DRIVER';

  const otpReady = otp.length === LENGTH;
  const nameReady = useMemo(
    () => firstName.trim().length >= 2 && lastName.trim().length >= 2,
    [firstName, lastName]
  );

  async function completeLogin(finalOtp: string, name?: { firstName: string; lastName: string }) {
    const r = await api.verifyOtp(phone!, finalOtp, role!, name?.firstName, name?.lastName);
    // Route from the role the backend actually stored — never from local params alone.
    const resolvedRole = (r.user?.role as string) || role;
    await login(r.token, r.user);
    router.replace(resolvedRole === 'DRIVER' ? '/(driver)' : '/(passenger)');
  }

  async function handleVerify() {
    if (otp.length !== LENGTH) return;
    setLoading(true);
    try {
      await completeLogin(otp);
    } catch (err: any) {
      const msg = err?.message || 'کد تأیید نامعتبر است';
      if (msg.includes('نام') || msg.includes('ثبت')) {
        setStep('name');
      } else {
        // Wrong/failed code: highlight the cells; typing again clears it.
        setOtpError(true);
        setDialogError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister() {
    if (!nameReady) return;
    setLoading(true);
    try {
      await completeLogin(otp!, { firstName: firstName.trim(), lastName: lastName.trim() });
    } catch (err: any) {
      setDialogError(err?.message || 'خطا در ثبت‌نام');
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <BackButton onPress={() => router.back()} />
        <Text style={styles.headerTitle}>{step === 'otp' ? 'کد تأیید' : isDriver ? 'ثبت‌نام سفیر' : 'ثبت‌نام مسافر'}</Text>
      </View>

      <View style={[styles.body, { paddingBottom: styles.body.paddingBottom + keyboardInset }]}>
        {step === 'otp' ? (
          <>
            <Text style={styles.subTitle}>کد ۶ رقمی ارسال‌شده به شماره زیر را وارد کنید</Text>
            <Text style={styles.phoneBadge}>{phone}</Text>

            <OtpInput
              value={otp}
              onChange={(v) => {
                setOtp(v);
                if (otpError) setOtpError(false); // clear the error as the user corrects the code
              }}
              onComplete={(v) => { if (!loading) handleVerify(); }}
              error={otpError}
            />

            <Pressable
              style={({ pressed }) => [
                styles.primaryBtn,
                (!otpReady || loading) && styles.btnDisabled,
                (pressed && otpReady && !loading) && { opacity: 0.9 },
              ]}
              onPress={handleVerify}
              disabled={!otpReady || loading}
            >
              {loading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.btnText}>تأیید و ورود</Text>}
            </Pressable>
          </>
        ) : (
          <>
            <Text style={styles.subTitle}>
              برای تکمیل ثبت‌نام، نام و نام خانوادگی خود را وارد کنید
            </Text>

            <View style={styles.fieldGroup}>
              <Text style={styles.label}>نام</Text>
              <TextInput
                style={styles.input}
                value={firstName}
                onChangeText={setFirstName}
                placeholder="مثال: علی"
                placeholderTextColor={COLORS.textTertiary}
                textAlign="right"
                returnKeyType="next"
              />
            </View>
            <View style={styles.fieldGroup}>
              <Text style={styles.label}>نام خانوادگی</Text>
              <TextInput
                style={styles.input}
                value={lastName}
                onChangeText={setLastName}
                placeholder="مثال: احمدی"
                placeholderTextColor={COLORS.textTertiary}
                textAlign="right"
                returnKeyType="done"
                onSubmitEditing={handleRegister}
              />
            </View>

            <Pressable
              style={({ pressed }) => [
                styles.primaryBtn,
                (!nameReady || loading) && styles.btnDisabled,
                (pressed && nameReady && !loading) && { opacity: 0.9 },
              ]}
              onPress={handleRegister}
              disabled={!nameReady || loading}
            >
              {loading ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.btnText}>تکمیل ثبت‌نام</Text>}
            </Pressable>
          </>
        )}
      </View>

      <ConfirmDialog
        visible={!!dialogError}
        title="خطا در عملیات"
        description={dialogError || ''}
        confirmText="متوجه شدم"
        onCancel={() => setDialogError(null)}
        onConfirm={() => setDialogError(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  headerRow: {
    flexDirection: 'row-reverse', alignItems: 'center',
    gap: SPACING.md, padding: SPACING.lg,
  },
  headerTitle: { fontFamily: FONTS.bold, fontSize: 17, color: COLORS.text },

  body: { flex: 1, paddingHorizontal: SPACING.xxl, paddingBottom: SPACING.lg },
  subTitle: {
    fontFamily: FONTS.regular, fontSize: 14, color: COLORS.textSecondary,
    textAlign: 'right', marginTop: SPACING.xl, lineHeight: 22,
  },
  phoneBadge: {
    fontFamily: FONTS.bold, fontSize: 16, color: COLORS.brand,
    textAlign: 'center', marginTop: SPACING.md,
    backgroundColor: COLORS.brandSoft,
    alignSelf: 'center', borderRadius: RADIUS.full,
    overflow: 'hidden', paddingVertical: 6, paddingHorizontal: SPACING.lg,
    writingDirection: 'ltr' as any,
  },

  fieldGroup: { marginTop: SPACING.xl },
  label: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.textSecondary, marginBottom: SPACING.sm, textAlign: 'right' },
  input: {
    backgroundColor: COLORS.surface, borderRadius: RADIUS.lg, paddingVertical: 14,
    paddingHorizontal: SPACING.lg, fontSize: 15, fontFamily: FONTS.regular,
    color: COLORS.text, borderWidth: 1.2, borderColor: COLORS.border,
  },

  primaryBtn: {
    marginTop: 'auto', marginBottom: SPACING.lg, backgroundColor: COLORS.brand,
    borderRadius: RADIUS.lg, paddingVertical: 16,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.14, shadowRadius: 10, elevation: 4,
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { fontFamily: FONTS.bold, fontSize: 16, color: '#fff' },
});
