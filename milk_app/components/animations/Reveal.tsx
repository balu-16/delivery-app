import { useEffect, type ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { useMotionEnabled } from '@/hooks/useMotionEnabled';

type RevealProps = {
  children: ReactNode;
  delay?: number;
  direction?: 'up' | 'down' | 'fade';
  duration?: number;
  style?: StyleProp<ViewStyle>;
};

/**
 * Entrance fade/slide that keeps the view in normal layout flow.
 * Reanimated's web `entering` animations lay items out absolutely, which
 * collapses grids and scroll content, so we animate opacity/transform instead.
 */
export function Reveal({
  children,
  delay = 0,
  direction = 'up',
  duration = 480,
  style,
}: RevealProps) {
  const enabled = useMotionEnabled();
  const progress = useSharedValue(enabled ? 0 : 1);

  useEffect(() => {
    if (!enabled) {
      progress.set(1);
      return;
    }
    progress.set(
      withDelay(delay, withTiming(1, { duration, easing: Easing.out(Easing.cubic) })),
    );
  }, [delay, duration, enabled, progress]);

  const animatedStyle = useAnimatedStyle(() => {
    const distance = direction === 'fade' ? 0 : 14 * (1 - progress.value);
    const translateY = direction === 'down' ? -distance : distance;

    return {
      opacity: progress.value,
      transform: [{ translateY }],
    };
  });

  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
}
