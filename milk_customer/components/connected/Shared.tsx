import { StyleSheet, View, type ViewStyle } from 'react-native';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { colors, fonts } from '@/constants/theme';
import { useCustomer } from '@/src/store/customer';

export { formatPaise } from '@/src/utils/money';
export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) { return <View style={[styles.card, style]}>{children}</View>; }
export function Heading({ title, sub }: { title: string; sub?: string }) { return <View><AppText style={styles.heading}>{title}</AppText>{sub ? <AppText style={styles.muted}>{sub}</AppText> : null}</View>; }
export function ErrorBanner() { const error = useCustomer(x => x.error); const clear = useCustomer(x => x.clearError); return error ? <View style={styles.error}><AppText style={styles.errorText}>{error}</AppText><Button label="Dismiss" size="sm" variant="ghost" onPress={clear} /></View> : null; }
export const shared = StyleSheet.create({
  scroll: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 165, gap: 12 },
  body: { color: colors.text, fontSize: 13, lineHeight: 20 }, muted: { color: colors.textSecondary, fontSize: 12, lineHeight: 18 },
  label: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text },
  input: { minHeight: 46, borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 12, color: colors.text },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 9 },
});
const styles = StyleSheet.create({
  card: { backgroundColor: colors.surfaceRaised, padding: 16, borderRadius: 20, borderWidth: 1, borderColor: colors.line, gap: 10 },
  heading: { fontFamily: fonts.bold, color: colors.brownDark, fontSize: 20, lineHeight: 28 },
  muted: { color: colors.textSecondary, fontSize: 12, lineHeight: 19 },
  error: { backgroundColor: colors.dangerSoft, padding: 12, borderRadius: 14, gap: 5 },
  errorText: { color: colors.danger, fontSize: 12, lineHeight: 18 },
});
