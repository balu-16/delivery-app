import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { StyleSheet, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';

import { PressableScale } from '@/components/animations/PressableScale';
import { QuantityStepper } from '@/components/ui/QuantityStepper';
import { AppText } from '@/components/ui/AppText';
import { colors, fonts, radii } from '@/constants/theme';
import type { Product } from '@/data/products';
import { formatCurrency } from '@/utils/format';

export function CartItemRow({
  product,
  quantity,
  onIncrement,
  onDecrement,
  onRemove,
  last,
}: {
  product: Product;
  quantity: number;
  onIncrement: () => void;
  onDecrement: () => void;
  onRemove: () => void;
  last?: boolean;
}) {
  const showSave = Boolean(product.mrp) && product.category === 'Milk';

  return (
    <ReanimatedSwipeable
      friction={2}
      rightThreshold={48}
      overshootRight={false}
      renderRightActions={() => (
        <PressableScale
          onPress={onRemove}
          haptic="none"
          style={styles.swipeDelete}
          accessibilityLabel={`Remove ${product.name}`}
        >
          <Ionicons name="trash" size={19} color={colors.inverse} />
          <AppText style={styles.swipeDeleteText}>Remove</AppText>
        </PressableScale>
      )}
      containerStyle={styles.swipeContainer}
    >
      <View style={[styles.row, last ? null : styles.rowBorder]}>
        <View
          style={[
            styles.imageWrap,
            product.imageKind === 'tile' ? styles.imageTile : null,
          ]}
        >
          <Image source={product.image} style={styles.image} contentFit="contain" />
        </View>

        <View style={styles.body}>
          {product.category === 'Milk' ? (
            <View style={styles.badge}>
              <AppText style={styles.badgeText}>FARM FRESH</AppText>
            </View>
          ) : null}
          <AppText style={styles.name} numberOfLines={1}>
            {product.name}
          </AppText>
          <AppText style={styles.size}>{product.size}</AppText>
          <View style={styles.priceRow}>
            <AppText style={styles.price}>{formatCurrency(product.price)}</AppText>
            {product.mrp ? <AppText style={styles.mrp}>{formatCurrency(product.mrp)}</AppText> : null}
            {showSave && product.mrp ? (
              <AppText style={styles.save}>
                You save {formatCurrency(product.mrp - product.price)}
              </AppText>
            ) : null}
          </View>
        </View>

        <View style={styles.right}>
          <PressableScale
            onPress={onRemove}
            haptic="select"
            style={styles.trash}
            accessibilityLabel={`Remove ${product.name} from cart`}
          >
            <Ionicons name="trash-outline" size={18} color={colors.brownMid} />
          </PressableScale>
          <QuantityStepper
            quantity={quantity}
            onIncrement={onIncrement}
            onDecrement={onDecrement}
            tone="cart"
            compact
          />
        </View>
      </View>
    </ReanimatedSwipeable>
  );
}

const styles = StyleSheet.create({
  swipeContainer: {
    backgroundColor: colors.surface,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 11,
    paddingHorizontal: 12,
    backgroundColor: colors.surface,
  },
  rowBorder: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  imageWrap: {
    width: 53,
    height: 70,
    alignItems: 'center',
    justifyContent: 'center',
  },
  imageTile: {
    borderRadius: 26,
    overflow: 'hidden',
    backgroundColor: '#FCF5ED',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: colors.greenTint,
    borderRadius: 999,
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    marginBottom: 2,
  },
  badgeText: {
    fontFamily: fonts.semibold,
    fontSize: 7.2,
    lineHeight: 10,
    letterSpacing: 0.4,
    color: colors.greenDark,
  },
  name: {
    fontFamily: fonts.semibold,
    fontSize: 14.5,
    lineHeight: 19,
    color: colors.text,
    letterSpacing: -0.1,
  },
  size: {
    fontFamily: fonts.regular,
    fontSize: 11,
    lineHeight: 15,
    color: colors.muted,
    marginTop: -1,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 5,
    marginTop: 3,
    flexWrap: 'wrap',
  },
  price: {
    fontFamily: fonts.bold,
    fontSize: 14.5,
    lineHeight: 19,
    color: colors.text,
  },
  mrp: {
    fontFamily: fonts.regular,
    fontSize: 10.5,
    lineHeight: 14,
    color: colors.mutedLight,
    textDecorationLine: 'line-through',
  },
  save: {
    fontFamily: fonts.medium,
    fontSize: 9,
    lineHeight: 13,
    color: colors.green,
  },
  right: {
    width: 91,
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    paddingVertical: 1,
  },
  trash: {
    width: 30,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -2,
    marginRight: -3,
  },
  swipeDelete: {
    width: 84,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  swipeDeleteText: {
    fontFamily: fonts.medium,
    fontSize: 9,
    color: colors.inverse,
  },
  radius: {
    borderRadius: radii.md,
  },
});
