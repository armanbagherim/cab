import { useEffect, useMemo } from 'react';
import { I18nManager } from 'react-native';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from '../context/AuthContext';
import { COLORS, FONTS } from '../utils/theme';

// The app is fully hand-RTL; allow RTL so native navigation transitions mirror.
I18nManager.allowRTL(true);

const FONT_ASSETS = {
  [FONTS.regular]: require('../assets/fonts/Vazirmatn-Regular.ttf'),
  [FONTS.medium]: require('../assets/fonts/Vazirmatn-Medium.ttf'),
  [FONTS.semibold]: require('../assets/fonts/Vazirmatn-SemiBold.ttf'),
  [FONTS.bold]: require('../assets/fonts/Vazirmatn-Bold.ttf'),
};

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(FONT_ASSETS);

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
        <Stack.Screen name="login" />
        <Stack.Screen name="verify-otp" />
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
