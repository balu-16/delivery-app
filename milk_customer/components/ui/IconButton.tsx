import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from '@/components/animations/PressableScale';
import { colors, shadows } from '@/constants/theme';
import { AppText } from '@/components/ui/AppText';

export function IconButton({
  name,
  onPress,
  size = 42,
  iconSize = 20,
  variant = 'surface',
  badge,
  accessibilityLabel,
}: {
  name: ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
  size?: number;
  iconSize?: number;
  variant?: 'surface' | 'green' | 'ghost';
  badge?: number;
  accessibilityLabel: string;
}) {
  const background =
    variant === 'green' ? colors.green : variant === 'ghost' ? 'transparent' : colors.surface;
  const iconColor = variant === 'green' ? colors.inverse : colors.greenDark;

  return (
    <PressableScale
      onPress={onPress}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      haptic="select"
      style={[
        styles.button,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: background,
        },
        variant === 'surface' ? shadows.tiny : null,
      ]}
    >
      <Ionicons name={name} size={iconSize} color={iconColor} />
      {badge ? (
        <View style={styles.badge}>
          <AppText style={styles.badgeText}>{badge > 9 ? '9+' : badge}</AppText>
        </View>
      ) : null}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -3,
    right: -3,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.green,
    borderWidth: 2,
    borderColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontFamily: 'Poppins_700Bold',
    fontSize: 8.5,
    lineHeight: 11,
    color: colors.inverse,
  },
});
