import { useEffect } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, cancelAnimation, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { colors } from '../theme';

export function SkeletonBlock({ width = '100%', height, radius = 10, style }: {
  width?: number | `${number}%`; height: number; radius?: number; style?: StyleProp<ViewStyle>;
}) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(0.55);
  useEffect(() => {
    if (reduced) { opacity.value = 0.72; return; }
    opacity.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true);
    return () => cancelAnimation(opacity);
  }, [opacity, reduced]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View accessible={false} importantForAccessibility="no" style={[{ width, height, borderRadius: radius, backgroundColor: colors.lineStrong }, style, animated]} />;
}

export function CardListSkeleton({ label = 'Loading content', count = 2 }: { label?: string; count?: number }) {
  return <View style={styles.list} accessible accessibilityLabel={label} accessibilityState={{ busy: true }}>
    {Array.from({ length: count }, (_, index) => <View key={index} style={styles.card}>
      <View style={styles.row}><SkeletonBlock width={42} height={42} radius={14} /><View style={styles.text}>
        <SkeletonBlock width="65%" height={13} /><SkeletonBlock width="88%" height={10} style={{ marginTop: 9 }} />
      </View></View>
      <SkeletonBlock width="42%" height={10} style={{ marginTop: 13 }} />
    </View>)}
  </View>;
}

export function FormSkeleton({ label = 'Loading details' }: { label?: string }) {
  return <View style={styles.form} accessible accessibilityLabel={label} accessibilityState={{ busy: true }}>
    <SkeletonBlock width="48%" height={13} /><SkeletonBlock height={48} radius={14} />
    <SkeletonBlock width="38%" height={13} /><SkeletonBlock height={48} radius={14} />
    <SkeletonBlock height={45} radius={14} />
  </View>;
}

const styles = StyleSheet.create({
  list: { gap: 10 }, card: { backgroundColor: colors.surface, borderRadius: 18, padding: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, text: { flex: 1 }, form: { width: '100%', gap: 10 },
});
