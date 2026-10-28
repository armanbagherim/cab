import React, { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { COLORS, FONTS, SPACING, RADIUS, SHADOW } from '../utils/theme';

/**
 * Role gate:
 *  - Loading retained session  → splash.
 *  - Authenticated             → redirect to the app matching the stored role.
 *  - Unauthenticated           → role selection (passenger / سفیر).
 */
export default function RoleSelect() {
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const insets = useSafeAreaInsets();

  // Redirect whenever the auth state resolves to a logged-in user.
  // We intentionally do NOT use a ref guard so that after logout (user → null)
  // and a subsequent login the redirect fires again correctly.
  useEffect(() => {
    if (isLoading || !user) return;
    const dest = user.role === 'DRIVER' ? '/(driver)' : '/(passenger)';
    router.replace(dest as any);
  }, [user, isLoading, router]);

  if (isLoading || user) return <View style={styles.splash} />;

  const selectRole = (role: 'PASSENGER' | 'DRIVER') =>
    router.push({ pathname: '/login', params: { role } } as any);

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.top}>
        <View style={styles.badge}>
          <MaterialCommunityIcons name="car-hatchback" size={22} color="#fff" />
        </View>
        <Text style={styles.brandName}>سیار</Text>
        <Text style={styles.tagline}>سامانه هوشمند حمل‌ونقل درون‌شهری</Text>
      </View>

      <View style={styles.features}>
        <FeatureRow icon="map-marker-path" text="انتخاب دقیق مبدأ و مقصد روی نقشه نشان" />
        <FeatureRow icon="cash-multiple" text="مشاهده کرایه پیش از ثبت درخواست سفر" />
        <FeatureRow icon="shield-check-outline" text="سفر با سفیران تأییدشده سامانه" />
      </View>

      <View style={[styles.card, { bottom: insets.bottom + 48 }]}>
        <Pressable
          style={({ pressed }) => [styles.roleBtn, pressed && styles.roleBtnPressed]}
          onPress={() => selectRole('PASSENGER')}
        >
          <View style={styles.roleIconWrap}>
            <MaterialCommunityIcons name="account-outline" size={26} color={COLORS.brand} />
          </View>
          <View style={styles.roleTextWrap}>
            <Text style={styles.roleTitle}>مسافر هستم</Text>
            <Text style={styles.roleDesc}>درخواست سفر و جابه‌جایی درون‌شهری</Text>
          </View>
          <MaterialIcons name="chevron-right" size={22} color={COLORS.textTertiary} />
        </Pressable>

        <View style={styles.divider} />

        <Pressable
          style={({ pressed }) => [styles.roleBtn, pressed && styles.roleBtnPressed]}
          onPress={() => selectRole('DRIVER')}
        >
          <View style={styles.roleIconWrap}>
            <MaterialCommunityIcons name="steering" size={26} color={COLORS.brand} />
          </View>
          <View style={styles.roleTextWrap}>
            <Text style={styles.roleTitle}>سفیر هستم</Text>
            <Text style={styles.roleDesc}>دریافت درخواست سفر و کسب درآمد</Text>
          </View>
          <MaterialIcons name="chevron-right" size={22} color={COLORS.textTertiary} />
        </Pressable>
      </View>
    </View>
  );
}

function FeatureRow({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={styles.featureRow}>
      <View style={styles.featureIcon}>
        <MaterialCommunityIcons name={icon} size={16} color={COLORS.brand} />
      </View>
      <Text style={styles.featureText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: COLORS.bg },
  container: { flex: 1, backgroundColor: COLORS.bg },
  top: { alignItems: 'center' },
  badge: {
    width: 64, height: 64, borderRadius: RADIUS.xl,
    backgroundColor: COLORS.brand, justifyContent: 'center', alignItems: 'center',
    marginBottom: SPACING.lg, ...SHADOW.md,
  },
  brandName: { fontFamily: FONTS.bold, fontSize: 32, color: COLORS.text },
  tagline: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.textSecondary, marginTop: 6 },

  features: { marginTop: SPACING.xxl, paddingHorizontal: SPACING.xxxl, gap: 10 },
  featureRow: {
    flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 10,
  },
  featureIcon: {
    width: 28, height: 28, borderRadius: 8, backgroundColor: COLORS.brandSoft,
    justifyContent: 'center', alignItems: 'center',
  },
  featureText: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textSecondary, textAlign: 'right', flex: 1 },

  card: {
    position: 'absolute', left: SPACING.xl, right: SPACING.xl,
    backgroundColor: COLORS.surface, borderRadius: RADIUS.xl, padding: SPACING.sm,
    ...SHADOW.md,
  },
  roleBtn: { flexDirection: 'row-reverse', alignItems: 'center', padding: SPACING.lg, borderRadius: RADIUS.lg },
  roleBtnPressed: { backgroundColor: COLORS.divider },
  roleIconWrap: {
    width: 48, height: 48, borderRadius: RADIUS.md, backgroundColor: COLORS.brandSoft,
    justifyContent: 'center', alignItems: 'center', marginRight: SPACING.md,
  },
  roleTextWrap: { flex: 1 },
  roleTitle: { fontFamily: FONTS.bold, fontSize: 17, color: COLORS.text, marginBottom: 2 },
  roleDesc: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textSecondary, textAlign: 'right' },
  divider: { height: 1, backgroundColor: COLORS.divider, marginHorizontal: SPACING.lg },
});
