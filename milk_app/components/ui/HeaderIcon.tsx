import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from '@/components/animations/PressableScale';
import { AppText } from '@/components/ui/AppText';
import { colors } from '@/constants/theme';

/** Bare header action used by the editorial headers in the reference design. */
export function HeaderIcon({
  name,
  onPress,
  badge,
  accessibilityLabel,
  size = 24,
  color = colors.brownDark,
}: {
  name: ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
  badge?: number;
  accessibilityLabel: string;
  size?: number;
  color?: string;
}) {
  return (
    <PressableScale
      onPress={onPress}
      haptic="select"
      style={styles.button}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      <Ionicons name={name} size={size} color={color} />
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
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 3,
    right: 1,
    minWidth: 17,
    height: 17,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: colors.green,
    borderWidth: 1.5,
    borderColor: '#FFF8ED',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontFamily: 'Poppins_700Bold',
    fontSize: 8,
    lineHeight: 10,
    color: colors.inverse,
  },
});
