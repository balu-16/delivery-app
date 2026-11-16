import { useEffect } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { colors, radii } from '@/constants/theme';
import { useMotionEnabled } from '@/hooks/useMotionEnabled';

export function SkeletonBlock({
  width,
  height,
  style,
  radius = radii.md,
}: {
  width: number | `${number}%`;
  height: number;
  style?: StyleProp<ViewStyle>;
  radius?: number;
}) {
  const enabled = useMotionEnabled();
  const pulse = useSharedValue(0.5);

  useEffect(() => {
    if (!enabled) {
      pulse.value = 0.72;
      return;
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }),
      -1,
      true,
    );
    return () => cancelAnimation(pulse);
  }, [enabled, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View
      accessible={false}
      importantForAccessibility="no"
      style={[
        styles.block,
        { width, height, borderRadius: radius, backgroundColor: colors.line },
        style,
        animatedStyle,
      ]}
    />
  );
}

export function ProductGridSkeleton() {
  return (
    <View style={styles.grid} accessible accessibilityLabel="Loading products" accessibilityState={{ busy: true }}>
      {[0, 1, 2, 3].map((index) => (
        <View key={index} style={styles.card}>
          <SkeletonBlock width="100%" height={112} radius={18} />
          <SkeletonBlock width="65%" height={13} style={{ marginTop: 12 }} />
          <SkeletonBlock width="38%" height={10} style={{ marginTop: 8 }} />
          <View style={styles.row}>
            <SkeletonBlock width={48} height={10} />
            <SkeletonBlock width={54} height={16} radius={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** Compact placeholders for order, notification, and account cards. */
export function CardListSkeleton({ label = 'Loading content', count = 3 }: { label?: string; count?: number }) {
  return <View style={styles.list} accessible accessibilityLabel={label} accessibilityState={{ busy: true }}>
    {Array.from({ length: count }, (_, index) => <View key={index} style={styles.listCard}>
      <View style={styles.listRow}><SkeletonBlock width={42} height={42} radius={14} /><View style={styles.listText}>
        <SkeletonBlock width="65%" height={13} /><SkeletonBlock width="88%" height={10} style={{ marginTop: 9 }} />
      </View></View>
      <SkeletonBlock width="40%" height={10} style={{ marginTop: 13 }} />
    </View>)}
  </View>;
}

export function FormSkeleton({ label = 'Loading details' }: { label?: string }) {
  return <View style={styles.form} accessible accessibilityLabel={label} accessibilityState={{ busy: true }}>
    <SkeletonBlock width="48%" height={13} /><SkeletonBlock width="100%" height={48} radius={14} />
    <SkeletonBlock width="38%" height={13} /><SkeletonBlock width="100%" height={48} radius={14} />
    <SkeletonBlock width="100%" height={45} radius={14} />
  </View>;
}

const styles = StyleSheet.create({
  block: {},
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  card: {
    width: '47.8%',
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: 12,
  },
  row: {
    marginTop: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  list: { gap: 10 },
  listCard: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 14 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  listText: { flex: 1 },
  form: { gap: 10 },
});
