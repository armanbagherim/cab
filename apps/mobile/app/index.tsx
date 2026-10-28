import React, { useEffect, useRef } from 'react';
import { useRouter } from 'expo-router';
import { View, Text, StyleSheet, Pressable, ScrollView, Linking } from 'react-native';
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
    if (user.role === 'DRIVER') router.replace('/(driver)' as any);
  }, [user, isLoading, router]);

  if (isLoading) return <View style={styles.splash} />;
  if (user) return <ServiceHub />;

  const selectRole = (role: 'PASSENGER' | 'DRIVER') =>
    router.push({ pathname: '/login', params: { role } } as any);

  return (
    <ScrollView
      contentContainerStyle={[styles.container, { paddingTop: insets.top + SPACING.lg, paddingBottom: insets.bottom + SPACING.lg }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.top}>
        <View style={styles.badge}>
          <MaterialCommunityIcons name="car-hatchback" size={24} color={COLORS.textOnDark} />
        </View>
        <View style={styles.brandCopy}>
          <Text style={styles.brandName}>راهینو</Text>
          <Text style={styles.tagline}>همراه هوشمند خدمات شهری</Text>
        </View>
      </View>

      <View style={styles.features}>
        <Text style={styles.sectionLabel}>سفر شهری، ساده و مطمئن</Text>
        <FeatureRow icon="map-marker-path" text="انتخاب دقیق مبدأ و مقصد روی نقشه نشان" />
        <FeatureRow icon="cash-multiple" text="مشاهده کرایه پیش از ثبت درخواست سفر" />
        <FeatureRow icon="shield-check-outline" text="سفر با سفیران تأییدشده سامانه" />
      </View>

      <View style={styles.roles}>
        <Text style={styles.sectionLabel}>چطور می‌خواهید ادامه دهید؟</Text>
        <Pressable
          style={({ pressed }) => [styles.roleCard, styles.passengerCard, pressed && styles.primaryPressed]}
          onPress={() => selectRole('PASSENGER')}
        >
          <View style={[styles.roleIconWrap, styles.passengerIcon]}>
            <MaterialCommunityIcons name="account-outline" size={26} color={COLORS.brand} />
          </View>
          <View style={styles.roleTextWrap}>
            <Text style={styles.primaryRoleTitle}>مسافر هستم</Text>
            <Text style={styles.primaryRoleDesc}>درخواست سفر و جابه‌جایی درون‌شهری</Text>
          </View>
          <MaterialIcons name="arrow-back" size={22} color={COLORS.textOnDark} />
        </Pressable>

        <Pressable
          style={({ pressed }) => [styles.roleCard, styles.driverCard, pressed && styles.secondaryPressed]}
          onPress={() => selectRole('DRIVER')}
        >
          <View style={styles.roleIconWrap}>
            <MaterialCommunityIcons name="steering" size={26} color={COLORS.text} />
          </View>
          <View style={styles.roleTextWrap}>
            <Text style={styles.roleTitle}>سفیر هستم</Text>
            <Text style={styles.roleDesc}>دریافت درخواست سفر و کسب درآمد</Text>
          </View>
          <MaterialIcons name="arrow-back" size={22} color={COLORS.text} />
        </Pressable>
      </View>
    </ScrollView>
  );
}

function ServiceHub() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const services = [
    { title: 'تاکسی', caption: 'سفر شهری سریع و مطمئن', icon: 'taxi', action: () => router.push('/(passenger)' as any), primary: true },
    { title: 'شاپ', caption: 'خرید و خدمات آنلاین', icon: 'shopping-outline', url: 'https://jahizan.com' },
    { title: 'گارانتی و خدمات', caption: 'پشتیبانی و خدمات پس از فروش', icon: 'shield-check-outline', url: 'https://ariakish.com' },
    { title: 'فروش آنلاین طلا', caption: 'خرید امن طلای آنلاین', icon: 'gold', url: 'https://pegahgold.ir' },
  ];
  return (
    <ScrollView contentContainerStyle={[styles.hubContainer, { paddingTop: insets.top + SPACING.md, paddingBottom: insets.bottom + SPACING.xl }]} showsVerticalScrollIndicator={false}>
      <View style={styles.hubHeader}>
        <View><Text style={styles.hubEyebrow}>خدمات روزمره شما</Text><Text style={styles.hubTitle}>راهینو</Text></View>
        <View style={styles.hubMark}><MaterialCommunityIcons name="map-marker-path" size={24} color="#fff" /></View>
      </View>
      <View style={styles.banner}><Text style={styles.bannerTitle}>هر مسیر، یک انتخاب ساده</Text><Text style={styles.bannerText}>از حمل‌ونقل تا خرید و خدمات، همه در راهینو</Text><View style={styles.bannerButton}><Text style={styles.bannerButtonText}>شروع کنید</Text></View></View>
      <Text style={styles.hubSection}>خدمات راهینو</Text>
      <View style={styles.serviceGrid}>
        {services.map((service) => (
          <Pressable key={service.title} style={({ pressed }) => [styles.serviceCard, service.primary && styles.serviceCardPrimary, pressed && { opacity: 0.86 }]} onPress={() => service.action ? service.action() : Linking.openURL(service.url!)}>
            <View style={[styles.serviceIcon, service.primary && styles.serviceIconPrimary]}><MaterialCommunityIcons name={service.icon as any} size={27} color={service.primary ? '#fff' : COLORS.text} /></View>
            <Text style={[styles.serviceTitle, service.primary && styles.serviceTitlePrimary]}>{service.title}</Text>
            <Text style={[styles.serviceCaption, service.primary && styles.serviceCaptionPrimary]}>{service.caption}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function FeatureRow({ icon, text }: { icon: any; text: string }) {
  return (
    <View style={styles.featureRow}>
      <View style={styles.featureIcon}>
      <MaterialCommunityIcons name={icon} size={17} color={COLORS.text} />
      </View>
      <Text style={styles.featureText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: COLORS.bg },
  container: { flexGrow: 1, backgroundColor: COLORS.bg, paddingHorizontal: SPACING.xl },
  hubContainer: { flexGrow: 1, backgroundColor: COLORS.bg, paddingHorizontal: SPACING.lg },
  hubHeader: { flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center' },
  hubEyebrow: { fontFamily: FONTS.medium, fontSize: 12, color: COLORS.textSecondary, textAlign: 'right' },
  hubTitle: { fontFamily: FONTS.bold, fontSize: 26, color: COLORS.text, textAlign: 'right', marginTop: 2 },
  hubMark: { width: 50, height: 50, borderRadius: RADIUS.lg, backgroundColor: COLORS.brand, justifyContent: 'center', alignItems: 'center' },
  banner: { backgroundColor: '#FDE68A', borderRadius: RADIUS.xl, padding: SPACING.xl, marginTop: SPACING.xl, minHeight: 136, justifyContent: 'center' },
  bannerTitle: { fontFamily: FONTS.bold, fontSize: 19, color: COLORS.text, textAlign: 'right' },
  bannerText: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textSecondary, textAlign: 'right', marginTop: 6 },
  bannerButton: { alignSelf: 'flex-end', backgroundColor: COLORS.brand, borderRadius: RADIUS.full, paddingHorizontal: SPACING.lg, paddingVertical: 8, marginTop: SPACING.md },
  bannerButtonText: { fontFamily: FONTS.bold, fontSize: 12, color: '#fff' },
  hubSection: { fontFamily: FONTS.bold, fontSize: 17, color: COLORS.text, textAlign: 'right', marginTop: SPACING.xxl, marginBottom: SPACING.md },
  serviceGrid: { flexDirection: 'row-reverse', flexWrap: 'wrap', gap: SPACING.md },
  serviceCard: { width: '47.8%', minHeight: 150, backgroundColor: COLORS.surface, borderRadius: RADIUS.xl, padding: SPACING.lg, borderWidth: 1, borderColor: COLORS.border, ...SHADOW.sm },
  serviceCardPrimary: { backgroundColor: COLORS.brand, borderColor: COLORS.brand },
  serviceIcon: { width: 48, height: 48, borderRadius: RADIUS.lg, backgroundColor: COLORS.brandSoft, justifyContent: 'center', alignItems: 'center', alignSelf: 'flex-end' },
  serviceIconPrimary: { backgroundColor: 'rgba(255,255,255,0.18)' },
  serviceTitle: { fontFamily: FONTS.bold, fontSize: 16, color: COLORS.text, textAlign: 'right', marginTop: SPACING.md },
  serviceTitlePrimary: { color: '#fff' },
  serviceCaption: { fontFamily: FONTS.regular, fontSize: 11, color: COLORS.textSecondary, textAlign: 'right', marginTop: 4 },
  serviceCaptionPrimary: { color: '#D1D5DB' },
  top: { alignItems: 'center', paddingTop: SPACING.lg },
  badge: {
    width: 56, height: 56, borderRadius: RADIUS.lg,
    backgroundColor: COLORS.brand, justifyContent: 'center', alignItems: 'center',
    marginBottom: SPACING.md, ...SHADOW.sm,
  },
  brandCopy: { alignItems: 'center' },
  brandName: { fontFamily: FONTS.bold, fontSize: 30, color: COLORS.text },
  tagline: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textSecondary, marginTop: 4 },

  features: { marginTop: SPACING.xxxl, gap: 10 },
  sectionLabel: { fontFamily: FONTS.bold, fontSize: 15, color: COLORS.text, textAlign: 'right', marginBottom: 2 },
  featureRow: {
    flexDirection: 'row-reverse', alignItems: 'center', gap: 10, backgroundColor: COLORS.surface,
    borderRadius: RADIUS.md, padding: SPACING.md, borderWidth: 1, borderColor: COLORS.border,
  },
  featureIcon: {
    width: 30, height: 30, borderRadius: RADIUS.sm, backgroundColor: COLORS.brandSoft,
    justifyContent: 'center', alignItems: 'center',
  },
  featureText: { fontFamily: FONTS.medium, fontSize: 13, color: COLORS.textSecondary, textAlign: 'right', flex: 1 },

  roles: { marginTop: SPACING.xxxl, gap: SPACING.md },
  roleCard: { flexDirection: 'row-reverse', alignItems: 'center', padding: SPACING.lg, borderRadius: RADIUS.lg, minHeight: 92 },
  passengerCard: { backgroundColor: COLORS.brand, ...SHADOW.md },
  driverCard: { backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border, ...SHADOW.sm },
  primaryPressed: { backgroundColor: COLORS.brandDark, opacity: 0.94 },
  secondaryPressed: { backgroundColor: COLORS.divider },
  roleIconWrap: {
    width: 48, height: 48, borderRadius: RADIUS.md, backgroundColor: COLORS.brandSoft,
    justifyContent: 'center', alignItems: 'center', marginLeft: SPACING.md,
  },
  passengerIcon: { backgroundColor: COLORS.surface },
  roleTextWrap: { flex: 1 },
  roleTitle: { fontFamily: FONTS.bold, fontSize: 17, color: COLORS.text, marginBottom: 2 },
  roleDesc: { fontFamily: FONTS.regular, fontSize: 13, color: COLORS.textSecondary, textAlign: 'right' },
  primaryRoleTitle: { fontFamily: FONTS.bold, fontSize: 17, color: COLORS.textOnDark, marginBottom: 2 },
  primaryRoleDesc: { fontFamily: FONTS.regular, fontSize: 13, color: '#D1D5DB', textAlign: 'right' },
});
