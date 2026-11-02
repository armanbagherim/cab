import React from 'react';
import { Linking, Pressable, StyleSheet, Text } from 'react-native';
import { PhoneIcon } from './Icons';
import { COLORS, FONTS, RADIUS } from '../utils/theme';

/**
 * Opens the native phone dialer (`tel:` URL) for the given number.
 * Renders nothing when no phone number exists — the button hides gracefully
 * instead of showing a dead action.
 */
export default function CallButton({
  phone,
  label,
  variant = 'pill',
}: {
  phone?: string | null;
  label?: string;
  variant?: 'pill' | 'circle';
}) {
  if (!phone) return null;

  const openDialer = () => {
    Linking.openURL(`tel:${phone}`).catch((e) => {
      console.warn('[CallButton] open dialer failed', e?.message || e);
    });
  };

  if (variant === 'circle') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="تماس تلفنی"
        onPress={openDialer}
        hitSlop={6}
        style={({ pressed }) => [s.circle, pressed && { opacity: 0.85 }]}
      >
        <PhoneIcon size={18} color={COLORS.brand} />
      </Pressable>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="تماس تلفنی"
      onPress={openDialer}
      style={({ pressed }) => [s.pill, pressed && { opacity: 0.88 }]}
    >
      <PhoneIcon size={16} color={COLORS.brand} />
      <Text style={s.pillText}>{label || 'تماس'}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  circle: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: COLORS.surface, borderWidth: 1.5, borderColor: COLORS.brand,
    justifyContent: 'center', alignItems: 'center',
  },
  pill: {
    flex: 1, flexDirection: 'row-reverse', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1.5, borderColor: COLORS.brand, borderRadius: RADIUS.lg,
    paddingVertical: 11, backgroundColor: 'rgba(10,10,10,0.04)',
  },
  pillText: { fontFamily: FONTS.semibold, fontSize: 13, color: COLORS.brand },
});
