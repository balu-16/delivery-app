import { forwardRef, type ReactNode } from 'react';
import {
  Pressable,
  type PressableInstance,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { useMotionEnabled } from '@/hooks/useMotionEnabled';
import { selectionFeedback, tapFeedback } from '@/utils/haptics';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type PressableScaleProps = Omit<PressableProps, 'style' | 'children'> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  pressedScale?: number;
  haptic?: 'tap' | 'select' | 'none';
};

/**
 * Every tappable surface in the app uses this spring press-in feedback.
 * It degrades to a plain Pressable when Reduce Motion is on.
 */
export const PressableScale = forwardRef<PressableInstance, PressableScaleProps>(function PressableScale(
  {
    children,
    style,
    pressedScale = 0.96,
    haptic = 'tap',
    onPress,
    onPressIn,
    onPressOut,
    disabled,
    ...rest
  },
  ref,
) {
  const enabled = useMotionEnabled();
  const scale = useSharedValue(1);
  const opacity = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return (
    <AnimatedPressable
      {...rest}
      ref={ref}
      disabled={disabled}
      onPressIn={(event) => {
        if (enabled) {
          scale.value = withTiming(pressedScale, { duration: 110 });
          opacity.value = withTiming(0.94, { duration: 110 });
        }
        onPressIn?.(event);
      }}
      onPressOut={(event) => {
        if (enabled) {
          scale.value = withSpring(1, { damping: 14, stiffness: 260, mass: 0.5 });
          opacity.value = withTiming(1, { duration: 140 });
        }
        onPressOut?.(event);
      }}
      onPress={(event) => {
        if (haptic === 'tap') tapFeedback();
        if (haptic === 'select') selectionFeedback();
        onPress?.(event);
      }}
      style={[style, animatedStyle]}
    >
      {children}
    </AnimatedPressable>
  );
});
