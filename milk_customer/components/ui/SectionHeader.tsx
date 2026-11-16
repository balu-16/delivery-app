import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from '@/components/animations/PressableScale';
import { AppText } from '@/components/ui/AppText';
import { colors } from '@/constants/theme';

export function SectionHeader({
  title,
  action,
  onAction,
  subtitle,
  style,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  subtitle?: string;
  style?: object;
}) {
  return (
    <View style={[styles.row, style]}>
      <View style={{ flex: 1 }}>
        <AppText style={styles.title}>{title}</AppText>
        {subtitle ? <AppText style={styles.subtitle}>{subtitle}</AppText> : null}
      </View>
      {action ? (
        <PressableScale onPress={onAction ?? (() => {})} haptic="select" style={styles.action}>
          <AppText style={styles.actionText}>{action}</AppText>
          <Ionicons name="chevron-forward" size={13} color={colors.green} />
        </PressableScale>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 15.5,
    lineHeight: 22,
    color: colors.text,
  },
  subtitle: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 11.5,
    lineHeight: 16,
    color: colors.muted,
    marginTop: 1,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
    paddingVertical: 4,
    paddingLeft: 8,
  },
  actionText: {
    fontFamily: 'Poppins_500Medium',
    fontSize: 11.5,
    color: colors.green,
  },
});
