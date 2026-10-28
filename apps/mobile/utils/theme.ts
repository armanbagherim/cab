import { Platform } from 'react-native';

/**
 * Design tokens — Cab / سفیر
 * Persian-first, light premium mobility palette.
 * Accent: brand green (#0FA958 family), disciplined single accent.
 */

export const COLORS = {
  brand: '#0FA958',
  brandDark: '#0B8A47',
  brandSoft: '#E9F8F0',
  brandBorder: '#BBE8CF',

  bg: '#F6F7F9',
  surface: '#FFFFFF',
  scrim: 'rgba(10, 18, 28, 0.45)',

  text: '#111C27',
  textSecondary: '#5D6B7A',
  textTertiary: '#98A3AE',
  textOnDark: '#FFFFFF',

  border: '#E5E9EE',
  borderStrong: '#D3DAE1',
  divider: '#F0F2F5',

  success: '#0FA958',
  warning: '#E8A20C',
  error: '#E5484D',
  info: '#2E7CF6',

  pinOrigin: '#0FA958',
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
