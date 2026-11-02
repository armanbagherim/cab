import React from 'react';
import { Pressable, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { ArrowLeftIcon } from './Icons';
import { COLORS, RADIUS, SHADOW } from '../utils/theme';

/**
 * Single shared back button for every screen.
 * - 40×40 hit area with an extra hitSlop, identical everywhere.
 * - The arrow always points LEFT (the app is Persian/RTL, so back = left),
 *   regardless of ambient layout direction.
 */
export default function BackButton({
  onPress,
  light = false,
  style,
}: {
  onPress: () => void;
  /** Light variant for dark/photo backgrounds (e.g. login hero). */
  light?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Pressable
      accessibilityLabel="بازگشت"
      accessibilityRole="button"
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [s.btn, light ? s.light : s.dark, pressed && { opacity: 0.7 }, style]}
    >
      <ArrowLeftIcon size={18} color={light ? '#fff' : COLORS.text} />
    </Pressable>
  );
}

const s = StyleSheet.create({
  btn: {
    width: 40, height: 40, borderRadius: RADIUS.sm,
    justifyContent: 'center', alignItems: 'center',
  },
  dark: {
    backgroundColor: COLORS.surface, borderWidth: 1, borderColor: COLORS.border,
    ...SHADOW.sm,
  },
  light: {
    backgroundColor: 'rgba(9, 20, 16, 0.5)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
  },
});
