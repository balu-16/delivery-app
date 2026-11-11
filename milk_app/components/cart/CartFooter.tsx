import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PressableScale } from '@/components/animations/PressableScale';
import { AppText } from '@/components/ui/AppText';
import { images } from '@/constants/assets';
import { colors, fonts, shadows } from '@/constants/theme';
import { formatCurrency } from '@/utils/format';

/**
 * Footer sits above the floating tab bar. The extra height clears the tab
 * bar's mascot bubble so the secure-payments pill is never covered.
 */
export const CART_FOOTER_EXTRA = 144;

/** Sticky checkout scene at the bottom of the cart. */
export function CartFooter({
  total,
  onCheckout,
  disabled,
}: {
  total: number;
  onCheckout: () => void;
  disabled: boolean;
}) {
  const insets = useSafeAreaInsets();
  const barTop = Math.max(insets.bottom, 10) + 66;
  const sceneHeight = barTop + CART_FOOTER_EXTRA;

  return (
    <View pointerEvents="box-none" style={[styles.scene, { height: sceneHeight }]}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(251,243,231,0)', 'rgba(251,243,231,0.92)', colors.background]}
        locations={[0, 0.32, 0.62]}
        style={StyleSheet.absoluteFill}
      />

      <Image
        pointerEvents="none"
        source={images.footerCow}
        style={[styles.cow, { bottom: barTop - 21 }]}
        contentFit="contain"
        accessibilityElementsHidden
      />
      <Image
        pointerEvents="none"
        source={images.cartMilkCan}
        style={[styles.can, { bottom: barTop - 11 }]}
        contentFit="contain"
        accessibilityElementsHidden
      />

      <View
        pointerEvents="box-none"
        style={[styles.content, { bottom: barTop + 39 }]}
      >
        <PressableScale
          onPress={onCheckout}
          disabled={disabled}
          haptic="tap"
          accessibilityRole="button"
          accessibilityLabel={`Proceed to checkout, total ${formatCurrency(total)}`}
          style={[styles.button, disabled ? { opacity: 0.5 } : null]}
        >
          <LinearGradient
            colors={['#4A7D1B', '#325E10']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.buttonFill}
          >
            <AppText style={styles.buttonText}>Proceed to Checkout</AppText>
            <Ionicons name="arrow-forward" size={17} color={colors.inverse} />
          </LinearGradient>
        </PressableScale>

        <View style={styles.securePill}>
          <View style={styles.shield}>
            <Ionicons name="shield-checkmark" size={18} color={colors.green} />
          </View>
          <View>
            <AppText style={styles.secureTitle}>Demo checkout</AppText>
            <AppText style={styles.secureBody}>No real payment will be made</AppText>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scene: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 8,
  },
  grass: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    opacity: 0.96,
  },
  cow: {
    position: 'absolute',
    left: -2,
    width: 102,
    height: 104,
  },
  can: {
    position: 'absolute',
    left: 92,
    width: 58,
    height: 70,
    opacity: 0.95,
  },
  content: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  button: {
    width: '55%',
    maxWidth: 230,
    minWidth: 200,
    borderRadius: 999,
    overflow: 'hidden',
    ...shadows.button,
  },
  buttonFill: {
    height: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
  },
  buttonText: {
    fontFamily: fonts.semibold,
    fontSize: 13.5,
    color: colors.inverse,
    letterSpacing: 0.1,
  },
  securePill: {
    marginTop: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,252,246,0.97)',
    borderRadius: 999,
    paddingVertical: 6,
    paddingLeft: 7,
    paddingRight: 14,
    ...shadows.soft,
  },
  shield: {
    width: 29,
    height: 29,
    borderRadius: 15,
    backgroundColor: colors.greenSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secureTitle: {
    fontFamily: fonts.semibold,
    fontSize: 9.5,
    lineHeight: 12,
    color: colors.text,
  },
  secureBody: {
    fontFamily: fonts.regular,
    fontSize: 8.2,
    lineHeight: 11,
    color: colors.muted,
  },
});
