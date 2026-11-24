import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { PageHeader } from '@/components/connected/PageHeader';
import { Card, ErrorBanner, formatPaise, shared } from '@/components/connected/Shared';
import { useProductPhoto } from '@/components/connected/useProductPhoto';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { colors, fonts } from '@/constants/theme';
import { customerApi, type CatalogItem } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { useRefresh } from '@/hooks/useRefresh';
import { UUID_RE } from '@/src/utils/order-groups';

export default function ProductDetailPage() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string; variantId?: string }>();
  const productId = typeof params.id === 'string' && UUID_RE.test(params.id) ? params.id : null;
  const variantId = typeof params.variantId === 'string' && UUID_RE.test(params.variantId) ? params.variantId : null;
  const selectedAddress = useCustomer(s => s.selectedAddress);
  const favorites = useCustomer(s => s.favorites);
  const favoritesLoaded = useCustomer(s => s.favoritesLoaded);
  const toggleFavorite = useCustomer(s => s.toggleFavorite);
  const updateCart = useCustomer(s => s.updateCart);
  const pendingPlacement = useCustomer(s => s.pendingPlacement);
  const addresses = useCustomer(s => s.addresses);

  const [item, setItem] = useState<CatalogItem | null>(null);
  const [allVariants, setAllVariants] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  // Hooks must run before early returns; photo is derived after item is available via separate component.
  const load = async () => {
    if (!productId) return;
    setLoading(true); setError(false);
    try {
      const token = await accessToken();
      if (!selectedAddress) {
        // No address: use preview to show product, but keep availability guidance.
        const page = await customerApi.catalogPreview(token);
        const found = (page.items as unknown as CatalogItem[]).find(p => p.productId === productId);
        if (found) setItem(found);
        else throw new Error('not found');
        setAllVariants(found ? [found] : []);
        return;
      }
      // Product by ID: fetch pages until variant found or cursor ends.
      let cursor: string | undefined;
      let found: CatalogItem | undefined;
      const collected: CatalogItem[] = [];
      let lastNext: string | null = null;
      do {
        const page = await customerApi.product(token, selectedAddress, productId, cursor);
        collected.push(...page.items);
        if (variantId) {
          found = page.items.find(i => i.variantId === variantId);
          if (found) break;
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
        lastNext = page.nextCursor;
        if (collected.length > 50) break;
      } while (cursor);
      const chosen = found ?? collected[0];
      if (!chosen) throw new Error('not found');
      setItem(chosen);
      setAllVariants(collected.length ? collected : [chosen]);
    } catch {
      setError(true);
    } finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [productId, variantId, selectedAddress, retryCount]); // eslint-disable-line
  const { refreshing, onRefresh } = useRefresh(async () => { await load(); });

  // Hook order: must be before any early return; fallback when item is null.
  const photo = useProductPhoto(item?.images[0] ?? null, item?.name ?? '');

  if (!productId) {
    return (
      <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
        <PageHeader title="Product" onBack={() => router.canGoBack() ? router.back() : router.replace('/products')} />
        <Card><AppText style={shared.body}>This product could not be opened.</AppText></Card>
      </ScrollView></Screen>
    );
  }

  if (loading && !item) {
    return (
      <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
        <PageHeader title="Product" onBack={() => router.back()} />
        <CardListSkeleton count={2} label="Loading product" />
      </ScrollView></Screen>
    );
  }

  if (error && !item) {
    return (
      <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
        <PageHeader title="Product" onBack={() => router.back()} />
        <Card><AppText style={shared.body}>Couldn’t load this product.</AppText><Button label="Try again" variant="soft" size="sm" onPress={() => setRetryCount(c => c + 1)} /></Card>
      </ScrollView></Screen>
    );
  }

  if (!item) return null;

  const isFavorite = favorites.includes(item.productId);
  const outOfStock = item.availability === 'OUT_OF_STOCK';

  const onSelectVariant = (v: CatalogItem) => {
    if (v.variantId === item.variantId) return;
    router.setParams({ variantId: v.variantId });
    setItem(v);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12, flexGrow: 1 }]} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.green} />}>
        <PageHeader title={item.name} sub={item.variantName} onBack={() => router.canGoBack() ? router.back() : router.replace('/products')} />
        <ErrorBanner />
        <Card style={styles.hero}>
          <View style={styles.imageBox}>
            {photo.source ? <Image source={photo.source} placeholder={photo.placeholder} cachePolicy="memory-disk" onError={photo.onError} style={StyleSheet.absoluteFill} contentFit="contain" accessibilityLabel={photo.illustrative ? `${item.name}, illustration` : item.name} /> : <Ionicons name="leaf-outline" size={48} color={colors.green} />}
            {photo.illustrative && <AppText style={styles.illustration}>Illustration</AppText>}
          </View>
          <Pressable style={styles.favorite} disabled={!favoritesLoaded} onPress={() => void toggleFavorite(item.productId)} accessibilityRole="button" accessibilityLabel={`${isFavorite ? 'Remove' : 'Add'} ${item.name} ${isFavorite ? 'from' : 'to'} favorites`} accessibilityState={{ selected: isFavorite, disabled: !favoritesLoaded }}>
            <Ionicons name={isFavorite ? 'heart' : 'heart-outline'} size={24} color={isFavorite ? colors.danger : colors.textSecondary} />
          </Pressable>
          <View>
            <AppText style={styles.name}>{item.name}</AppText>
            <AppText style={shared.muted}>{item.variantName}</AppText>
            <View style={styles.prices}><AppText style={styles.price}>{formatPaise(item.sellingPaise)}</AppText>{Number(item.mrpPaise) > Number(item.sellingPaise) && <AppText style={styles.mrp}>{formatPaise(item.mrpPaise)}</AppText>}{item.discountPercent > 0 && <AppText style={styles.discount}>{item.discountPercent}% off</AppText>}</View>
            <AppText style={shared.body}>{item.description || 'Product details are not available.'}</AppText>
            {item.description ? null : null}
            {/* Ingredients only when supplied by catalog data — no hardcoded ingredients */}
          </View>
        </Card>

        {!selectedAddress ? (
          <Card>
            <AppText style={shared.body}>Select a delivery address to see accurate availability.</AppText>
            <Button label="Choose address" variant="soft" size="sm" onPress={() => router.push('/addresses')} />
          </Card>
        ) : (
          <Card>
            <AppText style={shared.label}>Size</AppText>
            <View style={shared.row}>
              {allVariants.map(v => (
                <Button
                  key={v.variantId}
                  label={v.variantName}
                  size="sm"
                  variant={v.variantId === item.variantId ? 'primary' : 'soft'}
                  onPress={() => onSelectVariant(v)}
                />
              ))}
            </View>
            <AppText style={shared.muted}>{outOfStock ? 'Out of stock at this address.' : 'In stock at this address.'}</AppText>
            <View style={shared.row}>
              <Button label="Add to cart" fullWidth disabled={outOfStock || !!pendingPlacement} onPress={() => void updateCart(item.variantId, 1, item)} />
            </View>
          </Card>
        )}

        {error && <AppText accessibilityLiveRegion="polite" style={shared.muted}>Couldn’t refresh this product.</AppText>}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { gap: 12 },
  imageBox: { height: 220, alignItems: 'center', justifyContent: 'center', borderRadius: 18, overflow: 'hidden', backgroundColor: colors.greenIce, position: 'relative' },
  illustration: { position: 'absolute', bottom: 6, right: 6, fontSize: 9, color: colors.textSecondary, backgroundColor: 'rgba(255,255,255,0.9)', paddingHorizontal: 4, borderRadius: 4 },
  favorite: { position: 'absolute', right: 12, top: 12, width: 38, height: 38, borderRadius: 19, backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  name: { fontFamily: fonts.bold, fontSize: 18, color: colors.brownDark },
  prices: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  price: { fontFamily: fonts.bold, fontSize: 18, color: colors.brownDark },
  mrp: { color: colors.muted, textDecorationLine: 'line-through', fontSize: 13 },
  discount: { color: colors.green, fontSize: 12, fontFamily: fonts.semibold },
});
