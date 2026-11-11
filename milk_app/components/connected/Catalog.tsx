import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View, type GestureResponderEvent, type PressableInstance } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PressableScale } from '@/components/animations/PressableScale';
import { useFlyToCart } from '@/components/animations/FlyToCart';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Screen } from '@/components/ui/Screen';
import { images } from '@/constants/assets';
import { colors, fonts } from '@/constants/theme';
import { customerApi, type CatalogItem } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { AddressPanel } from './AddressPanel';
import { Card, ErrorBanner, Heading, formatPaise, shared } from './Shared';
import { useProductPhoto } from './useProductPhoto';
import { PushSettings } from './PushNotifications';

function ProductTile({ item, select }: { item: CatalogItem; select: (item: CatalogItem) => void }) {
  const ref = useRef<PressableInstance>(null);
  const { fly } = useFlyToCart();
  const quantity = useCustomer(s => Number(s.cart?.lines.find(l => l.variantId === item.variantId)?.quantity ?? 0));
  const add = useCustomer(s => s.updateCart);
  const favorite = useCustomer(s => s.favorites.includes(item.productId));
  const favoriteDisabled = useCustomer(s => !s.favoritesLoaded || s.favoriteBusy.includes(item.productId));
  const toggleFavorite = useCustomer(s => s.toggleFavorite);
  const blocked = useCustomer(s => !!s.pendingPlacement || !s.selectedAddress || (!!s.cart && s.cart.addressId !== s.selectedAddress));
  const disabled = item.availability === 'OUT_OF_STOCK' || blocked;
  const photo = useProductPhoto(item.images[0], item.name);
  const onAdd = (event: GestureResponderEvent) => { fly(photo.source ?? images.logoEmblem, ref, event); void add(item.variantId, 1); };
  return <View style={styles.tile}>
    <Pressable onPress={() => select(item)} accessibilityRole="button" accessibilityLabel={`View ${item.name}`}>
      <View style={styles.imageBox}>{photo.source ? <Image source={photo.source} onError={photo.onError} style={styles.productImage} contentFit="contain" /> : <Ionicons name="leaf-outline" size={30} color={colors.green} />}{photo.illustrative && <AppText style={styles.illustration}>Illustration</AppText>}</View>
      <AppText style={styles.productName} numberOfLines={2}>{item.name}</AppText>
      <AppText style={shared.muted}>{item.variantName}</AppText>
    </Pressable>
    <Pressable style={styles.favorite} disabled={favoriteDisabled} onPress={() => void toggleFavorite(item.productId)} accessibilityRole="button" accessibilityLabel={`${favorite ? 'Remove' : 'Add'} ${item.name} ${favorite ? 'from' : 'to'} favorites`} accessibilityState={{selected:favorite,disabled:favoriteDisabled}}><Ionicons name={favorite ? 'heart' : 'heart-outline'} size={20} color={favorite ? colors.danger : colors.textSecondary} /></Pressable>
    <View style={styles.tileFooter}><View><AppText style={styles.price}>{formatPaise(item.sellingPaise)}</AppText>{item.availability === 'OUT_OF_STOCK' && <AppText style={shared.muted}>Out of stock</AppText>}</View>
      <PressableScale ref={ref} style={[styles.add, disabled ? { opacity: 0.4 } : null]} onPress={onAdd} disabled={disabled} accessibilityRole="button" accessibilityLabel={`Add ${item.name} to cart`}><Ionicons name="add" size={22} color={colors.inverse} />{quantity > 0 && <View style={styles.count}><AppText style={styles.countText}>{quantity}</AppText></View>}</PressableScale>
    </View>
  </View>;
}
export function Catalog({ home = false }: { home?: boolean }) {
  const insets = useSafeAreaInsets();
  const { profile, addresses, selectedAddress, products, cursor, loadCatalog, pendingPlacement, cart, notifications, loadAccount, readNotifications, favorites } = useCustomer();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [addressOpen, setAddressOpen] = useState(false), [selected, setSelected] = useState<CatalogItem | null>(null), [query, setQuery] = useState(''), [results, setResults] = useState<{addressId: string; items: CatalogItem[]; kind:'search' | 'category' | 'favorites'; key:string; nextCursor:string | null} | null>(null), [searchError, setSearchError] = useState(''), [searching, setSearching] = useState(false);
  const [categories, setCategories] = useState<{addressId:string; items:{id:string;name:string}[]} | null>(null);
  const requestNumber = useRef(0);
  useEffect(() => {
    if (!selectedAddress) return;
    let active = true;
    void accessToken().then(token => customerApi.categories(token,selectedAddress)).then(value => { if (active) setCategories({addressId:selectedAddress,items:value.items}); }).catch(() => {});
    return () => {active=false;};
  }, [selectedAddress]);
  const selectedAddressValue = addresses.find(x => x.id === selectedAddress);
  const currentResults = results?.addressId === selectedAddress ? results : null;
  const shown = currentResults?.kind === 'favorites' ? currentResults.items.filter(item => favorites.includes(item.productId)) : currentResults?.items ?? products;
  const browse = async (kind:'search' | 'category' | 'favorites', key:string, nextCursor?:string) => {
    if (!selectedAddress) { setAddressOpen(true); return; }
    const request = ++requestNumber.current;
    setSearching(true); setSearchError('');
    try {
      const token = await accessToken();
      const page = kind === 'search' ? await customerApi.search(token,selectedAddress,key,nextCursor) : kind === 'favorites' ? await customerApi.favoriteProducts(token,selectedAddress,nextCursor) : await customerApi.category(token,selectedAddress,key,nextCursor);
      if (request === requestNumber.current) setResults(previous => ({addressId:selectedAddress,kind,key,nextCursor:page.nextCursor,items:nextCursor && previous?.addressId === selectedAddress && previous.kind === kind && previous.key === key ? [...previous.items,...page.items.filter(item => !previous.items.some(old => old.variantId === item.variantId))] : page.items}));
    } catch { if (request === requestNumber.current) setSearchError('Could not load products. Please try again.'); }
    finally { if (request === requestNumber.current) setSearching(false); }
  };
  const search = () => { const key = query.trim(); if (!key) {requestNumber.current++;setResults(null);setSearching(false);return;} void browse('search',key); };
  return <Screen><ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} keyboardShouldPersistTaps="handled">
    <View style={styles.header}><PressableScale onPress={() => setAddressOpen(true)} style={styles.location}><Ionicons name="location" color={colors.green} size={17} /><AppText style={styles.locationText} numberOfLines={1}>{selectedAddressValue?.line1 ?? 'Select delivery address'}</AppText><Ionicons name="chevron-down" color={colors.green} size={15} /></PressableScale><View style={shared.row}><Pressable onPress={() => {setNotificationsOpen(true);void loadAccount();}} accessibilityRole="button" accessibilityLabel="Notifications"><Ionicons name="notifications-outline" size={24} color={colors.brownDark} /></Pressable><Pressable onPress={() => router.push('/profile')} accessibilityRole="button" accessibilityLabel="Profile"><Ionicons name="person-circle-outline" size={27} color={colors.brownDark} /></Pressable></View></View>
    <ErrorBanner />
    {(pendingPlacement || (!!cart && cart.addressId !== selectedAddress)) && <View style={{gap:8}}><AppText style={shared.muted}>{pendingPlacement ? 'Check your pending order before adding more items.' : 'Review your cart for this address before adding more items.'}</AppText><Button label="Go to cart" size="sm" variant="soft" onPress={() => router.push('/cart')} /></View>}
    {home ? <><Heading title={`Hello${profile?.name ? `, ${profile.name.split(' ')[0]}` : ''}`} sub="Fresh dairy for your day" /><View style={styles.hero}><Image source={images.homeHero} style={StyleSheet.absoluteFill} contentFit="cover" /><LinearGradient pointerEvents="none" colors={['rgba(255,248,235,0.98)','rgba(255,248,235,0.82)','rgba(255,248,235,0)']} start={{x:0,y:0.5}} end={{x:1,y:0.5}} style={StyleSheet.absoluteFill} /><View style={styles.heroText}><AppText style={styles.heroTitle}>Freshness at your door</AppText><AppText style={shared.body}>Browse what is available at your address.</AppText></View></View><Pressable onPress={() => router.push('/cart')} accessibilityRole="button" accessibilityLabel="View offers for your cart"><LinearGradient colors={['#FBE6CC','#F5CF9E']} start={{x:0,y:0}} end={{x:1,y:1}} style={styles.offer}><Ionicons name="pricetag-outline" size={24} color={colors.brown} /><View style={{flex:1}}><AppText style={shared.label}>Offers for your cart</AppText><AppText style={shared.muted}>Check available savings at checkout</AppText></View><Ionicons name="arrow-forward" color={colors.brown} size={18} /></LinearGradient></Pressable></> : <Heading title="Products" sub="Available at your delivery address" />}
    {!home && <View style={shared.row}><TextInput style={[shared.input, { flex: 1 }]} value={query} onChangeText={text => { setQuery(text); if (!text) {requestNumber.current++;setResults(null);setSearching(false);} }} placeholder="Search products" accessibilityLabel="Search products" onSubmitEditing={search} /><Button label="Search" size="sm" variant="soft" onPress={search} disabled={searching} /></View>}
    {selectedAddress && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{gap:8}}><Button label="All" size="sm" variant={!currentResults ? 'primary' : 'soft'} onPress={() => {requestNumber.current++;setResults(null);setQuery('');setSearching(false);}} /><Button label="Favorites" icon="heart-outline" size="sm" variant={currentResults?.kind === 'favorites' ? 'primary' : 'soft'} onPress={() => {setQuery('');void browse('favorites','favorites');}} />{categories?.addressId === selectedAddress && categories.items.map(category => <Button key={category.id} label={category.name} size="sm" variant={currentResults?.kind === 'category' && currentResults.key === category.id ? 'primary' : 'soft'} onPress={() => {setQuery('');void browse('category',category.id);}} />)}</ScrollView>}
    {!!searchError && <AppText style={{color: colors.danger}}>{searchError}</AppText>}
    {!selectedAddress ? <Button label="Add delivery address" onPress={() => setAddressOpen(true)} fullWidth /> : shown.length === 0 ? <AppText style={shared.muted}>{searching ? 'Searching…' : currentResults?.kind === 'favorites' ? 'No favorites available at this address yet.' : 'No products available here right now.'}</AppText> : <><Heading title={currentResults?.kind === 'favorites' ? 'Favorites' : home ? 'Available near you' : currentResults?.kind === 'search' ? 'Search results' : 'Products'} /><View style={styles.grid}>{shown.map(item => <ProductTile key={item.variantId} item={item} select={setSelected} />)}</View>{currentResults?.nextCursor ? <Button label="Load more" variant="soft" loading={searching} onPress={() => void browse(currentResults.kind,currentResults.key,currentResults.nextCursor ?? undefined)} /> : !currentResults && cursor ? <Button label="Load more" variant="soft" onPress={() => void loadCatalog(cursor)} /> : null}</>}
  </ScrollView><AddressPanel visible={addressOpen} onClose={() => setAddressOpen(false)} /><BottomSheet visible={notificationsOpen} onClose={() => setNotificationsOpen(false)} title="Notifications"><View style={{gap:10}}><ErrorBanner />{notifications.length > 0 && <Button label="Mark all as read" size="sm" variant="soft" onPress={() => void readNotifications()} />}{notifications.length ? notifications.map(item => <Card key={item.id}><AppText style={shared.label}>{item.title}</AppText><AppText style={shared.body}>{item.body}</AppText>{!item.readAt && <AppText style={shared.muted}>Unread</AppText>}</Card>) : <AppText style={shared.muted}>You have no notifications.</AppText>}<PushSettings /></View></BottomSheet><BottomSheet visible={!!selected} onClose={() => setSelected(null)} title={selected?.name} subtitle={selected?.variantName}>{selected && <View style={{gap:12}}><AppText style={shared.body}>{selected.description || 'Product details are not available.'}</AppText><AppText style={styles.price}>{formatPaise(selected.sellingPaise)}</AppText><Button label="Add to cart" onPress={() => { void useCustomer.getState().updateCart(selected.variantId, 1); setSelected(null); }} disabled={selected.availability === 'OUT_OF_STOCK' || !!pendingPlacement || !selectedAddress || (!!cart && cart.addressId !== selectedAddress)} fullWidth /></View>}</BottomSheet></Screen>;
}
const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  location: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.surfaceRaised, borderRadius: 30, paddingHorizontal: 11, paddingVertical: 9, maxWidth: '68%' },
  locationText: { fontSize: 12, fontFamily: fonts.semibold, color: colors.text, flexShrink: 1 },
  hero: { height: 180, borderRadius: 22, overflow: 'hidden', justifyContent: 'center' }, heroText: { width: '58%', gap: 8, padding: 16 }, heroTitle: { fontFamily: fonts.bold, fontSize: 22, lineHeight: 28, color: colors.brownDark },
  offer: {borderRadius:18, padding:15, flexDirection:'row', alignItems:'center', gap:12},
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, tile: { width: '48%', flexGrow: 1, maxWidth: '50%', backgroundColor: colors.surfaceRaised, borderColor: colors.line, borderWidth: 1, borderRadius: 18, padding: 12, gap: 8 },
  imageBox: { height: 120, alignItems: 'center', justifyContent: 'center' }, productImage: { width: '100%', height: '100%' }, illustration: {position:'absolute', bottom:2, right:2, fontSize:9, color:colors.textSecondary, backgroundColor:'rgba(255,255,255,0.9)', paddingHorizontal:4, borderRadius:4}, productName: { fontFamily: fonts.semibold, color: colors.text, fontSize: 13, lineHeight: 18, minHeight: 36 },
  favorite: {position:'absolute', right:10, top:10, width:32, height:32, borderRadius:16, backgroundColor:colors.surfaceRaised, alignItems:'center', justifyContent:'center'},
  tileFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, price: { fontFamily: fonts.bold, fontSize: 15, color: colors.brownDark },
  add: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' }, count: { position: 'absolute', right: -3, top: -4, backgroundColor: colors.brown, borderRadius: 10, minWidth: 16, alignItems: 'center' }, countText: { fontSize: 9, color: colors.inverse },
});
