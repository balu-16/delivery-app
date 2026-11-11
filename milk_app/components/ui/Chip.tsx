import { Image } from 'expo-image';
import type { StyleProp, ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native';

import { PressableScale } from '@/components/animations/PressableScale';
import { AppText } from '@/components/ui/AppText';
import type { AssetSource } from '@/constants/assets';
import { colors, shadows } from '@/constants/theme';

export function Chip({
  label,
  active,
  onPress,
  image,
  style,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  image?: AssetSource;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <PressableScale
      onPress={onPress}
      haptic="select"
      style={[
        styles.chip,
        active ? styles.active : styles.inactive,
        style,
      ]}
    >
      {image ? (
        <Image
          source={image}
          style={styles.image}
          contentFit="contain"
          transition={120}
        />
      ) : null}
      <AppText
        style={[
          styles.label,
          { color: active ? colors.inverse : colors.textSecondary },
          !image ? { paddingHorizontal: 4 } : null,
        ]}
      >
        {label}
      </AppText>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  chip: {
    height: 40,
    paddingLeft: 5,
    paddingRight: 13,
    borderRadius: 999,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  active: {
    backgroundColor: colors.green,
    ...shadows.soft,
  },
  inactive: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
  },
  image: {
    width: 31,
    height: 31,
    borderRadius: 16,
    backgroundColor: '#FCF5ED',
  },
  label: {
    fontFamily: 'Poppins_500Medium',
    fontSize: 12.5,
    lineHeight: 17,
  },
});
