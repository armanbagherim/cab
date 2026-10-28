import { Platform } from 'react-native';

/**
 * Design tokens — Cab / سفیر
 * Persian-first, light premium mobility palette.
 * Accent: near-black, disciplined single accent.
 */

export const COLORS = {
  brand: '#0A0A0A',
  brandDark: '#000000',
  brandSoft: '#F1F1F2',
  brandBorder: '#D1D5DB',

  bg: '#F7F7F8',
  surface: '#FFFFFF',
  scrim: 'rgba(10, 18, 28, 0.45)',

  text: '#111111',
  textSecondary: '#6B7280',
  textTertiary: '#9CA3AF',
  textOnDark: '#FFFFFF',

  border: '#E5E7EB',
  borderStrong: '#D1D5DB',
  divider: '#F1F1F2',

  success: '#16A34A',
  warning: '#E8A20C',
  error: '#E5484D',
  info: '#2E7CF6',

  pinOrigin: '#111111',
  pinDest: '#E5484D',
  pinDriver: '#2E7CF6',
} as const;

export const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

export const RADIUS = { xs: 6, sm: 10, md: 12, lg: 16, xl: 22, full: 999 } as const;

/** Vazirmatn family loaded via useFonts in app/_layout.tsx */
export const FONTS = {
  regular: 'Vazirmatn-Regular',
  medium: 'Vazirmatn-Medium',
  semibold: 'Vazirmatn-SemiBold',
  bold: 'Vazirmatn-Bold',
} as const;

export type FontKey = keyof typeof FONTS;

export const TYPO = {
  title: { fontFamily: FONTS.bold, fontSize: 24, color: COLORS.text },
  heading: { fontFamily: FONTS.bold, fontSize: 18, color: COLORS.text },
  subheading: { fontFamily: FONTS.semibold, fontSize: 15, color: COLORS.text },
  body: { fontFamily: FONTS.regular, fontSize: 14, color: COLORS.text },
  caption: { fontFamily: FONTS.regular, fontSize: 12, color: COLORS.textSecondary },
} as const;

const isWeb = Platform.OS === 'web';

/** Platform-correct, non-deprecated shadow tokens (boxShadow on web, shadow* on native). */
const mkShadow = (offsetY: number, blur: number, opacity: number, elevation: number) =>
  isWeb
    ? { boxShadow: `0px ${offsetY}px ${blur}px rgba(15, 24, 36, ${opacity})` }
    : {
        shadowColor: '#0F1824',
        shadowOffset: { width: 0, height: offsetY },
        shadowOpacity: opacity,
        shadowRadius: blur,
        elevation,
      };

export const SHADOW = {
  sm: mkShadow(1, 4, 0.10, 2),
  md: mkShadow(2, 10, 0.10, 4),
  lg: mkShadow(4, 18, 0.12, 8),
} as const;

/** Persian-aware number formatting (uses Latin digits kept client-side for prices readability) */
export function formatToman(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('fa-IR');
}

export function toPersianDigits(value: string | number): string {
  return String(value).replace(/\d/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
}
