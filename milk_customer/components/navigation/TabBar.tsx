import { Ionicons } from '@expo/vector-icons';
import type { MaterialTopTabBarProps } from 'expo-router/js-top-tabs';
import { Image } from 'expo-image';
import { useEffect, useRef, type ComponentProps } from 'react';
import { Animated as NativeAnimated, StyleSheet, useWindowDimensions, type PressableInstance, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { GrassBand } from '@/components/layout/GrassBand';
import type { SharedValue } from 'react-native-reanimated';
import { PressableScale } from '@/components/animations/PressableScale';
import { AppText } from '@/components/ui/AppText';
import { images } from '@/constants/assets';
import { colors, fonts, shadows } from '@/constants/theme';
import { useMotionEnabled } from '@/hooks/useMotionEnabled';
import { useCustomer } from '@/src/store/customer';
import { useCartTargetStore } from '@/store/cartTargetStore';
import { selectionFeedback } from '@/utils/haptics';
import { measureInWindow } from '@/utils/layout';

type TabKey = 'home' | 'products' | 'my-dairy' | 'cart' | 'profile';

const tabConfig: Record<
  TabKey,
  { label: string; icon: ComponentProps<typeof Ionicons>['name']; activeIcon: ComponentProps<typeof Ionicons>['name'] }
> = {
  home: { label: 'Home', icon: 'home-outline', activeIcon: 'home' },
  products: { label: 'Products', icon: 'grid-outline', activeIcon: 'grid' },
  'my-dairy': { label: 'My Dairy', icon: 'grid-outline', activeIcon: 'grid' },
  cart: { label: 'Cart', icon: 'cart-outline', activeIcon: 'cart' },
  profile: { label: 'Profile', icon: 'person-outline', activeIcon: 'person' },
};

export function TabBar({ state, position, navigateToTab, brushX, brushStrength }: MaterialTopTabBarProps & { brushX: SharedValue<number>; brushStrength: SharedValue<number> }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const enabled = useMotionEnabled();
  const barWidth = Math.min(width - 28, 460);
  const itemWidth = (barWidth - 12) / 5;
  const mascotY = useSharedValue(0);
  const cartRef = useRef<PressableInstance>(null);
  const setTarget = useCartTargetStore((store) => store.setTarget);
  const count = useCustomer((store) =>
    store.cart?.lines.reduce((total, line) => total + Number(line.quantity), 0) ?? 0,
  );
  const activeIndex = state.index;

  const updateTarget = () => {
    measureInWindow(cartRef).then((box) => { if (box) setTarget(box); });
  };
  useEffect(() => {
    const timer = setTimeout(updateTarget, 200);
    return () => clearTimeout(timer);
    // Re-measure after a window or safe-area change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTarget, width, height, insets.bottom]);

  const pillStyle = {
    transform: [{ translateX: position.interpolate({
      inputRange: [0, 1, 2, 3, 4],
      outputRange: [0, 1, 2, 3, 4].map((i) => 6 + itemWidth * i + itemWidth / 2 - 30),
      extrapolate: 'clamp',
    }) }],
    opacity: position.interpolate({ inputRange: [0, 1, 2, 3, 4], outputRange: [1, 1, 0, 1, 1], extrapolate: 'clamp' }),
  };

  const mascotStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: mascotY.value }],
  }));

  const hop = () => {
    if (!enabled) return;
    mascotY.set(
      withSequence(
        withTiming(-9, { duration: 120 }),
        withSpring(0, { damping: 7, stiffness: 180 }),
      ),
    );
  };

  return (
    <View
      pointerEvents="box-none"
      style={[styles.outer, { bottom: Math.max(insets.bottom, 10) }]}
    >
      <GrassBand brushX={brushX} brushStrength={brushStrength} />
      <View style={[styles.bar, { width: barWidth }]}>
        <LinearGradient
          colors={['#FFFCF6', '#FAF0E0']}
          start={{ x: 0.2, y: 0 }}
          end={{ x: 0.8, y: 1 }}
          style={[StyleSheet.absoluteFill, styles.barSurface]}
        />
        <NativeAnimated.View
          pointerEvents="none"
          style={[styles.pill, { width: 60, left: 0 }, pillStyle]}
        />
        {state.routes.map((route, index) => {
          const key = route.name as TabKey;
          const config = tabConfig[key] ?? tabConfig.home;
          const isActive = index === activeIndex;
          const isCenter = key === 'my-dairy';
          const emphasis = position.interpolate({ inputRange: [index - 1, index, index + 1], outputRange: [0, 1, 0], extrapolate: 'clamp' });

          const onPress = () => {
            selectionFeedback();
            if (isCenter) hop();
            if (!isActive) navigateToTab(route.key);
          };

          if (isCenter) {
            return (
              <PressableScale
                key={route.key}
                onPress={onPress}
                haptic="none"
                style={styles.tab}
                accessibilityLabel="My Dairy"
                accessibilityRole="tab"
                accessibilityState={{ selected: isActive }}
              >
                <Animated.View
                  style={[
                    styles.mascotBubble,
                    isActive ? styles.mascotBubbleActive : null,
                    mascotStyle,
                  ]}
                >
                  <Image source={images.navCow} style={styles.mascot} contentFit="contain" />
                </Animated.View>
                <View>
                  <AppText style={[styles.centerLabel, { color: colors.textSecondary }]}>{config.label}</AppText>
                  <NativeAnimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: emphasis }]}>
                    <AppText style={[styles.centerLabel, { color: colors.green }]}>{config.label}</AppText>
                  </NativeAnimated.View>
                </View>
              </PressableScale>
            );
          }

          return (
            <PressableScale
              key={route.key}
              onPress={onPress}
              haptic="none"
              style={styles.tab}
              accessibilityLabel={config.label}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
            >
              <View
                ref={key === 'cart' ? cartRef : undefined}
                collapsable={false}
                style={styles.iconWrap}
                onLayout={key === 'cart' ? updateTarget : undefined}
              >
                <Ionicons name={config.icon} size={22} color={colors.textSecondary} />
                <NativeAnimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: emphasis, alignItems: 'center', justifyContent: 'center' }]}>
                  <Ionicons name={config.activeIcon} size={22} color={colors.green} />
                </NativeAnimated.View>
                {key === 'cart' && count > 0 ? <CartBadge count={count} /> : null}
              </View>
              <View>
                <AppText style={[styles.label, { color: colors.textSecondary }]}>{config.label}</AppText>
                <NativeAnimated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: emphasis }]}>
                  <AppText style={[styles.label, styles.labelActive, { color: colors.green }]}>{config.label}</AppText>
                </NativeAnimated.View>
              </View>
            </PressableScale>
          );
        })}
      </View>
    </View>
  );
}

function CartBadge({ count }: { count: number }) {
  const enabled = useMotionEnabled();
  const scale = useSharedValue(1);
  const previous = useRef(count);

  useEffect(() => {
    if (previous.current === count) return;
    previous.current = count;
    if (!enabled) return;
    scale.value = withSequence(
      withTiming(1.35, { duration: 120 }),
      withSpring(1, { damping: 8, stiffness: 220 }),
    );
  }, [count, enabled, scale]);

  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={[styles.cartBadge, style]}>
      <AppText style={styles.cartBadgeText}>{count > 9 ? '9+' : count}</AppText>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 20,
  },
  bar: {
    zIndex: 1,
    height: 66,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 6,
    paddingBottom: 2,
    ...shadows.tab,
    overflow: 'visible',
  },
  barSurface: { borderRadius: 24, overflow: 'hidden' },
  pill: {
    position: 'absolute',
    bottom: 6,
    height: 54,
    borderRadius: 27,
    backgroundColor: colors.tabIndicator,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.72)',
  },
  tab: {
    flex: 1,
    height: 64,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 7,
    zIndex: 2,
  },
  iconWrap: {
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 1,
  },
  label: {
    fontFamily: fonts.medium,
    fontSize: 9.5,
    lineHeight: 13,
    letterSpacing: 0.05,
  },
  labelActive: {
    fontFamily: fonts.semibold,
  },
  mascotBubble: {
    position: 'absolute',
    top: -33,
    width: 66,
    height: 66,
    borderRadius: 33,
    backgroundColor: colors.surfaceStrong,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#FFF8EC',
    ...shadows.float,
  },
  mascotBubbleActive: {
    borderColor: colors.greenSoft,
    backgroundColor: '#FFFCF4',
  },
  mascot: {
    width: 50,
    height: 66,
    marginTop: -2,
  },
  centerLabel: {
    fontFamily: fonts.semibold,
    fontSize: 9.5,
    lineHeight: 13,
  },
  cartBadge: {
    position: 'absolute',
    top: -5,
    right: -9,
    minWidth: 17,
    height: 17,
    borderRadius: 9,
    backgroundColor: colors.green,
    borderWidth: 1.5,
    borderColor: 'rgba(255,252,246,0.95)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  cartBadgeText: {
    fontFamily: fonts.bold,
    fontSize: 8,
    lineHeight: 10,
    color: colors.inverse,
  },
});
