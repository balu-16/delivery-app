import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AppState, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View, type GestureResponderEvent, type PressableInstance } from 'react-native';
import { router, type Href } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CardListSkeleton, ProductGridSkeleton } from '@/components/animations/Skeleton';
import { PressableScale } from '@/components/animations/PressableScale';
import { useFlyToCart } from '@/components/animations/FlyToCart';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Screen } from '@/components/ui/Screen';
import { images } from '@/constants/assets';
import { colors, fonts } from '@/constants/theme';
import { customerApi, customerDetailsApi, type CatalogItem, type CatalogPreviewItem } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { fetchCatalogPage, getCachedCatalogPage, isCatalogPageFresh, sameCatalogItems, type CatalogKind } from '@/src/store/catalog-cache';
import { AddressPanel } from './AddressPanel';
import { Card, ErrorBanner, Heading, formatPaise, shared } from './Shared';
import { useProductPhoto } from './useProductPhoto';
import { PushSettings } from './PushNotifications';
import { agentClient } from '@/src/agent/client';
import { agentStrings } from '@/src/agent/strings';
import { assistantNotificationTarget } from '@/src/agent/notification-target';
import { useRefresh } from '@/hooks/useRefresh';

type DisplayItem = CatalogItem | CatalogPreviewItem;
type ProductSelection = { item: DisplayItem; userId?: string; addressId: string | null; unavailable?: boolean; error?: string };
function isDiscounted(item: DisplayItem): boolean {
  if (!/^\d+$/.test(item.mrpPaise) || !/^\d+$/.test(item.sellingPaise)) return false;
  const mrp = item.mrpPaise.replace(/^0+(?=\d)/, '');
  const price = item.sellingPaise.replace(/^0+(?=\d)/, '');
  return mrp.length > price.length || (mrp.length === price.length && mrp > price);
}
function Price({ item }: { item: DisplayItem }) {
  return <View><View style={styles.prices}><AppText style={styles.price}>{formatPaise(item.sellingPaise)}</AppText>{isDiscounted(item) && <AppText style={styles.mrp}>{formatPaise(item.mrpPaise)}</AppText>}</View>{isDiscounted(item) && item.discountPercent > 0 && <AppText style={styles.discount}>{item.discountPercent}% off</AppText>}</View>;
}
const ProductTile = memo(function ProductTile({ item, select }: { item: DisplayItem; select: (item: DisplayItem) => void }) {
  const ref = useRef<PressableInstance>(null);
  const { fly } = useFlyToCart();
  const quantity = useCustomer(s => Number(s.cart?.lines.find(l => l.variantId === item.variantId)?.quantity ?? 0));
  const add = useCustomer(s => s.updateCart);
  const favorite = useCustomer(s => s.favorites.includes(item.productId));
  const favoritesReady = useCustomer(s => s.favoritesLoaded);
  const toggleFavorite = useCustomer(s => s.toggleFavorite);
  const blocked = useCustomer(s => !!s.pendingPlacement);
  const outOfStock = 'availability' in item && item.availability === 'OUT_OF_STOCK';
  const disabled = outOfStock || blocked;
  const photo = useProductPhoto(item.images[0], item.name);
  const onAdd = (event: GestureResponderEvent) => { const line=useCustomer.getState().cart?.lines.find(value => value.variantId === item.variantId); if (!line || line.unitPricePaise === item.sellingPaise) fly(photo.source ?? images.logoEmblem, ref, event); void add(item.variantId, 1, item); };
  return <View style={styles.tile}>
    <Pressable onPress={() => select(item)} accessibilityRole="button" accessibilityLabel={`View ${item.name}`}>
      <View style={styles.imageBox}>{photo.source ? <Image source={photo.source} placeholder={photo.placeholder} cachePolicy="memory-disk" onError={photo.onError} style={styles.productImage} contentFit="contain" placeholderContentFit="contain" /> : <Ionicons name="leaf-outline" size={30} color={colors.green} />}{photo.illustrative && <AppText style={styles.illustration}>Illustration</AppText>}</View>
      <AppText style={styles.productName} numberOfLines={2}>{item.name}</AppText>
      <AppText style={shared.muted}>{item.variantName}</AppText>
    </Pressable>
    <Pressable style={styles.favorite} disabled={!favoritesReady} onPress={() => void toggleFavorite(item.productId)} accessibilityRole="button" accessibilityLabel={`${favorite ? 'Remove' : 'Add'} ${item.name} ${favorite ? 'from' : 'to'} favorites`} accessibilityState={{selected:favorite,disabled:!favoritesReady}}><Ionicons name={favorite ? 'heart' : 'heart-outline'} size={20} color={favorite ? colors.danger : colors.textSecondary} /></Pressable>
    <View style={styles.tileFooter}><View><Price item={item} />{outOfStock && <AppText style={shared.muted}>Out of stock</AppText>}</View>
      <PressableScale ref={ref} style={[styles.add, disabled ? { opacity: 0.4 } : null]} onPress={onAdd} disabled={disabled} accessibilityRole="button" accessibilityLabel={`Add ${item.name} to cart`}><Ionicons name="add" size={22} color={colors.inverse} />{quantity > 0 && <View style={styles.count}><AppText style={styles.countText}>{quantity}</AppText></View>}</PressableScale>
    </View>
  </View>;
});
export function Catalog({ home = false }: { home?: boolean }) {
  const insets = useSafeAreaInsets();
  const { profile, addresses, selectedAddress: savedAddressId, products, cursor, loadCatalog, pendingPlacement, notifications, loadAccount, readNotifications, favorites, favoriteError, retryFavorites, catalogLoad, accountLoad, error } = useCustomer();
  const selectedAddressValue = addresses.find(x => x.id === savedAddressId);
  const selectedAddress = selectedAddressValue ? savedAddressId : null;
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [assistantAvailability, setAssistantAvailability] = useState<{ userId: string; enabled: boolean } | null>(null);
  const assistantEnabled = !!profile?.userId && assistantAvailability?.userId === profile.userId && assistantAvailability.enabled;
  const [addressOpen, setAddressOpen] = useState(false), [selection, setSelection] = useState<ProductSelection | null>(null), [query, setQuery] = useState(''), [results, setResults] = useState<{addressId: string; items: CatalogItem[]; kind:'search' | 'category' | 'favorites'; key:string; nextCursor:string | null} | null>(null), [searchError, setSearchError] = useState(''), [searching, setSearching] = useState(false);
  const selectionInScope = selection?.userId === profile?.userId && selection?.addressId === savedAddressId;
  const selected = selectionInScope ? selection?.item : undefined;
  if (selection && !selectionInScope) setSelection(null);
  const [categories, setCategories] = useState<{addressId:string; items:{id:string;name:string}[]} | null>(null);
  const [browseContext, setBrowseContext] = useState<{addressId:string; fresh:boolean} | null>(null);
  const [previewState, setPreviewState] = useState<{items: CatalogPreviewItem[]; error: boolean; attempt: number} | null>(null), [previewSearch, setPreviewSearch] = useState(''), [previewAttempt, setPreviewAttempt] = useState(0);
  const [previewFilter, setPreviewFilter] = useState('all');
  const [browseFailedKind, setBrowseFailedKind] = useState<CatalogKind | null>(null);
  const preview = previewState?.items ?? [];
  const previewLoading = previewState?.attempt !== previewAttempt;
  const previewError = !previewLoading && !!previewState?.error;
  const requestNumber = useRef(0);
  useEffect(() => {
    if (!home || !profile?.userId) return;
    let active = true;
    const userId = profile.userId;
    const refresh = () => { void agentClient.config(profile.locale === 'hi' || profile.locale === 'te' ? profile.locale : 'en').then(result => { if (active) setAssistantAvailability({ userId, enabled: result.enabled }); }).catch(() => { if (active) setAssistantAvailability({ userId, enabled: false }); }); };
    refresh();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') refresh(); });
    return () => { active = false; subscription.remove(); };
  }, [home, profile?.userId, profile?.locale]);
  useEffect(() => {
    let active = true;
    void accessToken().then(token => customerApi.catalogPreview(token)).then(value => { if (active) setPreviewState({items:value.items,error:false,attempt:previewAttempt}); }).catch(() => { if (active) setPreviewState({items:[],error:true,attempt:previewAttempt}); });
    return () => { active = false; };
  }, [previewAttempt]);
  useEffect(() => {
    if (!selectedAddress) return;
    let active = true;
    void accessToken().then(token => customerApi.categories(token,selectedAddress)).then(value => { if (active) setCategories({addressId:selectedAddress,items:value.items}); }).catch(() => {});
    return () => {active=false;};
  }, [selectedAddress]);
  const currentResults = results?.addressId === selectedAddress ? results : null;
  const previewShown = preview.filter(item => (!!selectedAddress || !previewSearch || `${item.name} ${item.variantName}`.toLowerCase().includes(previewSearch.toLowerCase())) && (!!selectedAddress || previewFilter === 'all' || (previewFilter === 'favorites' ? favorites.includes(item.productId) : item.categoryId === previewFilter)));
  const favoriteMerged = currentResults?.kind === 'favorites'
    ? [...currentResults.items, ...products.filter(item => favorites.includes(item.productId) && !currentResults.items.some(base => base.variantId === item.variantId))]
    : undefined;
  const addressItems = currentResults?.kind === 'favorites' ? favoriteMerged!.filter(item => favorites.includes(item.productId)) : currentResults?.items ?? products;
  const usePreview = !selectedAddress || (!currentResults && products.length === 0);
  const shown: DisplayItem[] = usePreview ? previewShown : addressItems;
  const previewCategories = [...new Map(preview.map(item => [item.categoryId,{id:item.categoryId,name:item.categoryName}])).values()];
  const catalogPending = !!selectedAddress && !currentResults && (catalogLoad?.addressId !== selectedAddress || catalogLoad?.state === 'idle' || catalogLoad?.state === 'loading');
  const catalogFailed = !!selectedAddress && !currentResults && catalogLoad?.addressId === selectedAddress && catalogLoad.state === 'error';
  const addressedFallback = usePreview && !!selectedAddress && catalogFailed && previewShown.length > 0;
  const freshBrowsePending = searching && browseContext?.addressId === selectedAddress && browseContext.fresh;
  const browse = async (kind: CatalogKind & ('search' | 'category' | 'favorites'), key:string, nextCursor?:string, options?: { force?: boolean }) => {
    if (!selectedAddress) return;
    const userId = profile?.userId;
    if (!userId) return;
    const request = ++requestNumber.current;
    const session = userId, address = selectedAddress;
    setSearching(true); setBrowseContext({addressId:address, fresh:!nextCursor}); setSearchError('');
    const current = () => request === requestNumber.current && useCustomer.getState().profile?.userId === session && useCustomer.getState().selectedAddress === address;
    try {
      if (!nextCursor && !options?.force) {
        const cached = getCachedCatalogPage({ userId: session, addressId: address, kind, key, cursor: null });
        if (cached && isCatalogPageFresh(cached)) {
          if (current()) setResults(previous => ({ addressId: address, kind, key, nextCursor: cached.nextCursor, items: previous && previous.addressId === address && previous.kind === kind && previous.key === key && sameCatalogItems(previous.items, cached.items) ? previous.items : cached.items }));
          return;
        }
      }
      const token = await accessToken();
      if (!current()) return;
      const page = await fetchCatalogPage({ userId: session, addressId: address, kind, key, cursor: nextCursor ?? null }, token);
      if (!current()) return;
      setBrowseFailedKind(null);
      setResults(previous => ({
        addressId: address, kind, key, nextCursor: page.nextCursor,
        items: nextCursor && previous?.addressId === address && previous.kind === kind && previous.key === key
          ? [...previous.items, ...page.items.filter(item => !previous.items.some(old => old.variantId === item.variantId))]
          : (previous && previous.addressId === address && previous.kind === kind && previous.key === key && sameCatalogItems(previous.items, page.items) ? previous.items : page.items),
      }));
    } catch { if (current()) { setBrowseFailedKind(kind); setSearchError('Couldn’t load products.'); } }
    finally { if (current()) setSearching(false); }
  };
  /** Switch the chip locally: show cached products for this account immediately, fetch the rest behind. */
  const activate = (kind:'search' | 'category' | 'favorites', key:string) => {
    if (kind !== 'search') setQuery('');
    setPreviewSearch('');
    if (!selectedAddress) { setPreviewFilter(kind === 'favorites' ? 'favorites' : key); return; }
    const userId = profile?.userId;
    const cached = userId ? getCachedCatalogPage({ userId, addressId: selectedAddress, kind, key, cursor: null }) : undefined;
    requestNumber.current++;
    setSearchError(''); setBrowseFailedKind(null);
    setResults(cached
      ? { addressId: selectedAddress, kind, key, nextCursor: cached.nextCursor, items: cached.items }
      : { addressId: selectedAddress, kind, key, nextCursor: null, items: [] });
    void browse(kind, key);
  };
  const showAll = () => { requestNumber.current++; setResults(null); setQuery(''); setPreviewSearch(''); setPreviewFilter('all'); setSearching(false); setBrowseFailedKind(null); };
  const search = () => { const key = query.trim(); if (!selectedAddress) { setPreviewSearch(key); return; } if (!key) { showAll(); return; } activate('search', key); };
  // Pull-to-refresh revalidates the current view only: the active browse filter
  // with a forced network read, the addressed catalogue, or the preview.
  // Existing content stays visible and duplicate pulls share one refresh.
  const { refreshing: catalogRefreshing, onRefresh: onCatalogRefresh } = useRefresh(async () => {
    if (currentResults) await browse(currentResults.kind, currentResults.key, undefined, { force: true });
    else if (selectedAddress) await loadCatalog(undefined, { force: true });
    else setPreviewAttempt(value => value + 1);
  });
  const { refreshing: noticesRefreshing, onRefresh: onNoticesRefresh } = useRefresh(() => loadAccount());
  const productRefresh = useRefresh(async () => {
    if (!selection) return;
    const { productId, variantId } = selection.item;
    const userId = profile?.userId;
    const stillCurrent = () => {
      const state = useCustomer.getState();
      return state.profile?.userId === userId && state.selectedAddress === savedAddressId;
    };
    try {
      const token = await accessToken();
      if (!stillCurrent()) return;
      let page: { items: DisplayItem[]; nextCursor?: string | null } = selectedAddress
        ? await customerApi.product(token, selectedAddress, productId)
        : await customerApi.catalogPreview(token);
      let item = page.items.find(item => item.variantId === variantId);
      while (!item && page.nextCursor && selectedAddress && stillCurrent()) {
        page = await customerApi.product(token, selectedAddress, productId, page.nextCursor);
        item = page.items.find(item => item.variantId === variantId);
      }
      if (stillCurrent()) setSelection(current => current !== selection ? current
        : item ? { ...selection, item, unavailable: false, error: undefined } : { ...selection, unavailable: true, error: undefined });
    } catch {
      if (stillCurrent()) setSelection(current => current === selection
        ? { ...current, error: 'Couldn’t refresh this product.' } : current);
    }
  });
  const selectProduct = useCallback((item: DisplayItem) => setSelection({ item, userId: profile?.userId, addressId: savedAddressId }), [profile?.userId, savedAddressId]);
  const renderTile = useCallback(({ item }: { item: DisplayItem }) => <ProductTile item={item} select={selectProduct} />, [selectProduct]);
  const gridLoading = freshBrowsePending || (shown.length === 0 && (catalogPending || (usePreview && previewLoading)));
  const gridFailed = !gridLoading && shown.length === 0 && catalogFailed;
  return <Screen><FlatList style={{flex:1}} data={shown} keyExtractor={item => item.variantId} numColumns={2} columnWrapperStyle={styles.row} renderItem={renderTile}
    contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12, flexGrow: 1 }]} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
    refreshControl={<RefreshControl refreshing={catalogRefreshing} onRefresh={() => void onCatalogRefresh()} tintColor={colors.green} />}
    ListHeaderComponent={<View style={{gap:12}}>
    <View style={styles.header}><PressableScale onPress={() => setAddressOpen(true)} style={styles.location}><Ionicons name="location" color={colors.green} size={17} /><AppText style={styles.locationText} numberOfLines={1}>{selectedAddressValue?.line1 ?? 'Select delivery address'}</AppText><Ionicons name="chevron-down" color={colors.green} size={15} /></PressableScale><View style={shared.row}>{home && assistantEnabled && <Pressable onPress={() => router.push('/agent' as Href)} accessibilityRole="button" accessibilityLabel={agentStrings(profile?.locale).title} hitSlop={10}><Ionicons name="chatbubble-ellipses-outline" size={24} color={colors.brownDark} /></Pressable>}<Pressable onPress={() => {setNotificationsOpen(true);void loadAccount();}} accessibilityRole="button" accessibilityLabel="Notifications"><Ionicons name="notifications-outline" size={24} color={colors.brownDark} /></Pressable><Pressable onPress={() => router.push('/profile')} accessibilityRole="button" accessibilityLabel="Profile"><Ionicons name="person-circle-outline" size={27} color={colors.brownDark} /></Pressable></View></View>
    <ErrorBanner />
    {error?.includes('Price changed. Review your cart.') && <Button label="Go to cart" size="sm" variant="soft" onPress={() => router.push('/cart')} />}
    {error?.includes('Price changed. Review your cart.') && <Button label="Refresh products" size="sm" variant="soft" onPress={() => {showAll();setPreviewAttempt(value => value+1);if (selectedAddress) void loadCatalog();}} />}
    {pendingPlacement && <View style={{gap:8}}><AppText style={shared.muted}>Check your pending order before adding more items.</AppText><Button label="Go to cart" size="sm" variant="soft" onPress={() => router.push('/cart')} /></View>}
    {home ? <><Heading title={`Hello${profile?.name ? `, ${profile.name.split(' ')[0]}` : ''}`} sub="Fresh dairy for your day" /><View style={styles.hero}><Image source={images.homeHero} style={StyleSheet.absoluteFill} contentFit="cover" /><LinearGradient pointerEvents="none" colors={['rgba(255,248,235,0.98)','rgba(255,248,235,0.82)','rgba(255,248,235,0)']} start={{x:0,y:0.5}} end={{x:1,y:0.5}} style={StyleSheet.absoluteFill} /><View style={styles.heroText}><AppText style={styles.heroTitle}>Freshness at your door</AppText><AppText style={shared.body}>Find fresh dairy for your cart.</AppText></View></View><Pressable onPress={() => router.push('/cart')} accessibilityRole="button" accessibilityLabel="View offers for your cart"><LinearGradient colors={['#FBE6CC','#F5CF9E']} start={{x:0,y:0}} end={{x:1,y:1}} style={styles.offer}><Ionicons name="pricetag-outline" size={24} color={colors.brown} /><View style={{flex:1}}><AppText style={shared.label}>Offers for your cart</AppText><AppText style={shared.muted}>Check available savings at checkout</AppText></View><Ionicons name="arrow-forward" color={colors.brown} size={18} /></LinearGradient></Pressable></> : <Heading title="Products" sub="Fresh dairy for your cart" />}
    {!home && <View style={shared.row}><TextInput style={[shared.input, { flex: 1 }]} value={query} onChangeText={text => { setQuery(text); if (!text) {showAll();setPreviewSearch('');} }} placeholder="Search products" accessibilityLabel="Search products" onSubmitEditing={search} /><Button label="Search" size="sm" variant="soft" onPress={search} disabled={searching} /></View>}
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:8}}><Button label="All" size="sm" variant={selectedAddress ? !currentResults ? 'primary' : 'soft' : previewFilter === 'all' ? 'primary' : 'soft'} onPress={showAll} /><Button label="Favorites" icon="heart-outline" size="sm" variant={(selectedAddress ? currentResults?.kind === 'favorites' : previewFilter === 'favorites') ? 'primary' : 'soft'} onPress={() => activate('favorites','favorites')} />{(selectedAddress && categories?.addressId === selectedAddress ? categories.items : previewCategories).map(category => <Button key={category.id} label={category.name} size="sm" variant={(selectedAddress ? currentResults?.kind === 'category' && currentResults.key === category.id : previewFilter === category.id) ? 'primary' : 'soft'} onPress={() => activate('category',category.id)} />)}</ScrollView>
    {!!favoriteError && <View style={shared.row}><AppText style={[shared.muted,{flex:1}]}>{favoriteError}</AppText><Button label="Retry" size="sm" variant="soft" onPress={() => void retryFavorites?.()} /></View>}
    {!!searchError && <AppText style={{color: colors.danger}}>{searchError}</AppText>}
    {usePreview && <><AppText style={shared.muted}>Delivery availability is checked when you review your order.</AppText>{previewError && <Button label="Retry loading products" variant="soft" onPress={() => setPreviewAttempt(value => value + 1)} />}</>}
    {addressedFallback && <><AppText style={shared.muted}>Couldn’t load products for your address.</AppText><Button label="Try again" variant="soft" size="sm" onPress={() => {void loadCatalog();setPreviewAttempt(value => value+1);}} /></>}
    <Heading title={currentResults?.kind === 'favorites' || (!selectedAddress && previewFilter === 'favorites') ? 'Favorites' : home ? selectedAddress && !usePreview ? 'Available near you' : 'Explore our dairy' : currentResults?.kind === 'search' ? 'Search results' : 'Products'} />
    </View>}
    ListEmptyComponent={gridLoading ? <ProductGridSkeleton />
      : gridFailed ? <View style={{gap:8}}><AppText style={shared.muted}>Couldn’t load products.</AppText><Button label="Try again" variant="soft" size="sm" onPress={() => {void loadCatalog();setPreviewAttempt(value => value+1);}} /></View>
      : browseFailedKind && currentResults?.kind === browseFailedKind ? <View style={{gap:8}}><AppText style={shared.muted}>{searchError || 'Couldn’t load products.'}</AppText><Button label="Try again" variant="soft" size="sm" onPress={() => void browse(currentResults.kind, currentResults.key)} /></View>
      : <AppText style={shared.muted}>{!selectedAddress && previewError ? 'Couldn’t load the product preview.' : !selectedAddress && previewSearch ? 'No matching products in the preview.' : currentResults?.kind === 'favorites' ? 'No favorites available at this address yet.' : 'No products available here right now.'}</AppText>}
    ListFooterComponent={selectedAddress && (currentResults?.nextCursor ? <Button label="Load more" variant="soft" loading={searching} onPress={() => void browse(currentResults.kind,currentResults.key,currentResults.nextCursor ?? undefined)} /> : !currentResults && cursor ? <Button label="Load more" variant="soft" onPress={() => void loadCatalog(cursor)} /> : <></>) || <></>}
  /><AddressPanel visible={addressOpen} onClose={() => setAddressOpen(false)} /><BottomSheet visible={notificationsOpen} onClose={() => setNotificationsOpen(false)} title="Notifications" refreshControl={<RefreshControl refreshing={noticesRefreshing} onRefresh={() => void onNoticesRefresh()} tintColor={colors.green} />}><View style={{gap:10}}><ErrorBanner />
    {accountLoad?.notifications === 'idle' || accountLoad?.notifications === 'loading' ? <CardListSkeleton label="Loading notifications" count={2} />
      : accountLoad?.notifications === 'error' ? <><AppText style={shared.muted}>Couldn’t load notifications.</AppText><Button label="Try again" size="sm" variant="soft" onPress={() => void loadAccount()} /></>
      : <>{notifications.length > 0 && <Button label="Mark all as read" size="sm" variant="soft" onPress={() => void readNotifications()} />}{notifications.length ? notifications.map(item => {
        const data = item.payload?.data && typeof item.payload.data === 'object' && !Array.isArray(item.payload.data) ? item.payload.data as Record<string, unknown> : {};
        const target = assistantNotificationTarget({ ...data, deepLink: item.payload?.deepLink });
        const content = <Card><AppText style={shared.label}>{item.title}</AppText><AppText style={shared.body}>{item.body}</AppText>{!item.readAt && <AppText style={shared.muted}>Unread</AppText>}</Card>;
        return target ? <Pressable key={item.id} accessibilityRole="button" onPress={() => {
          void accessToken().then(token => customerDetailsApi.readNotification(token, item.id)).then(() => loadAccount()).catch(() => undefined);
          setNotificationsOpen(false); router.push({ pathname: '/agent', params: target } as Href);
        }}>{content}</Pressable> : <View key={item.id}>{content}</View>;
      }) : <AppText style={shared.muted}>You have no notifications.</AppText>}</>}
    <PushSettings /></View></BottomSheet><BottomSheet visible={!!selected} onClose={() => setSelection(null)} title={selected?.name} subtitle={selected?.variantName} refreshControl={
      <RefreshControl refreshing={productRefresh.refreshing} onRefresh={() => void productRefresh.onRefresh()} tintColor={colors.green} />
    }>{selected && <View style={{gap:12}}>
      {!!selection?.error && <AppText accessibilityLiveRegion="polite" style={shared.muted}>{selection.error}</AppText>}
      {selection?.unavailable ? <AppText style={shared.body}>This size is unavailable.</AppText> : <>
        <AppText style={shared.body}>{selected.description || 'Product details are not available.'}</AppText>
        <Price item={selected} />
        <Button label="Add to cart" onPress={() => {
          void useCustomer.getState().updateCart(selected.variantId, 1, selected);
          setSelection(null);
        }} disabled={('availability' in selected && selected.availability === 'OUT_OF_STOCK') || !!pendingPlacement} fullWidth />
      </>}
    </View>}</BottomSheet></Screen>;
}
const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  location: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surfaceRaised, borderRadius: 30, paddingHorizontal: 11, paddingVertical: 9, maxWidth: '68%' },
  locationText: { fontSize: 12, fontFamily: fonts.semibold, color: colors.text, flexShrink: 1 },
  hero: { height: 180, borderRadius: 22, overflow: 'hidden', justifyContent: 'center' }, heroText: { width: '58%', gap: 8, padding: 16 }, heroTitle: { fontFamily: fonts.bold, fontSize: 22, lineHeight: 28, color: colors.brownDark },
  offer: {borderRadius:18, padding:15, flexDirection:'row', alignItems:'center', gap:12},
  row: { gap: 10 }, tile: { width: '48%', flexGrow: 1, maxWidth: '50%', backgroundColor: colors.surfaceRaised, borderColor: colors.line, borderWidth: 1, borderRadius: 18, padding: 12, gap: 8 },
  imageBox: { height: 120, alignItems: 'center', justifyContent: 'center' }, productImage: { width: '100%', height: '100%' }, illustration: {position:'absolute', bottom:2, right:2, fontSize:9, color:colors.textSecondary, backgroundColor:'rgba(255,255,255,0.9)', paddingHorizontal:4, borderRadius:4}, productName: { fontFamily: fonts.semibold, color: colors.text, fontSize: 13, lineHeight: 18, minHeight: 36 },
  favorite: {position:'absolute', right:10, top:10, width:32, height:32, borderRadius:16, backgroundColor:colors.surfaceRaised, alignItems:'center', justifyContent:'center'},
  tileFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, price: { fontFamily: fonts.bold, fontSize: 15, color: colors.brownDark },
  prices: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 5 }, mrp: { color: colors.muted, textDecorationLine: 'line-through', fontSize: 11 }, discount: { color: colors.green, fontSize: 10, fontFamily: fonts.semibold },
  add: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' }, count: { position: 'absolute', right: -3, top: -4, backgroundColor: colors.brown, borderRadius: 10, minWidth: 16, alignItems: 'center' }, countText: { fontSize: 9, color: colors.inverse },
});
