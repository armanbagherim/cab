import { Stack } from 'expo-router';
import { COLORS } from '../../utils/theme';

export default function DriverLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: COLORS.bg } }}>
      <Stack.Screen name="index" />
    </Stack>
  );
}