import { useEffect, useMemo } from 'react';
import { I18nManager, Platform } from 'react-native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../context/AuthContext';
import { COLORS, FONTS } from '../utils/theme';

// The app is fully hand-RTL; allow RTL so native navigation transitions mirror.
I18nManager.allowRTL(true);

/**
 * Web (iOS Safari / WebView): block the horizontal edge-swipe that navigates
 * back and shifts the page. Targeted, not global:
 * - CSS `overscroll-behavior-x: none` kills the page-level rubber banding.
 * - A capture-phase `touchmove` handler prevents the default only for
 *   predominantly-horizontal drags. Map gestures (Leaflet pan/zoom) and
 *   horizontal scrolling inside inputs/text areas stay untouched.
 */
function useIosSwipeBackGuard() {
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const style = document.createElement('style');
    style.setAttribute('data-rahino-swipe-guard', '');
    style.textContent = 'html, body { overscroll-behavior-x: none; }';
    document.head.appendChild(style);

    let startX = 0;
    let startY = 0;
    let tracking = false;

    const isProtectedSurface = (target: EventTarget | null): boolean => {
      if (!(target instanceof Element)) return false;
      // Leaflet map (web) or any WebView-hosted map surface keeps its gestures.
      return !!target.closest('.leaflet-container, #map, input, textarea, [contenteditable="true"]');
    };

    const onTouchStart = (e: TouchEvent) => {
      tracking = e.touches.length === 1;
      if (tracking) {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      // Dominantly horizontal drag away from interactive surfaces — the bar
      // height that triggers iOS swipe-back navigation / page shifting.
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10 && !isProtectedSurface(e.target)) {
        e.preventDefault();
      }
    };

    // `passive: false` is required for preventDefault to have any effect.
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });

    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      style.remove();
    };
  }, []);
}

const FONT_ASSETS = {
  [FONTS.regular]: require('../assets/fonts/Vazirmatn-Regular.ttf'),
  [FONTS.medium]: require('../assets/fonts/Vazirmatn-Medium.ttf'),
  [FONTS.semibold]: require('../assets/fonts/Vazirmatn-SemiBold.ttf'),
  [FONTS.bold]: require('../assets/fonts/Vazirmatn-Bold.ttf'),
};

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(FONT_ASSETS);
  useIosSwipeBackGuard();

  useEffect(() => {
    if (fontError) {
      // Never blank the app on font failure; native system font takes over.
      console.warn('[Fonts] Failed to load Vazirmatn:', fontError);
    }
  }, [fontError]);

  const screens = useMemo(
    () => (
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: COLORS.bg },
          animation: 'slide_from_left',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="home" />
        <Stack.Screen name="login" />
        <Stack.Screen name="verify-otp" />
        <Stack.Screen name="profile" />
        <Stack.Screen name="wallet" />
        <Stack.Screen name="(passenger)" />
        <Stack.Screen name="(driver)" />
      </Stack>
    ),
    []
  );

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {fontsLoaded || fontError ? (
        <AuthProvider>{screens}</AuthProvider>
      ) : null}
    </SafeAreaProvider>
  );
}
