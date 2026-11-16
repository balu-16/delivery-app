import { TopTabs as Tabs } from 'expo-router/js-top-tabs';
import { StyleSheet, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSharedValue, withTiming } from 'react-native-reanimated';

import { TabBar } from '@/components/navigation/TabBar';
import { AuthGate } from '@/components/connected/AuthGate';
import { colors, layout } from '@/constants/theme';
import { useMotionEnabled } from '@/hooks/useMotionEnabled';

export default function TabsLayout() {
  const motionEnabled = useMotionEnabled();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const brushX = useSharedValue(-1000);
  const brushStrength = useSharedValue(0);
  const brush = (event: GestureResponderEvent) => {
    const { pageX, pageY } = event.nativeEvent;
    const grassHeight = Math.max(insets.bottom, 10) + layout.grassHeightAboveBottomInset;
    if (motionEnabled && pageY >= height - grassHeight) { brushX.value = pageX; brushStrength.value = 1; }
  };
  return (
    <AuthGate><View style={{ flex: 1 }} onStartShouldSetResponderCapture={(event) => { brush(event); return false; }} onMoveShouldSetResponderCapture={(event) => { brush(event); return false; }} onTouchEnd={() => { brushStrength.value = withTiming(0, { duration: 700 }); }}>
    <Tabs
      tabBarPosition="bottom"
      backBehavior="none"
      tabBar={(props) => <TabBar {...props} brushX={brushX} brushStrength={brushStrength} />}
      screenOptions={{
        sceneStyle: styles.scene,
        lazy: false,
        swipeEnabled: true,
        animationEnabled: motionEnabled,
      }}
    >
      <Tabs.Screen name="home" options={{ title: 'Home' }} />
      <Tabs.Screen name="products" options={{ title: 'Products' }} />
      <Tabs.Screen name="my-dairy" options={{ title: 'My Dairy' }} />
      <Tabs.Screen name="cart" options={{ title: 'Cart' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
    </View></AuthGate>
  );
}

const styles = StyleSheet.create({
  scene: {
    backgroundColor: colors.background,
  },
});
