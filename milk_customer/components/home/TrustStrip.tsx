import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { AppText } from '@/components/ui/AppText';
import { colors, fonts, radii } from '@/constants/theme';
import { trustPoints } from '@/data/profile';

const icons = {
  farm: 'home-outline',
  fresh: 'sunny-outline',
  pure: 'leaf-outline',
} as const;

export function TrustStrip() {
  return (
    <View style={styles.root}>
      {trustPoints.map((point, index) => (
        <View key={point.key} style={styles.item}>
          <View style={styles.icon}>
            <Ionicons name={icons[point.key]} size={17} color={colors.green} />
          </View>
          <View style={{ flex: 1 }}>
            <AppText style={styles.title}>{point.title}</AppText>
            <AppText style={styles.body}>{point.body}</AppText>
          </View>
          {index < trustPoints.length - 1 ? <View style={styles.divider} /> : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    backgroundColor: colors.greenPale,
    borderRadius: radii.lg,
    paddingVertical: 13,
    paddingHorizontal: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.75)',
    gap: 2,
  },
  item: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 4,
  },
  icon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontFamily: fonts.semibold,
    fontSize: 9.8,
    lineHeight: 13,
    color: colors.greenDark,
  },
  body: {
    fontFamily: fonts.regular,
    fontSize: 8.7,
    lineHeight: 12,
    color: colors.textSecondary,
    marginTop: 1,
  },
  divider: {
    width: 1,
    height: 25,
    backgroundColor: 'rgba(61,109,21,0.12)',
    marginLeft: 6,
  },
});
