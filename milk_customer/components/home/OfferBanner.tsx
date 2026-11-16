import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';
import { PressableScale } from '@/components/animations/PressableScale';
import { AppText } from '@/components/ui/AppText';
import { images } from '@/constants/assets';
import { colors, fonts, radii, shadows } from '@/constants/theme';

export function OfferBanner({ width, onPress }: { width: number; onPress: () => void }) {
  const height = Math.max(112, Math.round((width * 180) / 562));
  return (
    <PressableScale onPress={onPress} haptic="select" style={[styles.root, { width, height }]} accessibilityRole="button" accessibilityLabel="Flat 15 percent off on desi ghee. Grab the offer.">
      <Image source={images.homeHero} style={StyleSheet.absoluteFill} contentFit="cover" accessibilityElementsHidden />
      <LinearGradient pointerEvents="none" colors={['rgba(255,244,226,0.98)', 'rgba(255,237,210,0.92)', 'rgba(252,225,186,0.55)']} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
      <View style={styles.copy}><AppText style={styles.eyebrow}>OFFER</AppText><AppText style={styles.title}>Flat 15% OFF</AppText><AppText style={styles.body}>on Desi Ghee</AppText><AppText style={styles.action}>Grab now →</AppText></View>
      <Image source={images.gheeJar} style={styles.image} contentFit="contain" />
    </PressableScale>
  );
}
const styles = StyleSheet.create({
  root: { marginTop: 14, borderRadius: radii.lg, overflow: 'hidden', backgroundColor: colors.peachSoft, flexDirection: 'row', alignItems: 'center', ...shadows.card },
  copy: { flex: 1, paddingLeft: 16, gap: 1 },
  eyebrow: { color: colors.green, fontFamily: fonts.bold, fontSize: 9 },
  title: { color: colors.brownDark, fontFamily: fonts.bold, fontSize: 18, lineHeight: 23 },
  body: { color: colors.text, fontSize: 11 },
  action: { color: colors.green, fontFamily: fonts.semibold, fontSize: 10, marginTop: 4 },
  image: { width: '40%', height: '90%' },
});
