import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  View, Text, TextInput, StyleSheet, Pressable, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import { ArrowRightIcon, PersonIcon, PhoneIcon, CarIcon, CashIcon, HistoryIcon } from '../components/Icons';
import ConfirmDialog from '../components/ConfirmDialog';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { COLORS, FONTS, SPACING, RADIUS, SHADOW } from '../utils/theme';

export default function ProfileScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user, updateUser } = useAuth();

  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<{ title: string; message?: string; success?: boolean } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const p = await api.getProfile();
        setProfile(p);
        setFirstName(p?.firstName || '');
        setLastName(p?.lastName || '');
      } catch (e: any) {
        setDialog({ title: 'خطا', message: e?.message || 'دریافت اطلاعات ناموفق بود' });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const save = useCallback(async () => {
    if (firstName.trim().length < 2 || lastName.trim().length < 2) {
      setDialog({ title: 'خطا', message: 'نام و نام خانوادگی هرکدام حداقل ۲ حرف است' });
      return;
    }
    setSaving(true);
    try {
      const updated = await api.updateProfile({ firstName: firstName.trim(), lastName: lastName.trim() });
      setProfile((p: any) => ({ ...p, firstName: updated.firstName, lastName: updated.lastName }));
      if (user) {
        updateUser({ ...user, firstName: updated.firstName, lastName: updated.lastName });
      }
      setEditing(false);
      setDialog({ title: 'ذخیره شد', message: 'اطلاعات حساب به‌روزرسانی شد', success: true });
    } catch (e: any) {
      setDialog({ title: 'ذخیره ناموفق', message: e?.message || 'دوباره تلاش کنید' });
    } finally {
      setSaving(false);
    }
  }, [firstName, lastName, user, updateUser]);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.headerRow}>
        <Pressable style={styles.backBtn} onPress={() => router.back()} accessibilityLabel="بازگشت">
          <ArrowRightIcon size={18} />
        </Pressable>
        <Text style={styles.title}>پروفایل</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={COLORS.brand} /></View>
      ) : profile ? (
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <View style={styles.body}>
            <View style={styles.card}>
              <View style={styles.avatarRow}>
                <View style={styles.avatar}>
                  <PersonIcon size={34} color={COLORS.brand} />
                </View>
                <View style={{ flex: 1 }}>
                  {editing ? (
                    <View style={{ gap: SPACING.sm }}>
                      <TextInput
                        style={styles.input}
                        value={firstName}
                        onChangeText={setFirstName}
                        placeholder="نام"
                        placeholderTextColor={COLORS.textTertiary}
                        textAlign="right"
                      />
                      <TextInput
                        style={styles.input}
                        value={lastName}
                        onChangeText={setLastName}
                        placeholder="نام خانوادگی"
                        placeholderTextColor={COLORS.textTertiary}
                        textAlign="right"
                        onSubmitEditing={save}
                      />
                    </View>
                  ) : (
                    <>
                      <Text style={styles.name}>{profile.firstName} {profile.lastName}</Text>
                      <View style={styles.phoneRow}>
                        <PhoneIcon size={13} color={COLORS.textSecondary} />
                        <Text style={styles.phone}>{profile.phone}</Text>
                      </View>
                    </>
                  )}
                  <View style={[styles.roleBadge, profile.role === 'DRIVER' && styles.roleBadgeDriver]}>
                    <Text style={styles.roleText}>{profile.role === 'DRIVER' ? 'سفیر' : 'مسافر'}</Text>
                  </View>
                </View>
              </View>

              {profile.role === 'DRIVER' && profile.driverStatus ? (
                <View style={styles.statusRow}>
                  <CarIcon size={18} color={COLORS.brand} />
                  <Text style={styles.statusText}>
                    {profile.driverStatus.isOnTrip
                      ? 'در حال انجام سفر'
                      : profile.driverStatus.isOnline
                        ? profile.driverStatus.isAccepting ? 'آنلاین — دریافت سفر فعال' : 'آنلاین — دریافت غیرفعال'
                        : 'غیرفعال'}
                  </Text>
                </View>
              ) : null}

              <Text style={styles.hint}>شماره موبایل شناسایی‌شده است و قابل تغییر نیست.</Text>
            </View>

            {/* Quick access: wallet (passenger) and trip history for both roles */}
            {profile.role !== 'DRIVER' ? (
              <Pressable
                style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.85 }]}
                onPress={() => router.push('/wallet')}
              >
                <CashIcon size={18} color={COLORS.brand} />
                <Text style={styles.linkText}>کیف پول</Text>
                <ArrowRightIcon size={16} color={COLORS.textTertiary} />
              </Pressable>
            ) : null}
            <Pressable
              style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.85 }]}
              onPress={() => router.push('/(passenger)/trip-history' as any)}
            >
              <HistoryIcon size={18} color={COLORS.brand} />
              <Text style={styles.linkText}>سفرهای من</Text>
              <ArrowRightIcon size={16} color={COLORS.textTertiary} />
            </Pressable>

            {editing ? (
              <View style={styles.actions}>
                <Pressable style={({ pressed }) => [styles.btnGhost, styles.flexBtn, pressed && { opacity: 0.85 }]} onPress={() => {
                  setEditing(false);
                  setFirstName(profile.firstName);
                  setLastName(profile.lastName);
                }} disabled={saving}>
                  <Text style={styles.btnGhostText}>انصراف</Text>
                </Pressable>
                <Pressable style={({ pressed }) => [styles.btnPrimary, styles.flexBtn, pressed && { opacity: 0.9 }, saving && { opacity: 0.6 }]} onPress={save} disabled={saving}>
                  {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.btnPrimaryText}>ذخیره</Text>}
                </Pressable>
              </View>
            ) : (
              <Pressable style={({ pressed }) => [styles.btnPrimary, pressed && { opacity: 0.9 }]} onPress={() => setEditing(true)}>
                <Text style={styles.btnPrimaryText}>ویرایش نام</Text>
              </Pressable>
            )}
          </View>
        </KeyboardAvoidingView>
      ) : null}

      <ConfirmDialog
        visible={!!dialog}
        title={dialog?.title || ''}
        description={dialog?.message}
        confirmText="متوجه شدم"
        danger={!dialog?.success}
        onCancel={() => setDialog(null)}
        onConfirm={() => setDialog(null)}
      />
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
  body: { flex: 1, padding: SPACING.lg },
  card: {
    backgroundColor: COLORS.surface, borderRadius: RADIUS.lg,
    padding: SPACING.lg, marginBottom: SPACING.lg, ...SHADOW.sm,
  },
  avatarRow: { flexDirection: 'row-reverse', gap: SPACING.md, alignItems: 'flex-start' },
  avatar: {
    width: 60, height: 60, borderRadius: 20, backgroundColor: COLORS.brandSoft,
    justifyContent: 'center', alignItems: 'center',
  },
  name: { fontFamily: FONTS.bold, fontSize: 17, color: COLORS.text, textAlign: 'right' },
  phoneRow: { flexDirection: 'row-reverse', alignItems: 'center', gap: 5, marginTop: 4 },
  phone: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.textSecondary, writingDirection: 'ltr' as any },
  roleBadge: {
    alignSelf: 'flex-start', backgroundColor: COLORS.brandSoft, borderRadius: RADIUS.full,
    paddingHorizontal: 12, paddingVertical: 4, marginTop: SPACING.sm,
  },
  roleBadgeDriver: { backgroundColor: '#E8F0FE' },
  roleText: { fontFamily: FONTS.semibold, fontSize: 12, color: COLORS.brand },
  statusRow: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 8,
    marginTop: SPACING.lg, paddingTop: SPACING.md, borderTopWidth: 1, borderTopColor: COLORS.divider,
  },
  statusText: { flex: 1, fontFamily: FONTS.medium, fontSize: 13, color: COLORS.text, textAlign: 'right' },
  hint: {
    fontFamily: FONTS.regular, fontSize: 11, color: COLORS.textTertiary,
    marginTop: SPACING.md, textAlign: 'right',
  },
  linkRow: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: SPACING.md,
    backgroundColor: COLORS.surface, borderRadius: RADIUS.lg,
    padding: SPACING.lg, marginBottom: SPACING.md, ...SHADOW.sm,
  },
  linkText: { flex: 1, fontFamily: FONTS.medium, fontSize: 14, color: COLORS.text, textAlign: 'right' },
  input: {
    backgroundColor: COLORS.bg, borderRadius: RADIUS.md, borderWidth: 1.2, borderColor: COLORS.border,
    paddingVertical: 10, paddingHorizontal: SPACING.md,
    fontFamily: FONTS.regular, fontSize: 14, color: COLORS.text, textAlign: 'right',
  },
  actions: { flexDirection: 'row-reverse', gap: SPACING.md },
  flexBtn: { flex: 1 },
  btnPrimary: {
    backgroundColor: COLORS.brand, borderRadius: RADIUS.lg,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row-reverse', gap: 8,
  },
  btnPrimaryText: { fontFamily: FONTS.bold, fontSize: 15, color: '#fff' },
  btnGhost: {
    borderWidth: 1.2, borderColor: COLORS.border, borderRadius: RADIUS.lg,
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center',
  },
  btnGhostText: { fontFamily: FONTS.semibold, fontSize: 15, color: COLORS.textSecondary },
});
