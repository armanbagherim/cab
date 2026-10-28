import React from 'react';
import { MaterialCommunityIcons, MaterialIcons } from '@expo/vector-icons';
import { COLORS } from '../utils/theme';

type Props = { size?: number; color?: string; style?: any };

export const SearchIcon = ({ size = 20, color = COLORS.textTertiary, style }: Props) => (
  <MaterialCommunityIcons name="magnify" size={size} color={color} style={style} />
);

export const LogoutIcon = ({ size = 20, color = COLORS.error, style }: Props) => (
  <MaterialCommunityIcons name="logout" size={size} color={color} style={style} />
);

export const ArrowRightIcon = ({ size = 22, color = COLORS.text, style }: Props) => (
  <MaterialIcons name="arrow-forward-ios" size={size} color={color} style={style} />
);

export const ArrowLeftIcon = ({ size = 22, color = COLORS.text, style }: Props) => (
  <MaterialIcons name="arrow-back-ios" size={size} color={color} style={style} />
);

export const CloseIcon = ({ size = 20, color = COLORS.textTertiary, style }: Props) => (
  <MaterialCommunityIcons name="close" size={size} color={color} style={style} />
);

export const CarIcon = ({ size = 24, color = COLORS.brand, style }: Props) => (
  <MaterialCommunityIcons name="car-hatchback" size={size} color={color} style={style} />
);

export const LocateIcon = ({ size = 22, color = COLORS.brand, style }: Props) => (
  <MaterialCommunityIcons name="crosshairs-gps" size={size} color={color} style={style} />
);

export const LocateOffIcon = ({ size = 22, color = COLORS.textTertiary, style }: Props) => (
  <MaterialCommunityIcons name="crosshairs-off" size={size} color={color} style={style} />
);

export const ClockIcon = ({ size = 16, color = COLORS.textSecondary, style }: Props) => (
  <MaterialCommunityIcons name="clock-outline" size={size} color={color} style={style} />
);

export const RoadIcon = ({ size = 16, color = COLORS.textSecondary, style }: Props) => (
  <MaterialCommunityIcons name="road-variant" size={size} color={color} style={style} />
);

export const PersonIcon = ({ size = 40, color = COLORS.textTertiary, style }: Props) => (
  <MaterialCommunityIcons name="account-circle" size={size} color={color} style={style} />
);

export const PhoneIcon = ({ size = 18, color = COLORS.brand, style }: Props) => (
  <MaterialCommunityIcons name="phone" size={size} color={color} style={style} />
);

export const CheckIcon = ({ size = 20, color = '#FFFFFF', style }: Props) => (
  <MaterialCommunityIcons name="check" size={size} color={color} style={style} />
);

export const CashIcon = ({ size = 18, color = COLORS.brand, style }: Props) => (
  <MaterialCommunityIcons name="cash" size={size} color={color} style={style} />
);

export const HistoryIcon = ({ size = 24, color = COLORS.textTertiary, style }: Props) => (
  <MaterialCommunityIcons name="history" size={size} color={color} style={style} />
);

export const AlertIcon = ({ size = 24, color = COLORS.error, style }: Props) => (
  <MaterialCommunityIcons name="alert-circle" size={size} color={color} style={style} />
);

/** Small filled route dot / ring used in itinerary rows */
export function RouteDot({ color, size = 10, ring = false }: { color: string; size?: number; ring?: boolean }) {
  if (ring) {
    return (
      <MaterialCommunityIcons name="checkbox-blank-circle-outline" size={size + 2} color={color} />
    );
  }
  return <MaterialCommunityIcons name="circle" size={size} color={color} />;
}
