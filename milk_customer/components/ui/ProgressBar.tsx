import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors } from '@/constants/theme';
import { useMotionEnabled } from '@/hooks/useMotionEnabled';

export function ProgressBar({
  progress,
  animate = true,
  height = 7,
  fillColors = [colors.greenMid, colors.green],
  trackColor = colors.line,
  style,
}: {
  progress: number;
  animate?: boolean;
  height?: number;
  fillColors?: readonly [string, string, ...string[]];
  trackColor?: string;
  style?: object;
}) {
  const enabled = useMotionEnabled();
  const width = useSharedValue(0);

  useEffect(() => {
    const clamped = Math.max(0, Math.min(1, progress));
    width.value = enabled && animate ? withTiming(clamped, { duration: 650 }) : clamped;
  }, [animate, enabled, progress, width]);

  const animatedStyle = useAnimatedStyle(() => ({ width: `${width.value * 100}%` }));

  return (
    <View style={[styles.track, { height, borderRadius: height / 2, backgroundColor: trackColor }, style]}>
      <Animated.View style={[styles.fill, { borderRadius: height / 2 }, animatedStyle]}>
        <LinearGradient
          colors={fillColors}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    overflow: 'hidden',
    width: '100%',
  },
  fill: {
    height: '100%',
    overflow: 'hidden',
  },
});
