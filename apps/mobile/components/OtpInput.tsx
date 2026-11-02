import React, { useRef, useState } from 'react';
import { I18nManager, Platform, StyleSheet, TextInput, View } from 'react-native';
import { COLORS, FONTS, RADIUS } from '../utils/theme';

/** Persian (۰-۹) and Arabic-Indic (٠-٩) digits → ASCII equivalents. */
function normalizeDigits(raw: string): string {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';
  return raw.replace(/[۰-۹٠-٩]/g, (ch) => {
    const i = fa.indexOf(ch);
    return i >= 0 ? String(i) : String(ar.indexOf(ch));
  });
}

const LENGTH = 6;

/**
 * Six-cell OTP input with one underlying value (a compact digit string).
 *
 * - Numeric only (Persian/Arabic digits are normalized).
 * - Typing advances focus; backspace on an empty cell clears the previous one.
 * - Pasting (or iOS `one-time-code` autofill, which delivers the whole code
 *   into the focused cell) distributes digits across the cells.
 * - Arrow keys move between cells; the visual order is always LTR so the
 *   first digit sits on the left even in RTL layout.
 */
export default function OtpInput({
  value,
  onChange,
  onComplete,
  error = false,
  autoFocus = true,
}: {
  value: string;
  onChange: (otp: string) => void;
  /** Fired once the sixth digit lands (paste, autofill or typing). */
  onComplete?: (otp: string) => void;
  error?: boolean;
  autoFocus?: boolean;
}) {
  const refs = useRef<Array<React.ComponentRef<typeof TextInput> | null>>([]);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const valueRef = useRef(value);
  valueRef.current = value;

  const focusCell = (i: number) => {
    const idx = Math.max(0, Math.min(LENGTH - 1, i));
    refs.current[idx]?.focus();
  };

  const commit = (next: string, fromIdx: number) => {
    const v = next.slice(0, LENGTH);
    onChange(v);
    if (v.length === LENGTH) {
      onComplete?.(v);
    } else {
      // Land on the first empty slot after the edited cell.
      focusCell(Math.max(fromIdx + 1, v.length));
    }
  };

  const handleChange = (i: number, raw: string) => {
    const d = normalizeDigits(raw).replace(/[^0-9]/g, '');
    const cur = valueRef.current;
    if (d.length === 0) {
      // Cell cleared: drop the digit stored at this slot.
      if (i < cur.length) onChange(cur.slice(0, i) + cur.slice(i + 1));
      return;
    }
    let next: string;
    if (d.length > 1) {
      // Paste / OTP autofill: distribute across the cells from this slot on.
      const chars = cur.split('');
      for (let k = 0; k < d.length && i + k < LENGTH; k++) chars[i + k] = d[k];
      next = chars.join('');
    } else {
      const chars = cur.split('');
      if (i >= chars.length) chars.push(d);
      else chars[i] = d;
      next = chars.join('');
    }
    commit(next, i);
  };

  const handleKeyPress = (i: number, key: string) => {
    const cur = valueRef.current;
    if (key === 'Backspace') {
      // Only for an empty cell — a filled cell is cleared by onChangeText.
      if (!cur[i] && i > 0) {
        onChange(cur.slice(0, i - 1) + cur.slice(i));
        focusCell(i - 1);
      }
    } else if (key === 'ArrowLeft') {
      focusCell(i - 1);
    } else if (key === 'ArrowRight') {
      focusCell(i + 1);
    }
  };

  const cells = Array.from({ length: LENGTH }, (_, i) => value[i] ?? '');
  const focused = focusedIdx >= 0;

  return (
    <View style={[s.row, error && s.rowError]} accessibilityLabel="کد تأیید ۶ رقمی">
      {cells.map((digit, i) => (
        <TextInput
          key={i}
          ref={(r) => { refs.current[i] = r; }}
          style={[s.cell, focusedIdx === i && !error && s.cellFocused, error && s.cellError]}
          value={digit}
          onChangeText={(t) => handleChange(i, t)}
          onKeyPress={(e) => handleKeyPress(i, e.nativeEvent.key)}
          onFocus={() => setFocusedIdx(i)}
          onBlur={() => setFocusedIdx(-1)}
          keyboardType="number-pad"
          inputMode="numeric"
          // iOS OTP autofill delivers the full code into the focused cell;
          // on web expose the standard one-time-code autocomplete token.
          textContentType="oneTimeCode"
          autoComplete={Platform.OS === 'web' ? ('one-time-code' as any) : ('sms-otp' as any)}
          textAlign="center"
          autoFocus={autoFocus && i === 0}
          selectTextOnFocus
          contextMenuHidden={false}
          maxLength={LENGTH}
        />
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    // Cells must read left→right even under RTL layout direction.
    flexDirection: I18nManager.isRTL ? 'row-reverse' : 'row',
    justifyContent: 'center',
    gap: 10,
    marginTop: 20,
  },
  rowError: { gap: 10 },
  cell: {
    width: 46, height: 58, borderRadius: RADIUS.lg,
    backgroundColor: COLORS.surface, borderWidth: 1.2, borderColor: COLORS.border,
    fontSize: 24, fontFamily: FONTS.bold, color: COLORS.text,
    textAlign: 'center', paddingVertical: 0,
    writingDirection: 'ltr' as any,
  },
  cellFocused: { borderColor: COLORS.text, borderWidth: 1.8 },
  cellError: { borderColor: COLORS.error },
});
