import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps, ReactNode } from 'react';

import { colors, fonts, gradients, radii } from '@/constants/theme';
import { PressableScale } from '@/components/animations/PressableScale';
import { AppText } from '@/components/ui/AppText';

type IconName = ComponentProps<typeof Ionicons>['name'];

type ButtonProps = {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'brown' | 'soft' | 'outline' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  iconPosition?: 'left' | 'right';
  trailing?: ReactNode;
  fullWidth?: boolean;
  disabled?: boolean;
  loading?: boolean;
  haptic?: 'tap' | 'select' | 'none';
  style?: object;
  accessibilityLabel?: string;
};

const heights = { sm: 36, md: 44, lg: 52 } as const;

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'lg',
  icon,
  iconPosition = 'left',
  trailing,
  fullWidth,
  disabled,
  loading,
  haptic = 'tap',
  style,
  accessibilityLabel,
}: ButtonProps) {
  const height = heights[size];
  const isSolid = variant === 'primary' || variant === 'brown';
  const textColor =
    variant === 'primary' || variant === 'brown'
      ? colors.inverse
      : variant === 'outline'
        ? colors.green
        : colors.greenDark;
  const iconColor = textColor;

  const content = (
    <>
      {loading ? (
        <ActivityIndicator size="small" color={textColor} />
      ) : (
        <>
          {icon && iconPosition === 'left' ? (
            <Ionicons name={icon} size={size === 'sm' ? 14 : 17} color={iconColor} />
          ) : null}
          <AppText
            style={{
              fontFamily: fonts.semibold,
              fontSize: size === 'sm' ? 12 : size === 'md' ? 13.5 : 14.5,
              color: textColor,
              letterSpacing: 0.1,
            }}
          >
            {label}
          </AppText>
          {icon && iconPosition === 'right' ? (
            <Ionicons name={icon} size={size === 'sm' ? 14 : 17} color={iconColor} />
          ) : null}
        </>
      )}
      {trailing}
    </>
  );

  const base = [
    styles.base,
    { height, opacity: disabled ? 0.52 : 1 },
    fullWidth ? styles.full : null,
    variant === 'outline' ? styles.outline : null,
    variant === 'ghost' ? styles.ghost : null,
    style,
  ];

  if (isSolid) {
    return (
      <PressableScale
        onPress={onPress}
        disabled={disabled || loading}
        haptic={haptic}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        style={base}
      >
        <LinearGradient
          colors={variant === 'brown' ? gradients.buttonBrown : gradients.button}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.gradient}
        >
          {content}
        </LinearGradient>
      </PressableScale>
    );
  }

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled || loading}
      haptic={haptic}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      style={[
        base,
        variant === 'soft' ? styles.soft : null,
        variant === 'outline' ? styles.outline : null,
        variant === 'ghost' ? styles.ghost : null,
      ]}
    >
      <View style={styles.contentRow}>{content}</View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.pill,
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
  full: {
    alignSelf: 'stretch',
    width: '100%',
  },
  gradient: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 22,
  },
  contentRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
  },
  soft: {
    backgroundColor: colors.greenSoft,
  },
  outline: {
    backgroundColor: 'transparent',
    borderWidth: 1.2,
    borderColor: colors.green,
  },
  ghost: {
    backgroundColor: 'transparent',
  },
});
