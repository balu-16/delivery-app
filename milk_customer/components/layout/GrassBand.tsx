import { memo, useCallback, useEffect, useState } from 'react';
import { AppState, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { cancelAnimation, Easing, useSharedValue, withRepeat, withTiming, type SharedValue } from 'react-native-reanimated';
import { useMotionEnabled } from '@/hooks/useMotionEnabled';
import { layout } from '@/constants/theme';
import GrassBlades from './GrassBlades';

export const GrassBand = memo(function GrassBand({ brushX, brushStrength }: { brushX: SharedValue<number>; brushStrength: SharedValue<number> }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const bottom = Math.max(insets.bottom, 10);
  const height = bottom + layout.grassHeightAboveBottomInset;
  const enabled = useMotionEnabled();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(AppState.currentState === 'active');
  const time = useSharedValue(0);
  useFocusEffect(useCallback(() => { setFocused(true); return () => setFocused(false); }, []));
  useEffect(() => { const sub = AppState.addEventListener('change', state => setActive(state === 'active')); return () => sub.remove(); }, []);
  useEffect(() => {
    if (enabled && focused && active) time.value = withRepeat(withTiming(1, { duration: 11000, easing: Easing.linear }), -1, false);
    else { cancelAnimation(time); time.value = 0; }
    return () => cancelAnimation(time);
  }, [active, enabled, focused, time]);
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.band, { height, bottom: -bottom }]}><GrassBlades width={width} height={height} time={time} brushX={brushX} brushStrength={brushStrength} /></View>;
});
const styles = StyleSheet.create({ band: { position: 'absolute', left: 0, right: 0, zIndex: 0, overflow: 'hidden' } });
