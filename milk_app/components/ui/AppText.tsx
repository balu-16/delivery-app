import type { ReactNode } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Text } from 'react-native';

import { colors, typography } from '@/constants/theme';

type Variant = keyof typeof typography;

type AppTextProps = {
  children: ReactNode;
  variant?: Variant;
  color?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  center?: boolean;
  allowFontScaling?: boolean;
  selectable?: boolean;
};

export function AppText({
  children,
  variant = 'body',
  color,
  style,
  numberOfLines,
  center,
  allowFontScaling = false,
  selectable,
}: AppTextProps) {
  return (
    <Text
      numberOfLines={numberOfLines}
      allowFontScaling={allowFontScaling}
      selectable={selectable}
      style={[
        typography[variant],
        center ? { textAlign: 'center' } : null,
        color ? { color } : null,
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export const textColors = {
  primary: colors.text,
  secondary: colors.textSecondary,
  muted: colors.muted,
  green: colors.green,
  brown: colors.brown,
} as const;
