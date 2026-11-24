import { Pressable, StyleSheet, View } from 'react-native';
import { AppText } from '@/components/ui/AppText';
import { colors, fonts } from '@/constants/theme';

export function PageHeader({ title, sub, onBack }: { title: string; sub?: string; onBack: () => void }) {
  return (
    <View style={styles.header}>
      <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={12} style={s.btn}>
        <AppText style={s.back}>‹ Back</AppText>
      </Pressable>
      <View style={{ flex: 1 }}>
        <AppText style={styles.title}>{title}</AppText>
        {sub ? <AppText style={styles.sub}>{sub}</AppText> : null}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontFamily: fonts.bold, fontSize: 20, lineHeight: 26, color: colors.brownDark },
  sub: { fontSize: 12, color: colors.textSecondary },
});
const s = StyleSheet.create({ btn: { paddingVertical: 8, paddingRight: 4 }, back: { fontFamily: fonts.semibold, fontSize: 14, color: colors.green } });
