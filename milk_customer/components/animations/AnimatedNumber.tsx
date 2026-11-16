import { useEffect, useRef, useState } from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';

import { useMotionEnabled } from '@/hooks/useMotionEnabled';
import { formatCurrency } from '@/utils/format';

type AnimatedNumberProps = {
  value: number;
  style?: StyleProp<TextStyle>;
  duration?: number;
  currency?: boolean;
  animate?: boolean;
  prefix?: string;
  suffix?: string;
};

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** Counts up (or down) whenever the underlying total changes. */
export function AnimatedNumber({
  value,
  style,
  duration = 650,
  currency = false,
  animate = true,
  prefix = '',
  suffix = '',
}: AnimatedNumberProps) {
  const enabled = useMotionEnabled();
  const [display, setDisplay] = useState(value);
  const previous = useRef(value);
  const frame = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const from = previous.current;
    const to = value;
    previous.current = value;

    if (!enabled || !animate || from === to) {
      setDisplay(to);
      return;
    }

    const started = Date.now();
    if (frame.current) clearInterval(frame.current);
    frame.current = setInterval(() => {
      const progress = Math.min(1, (Date.now() - started) / duration);
      setDisplay(from + (to - from) * easeOutCubic(progress));
      if (progress >= 1 && frame.current) {
        clearInterval(frame.current);
        frame.current = null;
      }
    }, 16);

    return () => {
      if (frame.current) {
        clearInterval(frame.current);
        frame.current = null;
      }
    };
  }, [animate, duration, enabled, value]);

  const text = currency
    ? formatCurrency(display)
    : Math.round(display).toLocaleString('en-IN');

  return (
    <Text style={style} allowFontScaling={false}>
      {prefix}
      {text}
      {suffix}
    </Text>
  );
}
