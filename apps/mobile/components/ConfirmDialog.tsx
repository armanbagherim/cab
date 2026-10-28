import React from 'react';
import {
  View, Text, StyleSheet, Pressable, Modal,
} from 'react-native';
import { COLORS, FONTS, SPACING, RADIUS, SHADOW } from '../utils/theme';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Unified in-app modal for confirmations and errors.
 * Replaces native `Alert.alert` so behavior is identical on web and native.
 */
export default function ConfirmDialog({
  visible,
  title,
  description,
  confirmText = 'تأیید',
  cancelText = 'انصراف',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onCancel}>
      <View style={s.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} />
        <View style={s.card}>
          <Text style={s.title}>{title}</Text>
          {description ? <Text style={s.desc}>{description}</Text> : null}
          <View style={s.actions}>
            <Pressable style={({ pressed }) => [s.btn, s.btnGhost, pressed && { opacity: 0.7 }]} onPress={onCancel}>
              <Text style={[s.btnText, { color: COLORS.textSecondary }]}>{cancelText}</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [s.btn, danger ? s.btnDanger : s.btnPrimary, pressed && { opacity: 0.85 }]}
              onPress={onConfirm}
            >
              <Text style={[s.btnText, { color: '#fff' }]}>{confirmText}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(10, 18, 15, 0.55)',
    justifyContent: 'flex-end',
  },
  card: {
    width: '100%',
    backgroundColor: COLORS.surface,
    borderTopLeftRadius: RADIUS.xl,
    borderTopRightRadius: RADIUS.xl,
    padding: SPACING.lg,
    paddingBottom: SPACING.xxxl,
    ...SHADOW.lg,
  },
  title: {
    fontFamily: FONTS.bold,
    fontSize: 16,
    color: COLORS.text,
    textAlign: 'right',
    marginBottom: SPACING.sm,
  },
  desc: {
    fontFamily: FONTS.regular,
    fontSize: 14,
    color: COLORS.textSecondary,
    textAlign: 'right',
    lineHeight: 22,
    marginBottom: SPACING.md,
  },
  actions: {
    flexDirection: 'row-reverse',
    gap: SPACING.sm,
    marginTop: SPACING.sm,
  },
  btn: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPrimary: { backgroundColor: COLORS.brand },
  btnDanger: { backgroundColor: COLORS.error },
  btnGhost: { backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.border },
  btnText: { fontFamily: FONTS.semibold, fontSize: 14 },
});
