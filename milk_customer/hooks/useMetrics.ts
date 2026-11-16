import { useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { layout } from '@/constants/theme';

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Responsive metrics for the 390pt reference canvas.
 * Horizontal sizes scale with the device, vertical rhythm stays predictable.
 */
export function useMetrics() {
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  return useMemo(() => {
    const contentWidth = Math.min(width, layout.maxContentWidth);
    const s = clamp(width / 390, 0.86, 1.14);
    const h = clamp(height, 480, 1200);

    return {
      width,
      height,
      fontScale,
      s,
      px: (value: number) => Math.round(value * s * 100) / 100,
      contentWidth,
      gutter: Math.max((width - contentWidth) / 2, 0),
      insets,
      isCompact: height < 740,
      isTall: height > 880,
      tabBarHeight: Math.round(layout.tabBarHeight * s),
      tabBarMargin: Math.max(10, Math.round(layout.tabBarMargin * s)),
      bottomClearance:
        Math.round(layout.tabBarHeight * s) + Math.max(insets.bottom, 10) + 26,
      headerTop: insets.top + 8,
      contentMax: layout.maxContentWidth,
      screenH: h,
    };
  }, [width, height, fontScale, insets]);
}
