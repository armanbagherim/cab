import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { COLORS, FONTS, RADIUS, SPACING, SHADOW } from '../utils/theme';

export interface PopoverItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  onPress: () => void;
}

/**
 * Lightweight anchored popover menu (works on Web and iOS alike — it is a
 * plain Modal, so it is never clipped by map containers or screen edges).
 * The menu closes automatically after an option is selected.
 */
export default function PopoverMenu({
  visible,
  onClose,
  items,
  side = 'right',
  top,
}: {
  visible: boolean;
  onClose: () => void;
  items: PopoverItem[];
  /** Physical screen side the trigger button sits on. */
  side?: 'left' | 'right';
  /** Vertical position of the menu card (screen coordinates). */
  top: number;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {/* Backdrop swallows the next tap and closes the menu. */}
      <Pressable style={s.backdrop} onPress={onClose} accessibilityLabel="بستن منو" />
      <View style={s.layer} pointerEvents="box-none">
        <View style={[s.card, side === 'left' ? { left: SPACING.lg } : { right: SPACING.lg }, { top }]}>
          {items.map((item) => (
            <Pressable
              key={item.key}
              accessibilityRole="menuitem"
              accessibilityLabel={item.label}
              style={({ pressed }) => [s.row, pressed && s.rowPressed]}
              onPress={() => {
                // Close first so the menu is gone even if the action navigates.
                onClose();
                item.onPress();
              }}
            >
              {item.icon}
              <Text style={[s.label, item.danger && { color: COLORS.error }]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(10, 18, 15, 0.18)',
  },
  layer: {
    ...StyleSheet.absoluteFill,
  },
  card: {
    position: 'absolute',
    minWidth: 190,
    backgroundColor: COLORS.surface,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: COLORS.border,
    paddingVertical: SPACING.xs,
    ...SHADOW.lg,
  },
  row: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: SPACING.md,
    paddingVertical: 12,
    paddingHorizontal: SPACING.lg,
  },
  rowPressed: { backgroundColor: COLORS.bg },
  label: {
    flex: 1,
    fontFamily: FONTS.semibold,
    fontSize: 14,
    color: COLORS.text,
    textAlign: 'right',
  },
});
