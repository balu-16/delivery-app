import { Stack } from "expo-router";
import {
  useFonts,
  Poppins_400Regular,
  Poppins_500Medium,
  Poppins_600SemiBold,
  Poppins_700Bold,
} from "@expo-google-fonts/poppins";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import "react-native-reanimated";
import "../src/tracking";
export default function Layout() {
  const [loaded, error] = useFonts({
    Poppins_400Regular,
    Poppins_500Medium,
    Poppins_600SemiBold,
    Poppins_700Bold,
  });
  if (!loaded && !error) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right', gestureEnabled: true }}>
          <Stack.Screen name="offers/[offerId]" />
          <Stack.Screen name="tasks/[taskId]" />
          <Stack.Screen name="tasks/[taskId]/report" />
          <Stack.Screen name="history/[taskId]" />
          <Stack.Screen name="notifications" />
          <Stack.Screen name="support" />
          <Stack.Screen name="support/[ticketId]" />
        </Stack>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
