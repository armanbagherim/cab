import { Stack } from 'expo-router';
import { COLORS } from '../../utils/theme';

export default function PassengerLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: COLORS.bg } }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="active-trip" />
      <Stack.Screen name="trip-history" />
    </Stack>
  );
}