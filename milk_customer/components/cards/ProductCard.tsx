import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { memo, useRef } from 'react';
import { StyleSheet, type PressableInstance, type GestureResponderEvent, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { PressableScale } from '@/components/animations/PressableScale';
import { Reveal } from '@/components/animations/Reveal';
import { useFlyToCart } from '@/components/animations/FlyToCart';
import { AppText } from '@/components/ui/AppText';
import { Badge } from '@/components/ui/Badge';
import { type Product } from '@/data/products';
import { colors, radii, shadows } from '@/constants/theme';
import { useCartStore } from '@/store/cartStore';
import { useUserStore } from '@/store/userStore';
import { successFeedback } from '@/utils/haptics';
import { formatCurrency } from '@/utils/format';

type ProductCardProps = {
  product: Product;
  variant?: 'showcase' | 'compact';
  index?: number;
  onPress: (product: Product) => void;
  sharedTransition?: boolean;
  animateIn?: boolean;
};

export const ProductCard = memo(function ProductCard({
  product,
  variant = 'showcase',
  index = 0,
  onPress,
  sharedTransition,
  animateIn = true,
}: ProductCardProps) {
  const addButton = useRef<PressableInstance>(null);
  const addItem = useCartStore((state) => state.addItem);
  const count = useCartStore(
    (state) => state.items.find((line) => line.id === product.id)?.quantity ?? 0,
  );
  const favorite = useUserStore((state) => state.favorites.includes(product.id));
  const toggleFavorite = useUserStore((state) => state.toggleFavorite);
  const { fly } = useFlyToCart();

  const handleAdd = (event: GestureResponderEvent) => {
    fly(product.image, addButton, event);
    addItem(product.id);
    successFeedback();
  };

  const isShowcase = variant === 'showcase';

  const body = (
    <PressableScale
      onPress={() => onPress(product)}
      haptic="select"
      style={[styles.card, isShowcase ? styles.showcase : styles.compact]}
      accessibilityLabel={`View ${product.name}`}
    >
      {isShowcase ? (
        <>
          <View style={styles.topRow}>
            {product.tag ? <Badge tone="green">Fresh</Badge> : <View />}
            <PressableScale
              onPress={() => toggleFavorite(product.id)}
              haptic="select"
              style={styles.heart}
              accessibilityLabel={favorite ? 'Remove from favourites' : 'Add to favourites'}
            >
              <Ionicons
                name={favorite ? 'heart' : 'heart-outline'}
                size={19}
                color={favorite ? colors.danger : colors.brownMid}
              />
            </PressableScale>
          </View>

          <View style={styles.imageArea}>
            <Animated.View
              sharedTransitionTag={sharedTransition ? `product-image-${product.id}` : undefined}
              style={styles.imageWrap}
            >
              <Image
                source={product.image}
                style={[
                  styles.image,
                  product.imageKind === 'tile' ? styles.tileImage : null,
                ]}
                contentFit="contain"
                cachePolicy="memory-disk"
                transition={160}
                accessibilityLabel={product.name}
              />
            </Animated.View>
          </View>

          <View style={styles.nameRow}>
            <AppText style={styles.name} numberOfLines={2}>
              {product.name}
            </AppText>
          </View>
          <AppText style={styles.size}>{product.size}</AppText>
          <View style={styles.bottomRow}>
            <View style={styles.ratingRow}>
              <Ionicons name="star" size={11} color={colors.star} />
              <AppText style={styles.rating}>
                {product.rating.toFixed(1)} ({product.reviews})
              </AppText>
            </View>
            <View style={styles.priceRow}>
              <AppText style={styles.price}>{formatCurrency(product.price)}</AppText>
              <PressableScale
                ref={addButton}
                onPress={handleAdd}
                haptic="none"
                style={styles.addButton}
                accessibilityLabel={`Add ${product.name} to cart`}
              >
                <Ionicons name="add" size={19} color={colors.inverse} />
                {count > 0 ? (
                  <View style={styles.countDot}>
                    <AppText style={styles.countText}>{count}</AppText>
                  </View>
                ) : null}
              </PressableScale>
            </View>
          </View>
        </>
      ) : (
        <View style={styles.compactInner}>
          <View style={styles.compactText}>
            <AppText style={styles.name} numberOfLines={2}>
              {product.name}
            </AppText>
            <AppText style={styles.size}>{product.size}</AppText>
            <View style={styles.compactRating}>
              <Ionicons name="star" size={11} color={colors.star} />
              <AppText style={styles.rating}>
                {product.rating.toFixed(1)} ({product.reviews})
              </AppText>
            </View>
          </View>
          <PressableScale
            onPress={() => toggleFavorite(product.id)}
            haptic="select"
            style={styles.heartCompact}
            accessibilityLabel={favorite ? 'Remove from favourites' : 'Add to favourites'}
          >
            <Ionicons
              name={favorite ? 'heart' : 'heart-outline'}
              size={18}
              color={favorite ? colors.danger : colors.brownMid}
            />
          </PressableScale>
          <View style={styles.compactImageArea} pointerEvents="none">
            <Image
              source={product.image}
              style={[styles.compactImage, product.imageKind === 'tile' ? styles.tileImage : null]}
              contentFit="contain"
              cachePolicy="memory-disk"
              transition={160}
            />
          </View>
          <View style={styles.compactBottom}>
            <AppText style={styles.price}>{formatCurrency(product.price)}</AppText>
            <PressableScale
              ref={addButton}
              onPress={handleAdd}
              haptic="none"
              style={styles.addButton}
              accessibilityLabel={`Add ${product.name} to cart`}
            >
              <Ionicons name="add" size={19} color={colors.inverse} />
              {count > 0 ? (
                <View style={styles.countDot}>
                  <AppText style={styles.countText}>{count}</AppText>
                </View>
              ) : null}
            </PressableScale>
          </View>
        </View>
      )}
    </PressableScale>
  );

  if (!animateIn) return body;

  return (
    <Reveal delay={Math.min(360, index * 55)} style={styles.reveal}>
      {body}
    </Reveal>
  );
});

const styles = StyleSheet.create({
  reveal: {
    width: '48.2%',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: 'rgba(233, 218, 196, 0.55)',
    ...shadows.tiny,
  },
  showcase: {
    minHeight: 199,
    padding: 10,
    paddingBottom: 11,
  },
  compact: {
    minHeight: 152,
    padding: 11,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 22,
  },
  heart: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -2,
    marginRight: -2,
  },
  imageArea: {
    height: 78,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  imageWrap: {
    height: 78,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  image: {
    width: '74%',
    height: '100%',
  },
  tileImage: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: '#FCF5ED',
  },
  nameRow: {
    marginTop: 4,
  },
  name: {
    fontFamily: 'Poppins_600SemiBold',
    fontSize: 13.5,
    lineHeight: 19,
    color: colors.text,
  },
  size: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 11.5,
    lineHeight: 16,
    color: colors.muted,
    marginTop: 1,
  },
  bottomRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  ratingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    flex: 1,
  },
  rating: {
    fontFamily: 'Poppins_400Regular',
    fontSize: 10.5,
    lineHeight: 14,
    color: colors.muted,
  },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  price: {
    fontFamily: 'Poppins_700Bold',
    fontSize: 14,
    lineHeight: 19,
    color: colors.text,
  },
  addButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.green,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.button,
  },
  countDot: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.greenDeep,
    borderWidth: 1.5,
    borderColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  countText: {
    fontFamily: 'Poppins_700Bold',
    fontSize: 8,
    lineHeight: 10,
    color: colors.inverse,
  },
  compactInner: {
    flex: 1,
  },
  compactText: {
    paddingRight: 32,
  },
  compactRating: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginTop: 6,
  },
  heartCompact: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  compactImageArea: {
    position: 'absolute',
    right: 0,
    top: 24,
    width: 88,
    height: 82,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactImage: {
    width: '90%',
    height: '100%',
  },
  compactBottom: {
    marginTop: 'auto',
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
});
