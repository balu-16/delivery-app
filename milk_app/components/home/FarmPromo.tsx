import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import { PressableScale } from '@/components/animations/PressableScale';
import { AppText } from '@/components/ui/AppText';
import { images } from '@/constants/assets';
import { colors, fonts } from '@/constants/theme';
export function FarmPromo({ onPress, width = 158 }: { onPress: () => void; width?: number }) {
  return <PressableScale onPress={onPress} haptic="select" style={[styles.wrap, { width, height: width * 0.55 }]} accessibilityLabel="Explore 150 happy farms"><Image source={images.cowMascot} style={styles.cow} contentFit="contain" /><View style={styles.sign}><AppText style={styles.text}>From 150+{ '\n' }happy farms</AppText></View></PressableScale>;
}
const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center' },
  cow: { width: '45%', height: '95%' },
  sign: { width: '55%', backgroundColor: '#795128', borderRadius: 7, padding: 5, marginBottom: 9 },
  text: { color: colors.inverse, fontFamily: fonts.semibold, fontSize: 9, lineHeight: 13, textAlign: 'center' },
});
