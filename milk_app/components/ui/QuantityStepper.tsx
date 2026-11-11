import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { PressableScale } from '@/components/animations/PressableScale';
import { AppText } from '@/components/ui/AppText';
import { colors, fonts } from '@/constants/theme';

export function QuantityStepper({
  quantity,
  onIncrement,
  onDecrement,
  compact = false,
  tone = 'light',
  max = 20,
}: {
  quantity: number;
  onIncrement: () => void;
  onDecrement: () => void;
  compact?: boolean;
  tone?: 'light' | 'green' | 'cart';
  max?: number;
}) {
  const green = tone === 'green';
  const cart = tone === 'cart';

  return (
    <View
      style={[
        styles.wrap,
        compact ? styles.compact : null,
        green ? styles.green : null,
        cart ? styles.cart : null,
        { height: compact ? 34 : cart ? 38 : 40 },
      ]}
    >
      <PressableScale
        onPress={onDecrement}
        haptic="select"
        accessibilityLabel="Decrease quantity"
        style={styles.btn}
      >
        <Ionicons
          name="remove"
          size={compact ? 14 : 16}
          color={green ? colors.inverse : colors.brown}
        />
      </PressableScale>
      <AppText
        style={[
          styles.qty,
          compact ? { fontSize: 12 } : null,
          green ? { color: colors.inverse } : null,
        ]}
      >
        {quantity}
      </AppText>
      <PressableScale
        onPress={onIncrement}
        haptic="select"
        disabled={quantity >= max}
        accessibilityLabel="Increase quantity"
        style={styles.btn}
      >
        <Ionicons
          name="add"
          size={compact ? 15 : 17}
          color={green ? colors.inverse : quantity >= max ? colors.mutedLight : colors.brown}
        />
      </PressableScale>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.lineStrong,
    backgroundColor: colors.surfaceRaised,
    paddingHorizontal: 4,
    minWidth: 102,
  },
  compact: {
    minWidth: 82,
  },
  green: {
    backgroundColor: colors.green,
    borderColor: colors.green,
  },
  cart: {
    backgroundColor: colors.surface,
    borderColor: '#EBDCC8',
  },
  btn: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qty: {
    fontFamily: fonts.semibold,
    fontSize: 13.5,
    color: colors.text,
    minWidth: 22,
    textAlign: 'center',
  },
});
