import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import NeshanMap, { NeshanMapRef, MapMarker, MapLine } from './map/NeshanMap';
import { COLORS, FONTS, RADIUS } from '../utils/theme';

export type { NeshanMapRef, MapMarker, MapLine };

interface CabMapProps {
  style?: any;
  markers?: MapMarker[];
  polyline?: MapLine | null;
  onPress?: (lat: number, lng: number) => void;
  onMapMove?: () => void;
  onMapSettle?: (lat: number, lng: number) => void;
  onReady?: () => void;
  showCenterPin?: boolean;
  pinColor?: string;
  /** Persian label shown above the fixed center pointer (e.g. «مبدأ» / «مقصد»). */
  centerPinLabel?: string;
  /** Static initial camera — applied only once at map load. */
  initialRegion?: { latitude: number; longitude: number; zoom?: number };
  mapRef?: React.RefObject<NeshanMapRef | null>;
}

export function CabMap({
  style,
  markers,
  polyline,
  onPress,
  onMapMove,
  onMapSettle,
  onReady,
  showCenterPin,
  pinColor,
  centerPinLabel,
  initialRegion,
  mapRef,
}: CabMapProps) {
  return (
    <View style={[styles.container, style]}>
      <NeshanMap
        ref={mapRef as any}
        markers={markers}
        polyline={polyline}
        onPress={onPress}
        onMapMove={onMapMove}
        onMapSettle={onMapSettle}
        onReady={onReady}
        showCenterPin={showCenterPin}
        pinColor={pinColor}
        initialRegion={initialRegion}
      />
      {showCenterPin && centerPinLabel ? (
        <View pointerEvents="none" style={styles.pinLabelWrap}>
          <View style={styles.pinLabelBubble}>
            <Text style={styles.pinLabelText}>{centerPinLabel}</Text>
          </View>
          <View style={styles.pinLabelTail} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
  pinLabelWrap: {
    position: 'absolute', left: 0, right: 0,
    top: '50%', marginTop: -56,
    alignItems: 'center', zIndex: 110,
  },
  pinLabelBubble: {
    backgroundColor: '#0F172A', borderRadius: RADIUS.full,
    paddingVertical: 6, paddingHorizontal: 16,
    shadowColor: '#0F172A',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  pinLabelText: { fontFamily: FONTS.bold, fontSize: 13, color: '#FFFFFF', letterSpacing: -0.2 },
  pinLabelTail: {
    width: 0, height: 0, marginTop: -1,
    borderLeftWidth: 6, borderRightWidth: 6, borderTopWidth: 6,
    borderLeftColor: 'transparent', borderRightColor: 'transparent',
    borderTopColor: '#0F172A',
  },
});
