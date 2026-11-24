import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { AddressPanel } from '@/components/connected/AddressPanel';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { Card, ErrorBanner, formatPaise, Heading, shared } from '@/components/connected/Shared';
import { useProductPhoto } from '@/components/connected/useProductPhoto';
import { colors, fonts } from '@/constants/theme';
import { useCustomer } from '@/src/store/customer';
import { useRefresh } from '@/hooks/useRefresh';
import { feeBandTotalPaise, lookupFeeBand } from '@/src/store/fees-cache';
import { customerApi, type Coupon, type ServerCart } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { ORDER_CONFIRMATION_WAIT, deriveCheckoutStatus, describePlacementOrder, isCheckoutLocked, placementOrderTitle } from '@/src/store/checkout-recovery';
import type { CartProduct } from '@/src/store/cart-sync';

function MoneyRow({ label, value }: { label: string; value: string }) {
  return <View style={styles.moneyRow}><AppText style={shared.body}>{label}</AppText><AppText style={shared.label}>{formatPaise(value)}</AppText></View>;
}
function CartPhoto({path, name}: {path:string | null | undefined; name:string}) {
  const photo = useProductPhoto(path, name);
  return <View style={styles.thumbnail}>{photo.source ? <Image source={photo.source} onError={photo.onError} style={styles.thumbnailImage} contentFit="contain" cachePolicy="memory-disk" accessibilityLabel={photo.illustrative ? `${name}, illustration` : name} /> : <Ionicons name="leaf-outline" size={24} color={colors.green} />}</View>;
}
/** Primitive props only so memo skips rows whose data did not change. */
const CartLineItem = memo(function CartLineItem({ variantId, name, variantName, image, quantity, unitPricePaise, issueCode, freshPrice, available, locked, saving, undoable, updateCart, undoCart }: {
  variantId: string; name: string; variantName: string; image: string | null; quantity: string; unitPricePaise: string;
  issueCode: string | null; freshPrice: string | null; available: number;
  locked: boolean; saving: boolean; undoable: boolean;
  updateCart: (id: string, delta: number, product?: CartProduct, acceptedPricePaise?: string) => Promise<void>;
  undoCart: (id: string) => Promise<void>;
}) {
  const onDecrement = useCallback(() => void updateCart(variantId, -1), [updateCart, variantId]);
  const onIncrement = useCallback(() => void updateCart(variantId, 1), [updateCart, variantId]);
  const onUndo = useCallback(() => void undoCart(variantId), [undoCart, variantId]);
  const onAcceptPrice = useCallback(() => { if (freshPrice) void updateCart(variantId, 0, undefined, freshPrice); }, [updateCart, variantId, freshPrice]);
  const onUseAvailable = useCallback(() => void updateCart(variantId, available-Number(quantity)), [updateCart, variantId, available, quantity]);
  const onRemove = useCallback(() => void updateCart(variantId, -Number(quantity)), [updateCart, variantId, quantity]);
  return <View>
    <Card>
      <View style={shared.row}>
        <CartPhoto path={image} name={name} />
        <View style={{flex:1}}><AppText style={shared.label}>{name}</AppText><AppText style={shared.muted}>{variantName}</AppText><AppText style={styles.price}>{formatPaise(unitPricePaise)} each</AppText>{saving && <View style={styles.saving} accessibilityLabel={`Saving ${name}`} accessibilityState={{busy:true}}><ActivityIndicator size="small" color={colors.green} /><AppText style={shared.muted}>Saving…</AppText></View>}</View>
        <View style={styles.sideCol}>
          <View style={styles.stepper}><Button size="sm" variant="ghost" label="−" accessibilityLabel={`Remove one ${name}`} onPress={onDecrement} disabled={locked} /><AppText style={shared.label}>{quantity}</AppText><Button size="sm" variant="ghost" label="+" accessibilityLabel={`Add one ${name}`} onPress={onIncrement} disabled={locked} /></View>
          {undoable && <Button label="Undo" variant="ghost" size="sm" accessibilityLabel={`Undo last change to ${name}`} disabled={locked} onPress={onUndo} />}
        </View>
      </View>
    </Card>
    {issueCode && <Card><AppText style={shared.muted}>{issueCode === 'PRICE_CHANGED' && freshPrice ? `Current price: ${formatPaise(freshPrice)} each.` : issueCode === 'QTY_REDUCED' && Number.isSafeInteger(available) ? `Only ${available} available for this address.` : 'This item is unavailable at this address.'}</AppText>{issueCode === 'PRICE_CHANGED' && freshPrice ? <Button label="Accept updated price" size="sm" variant="soft" disabled={locked} onPress={onAcceptPrice} /> : issueCode === 'QTY_REDUCED' && Number.isSafeInteger(available) && available > 0 ? <Button label={`Use ${available}`} size="sm" variant="soft" disabled={locked} onPress={onUseAvailable} /> : <Button label="Remove item" size="sm" variant="soft" disabled={locked} onPress={onRemove} />}</Card>}
  </View>;
});
const EMPTY_LINES: never[] = [];
export default function Cart() {
  const insets = useSafeAreaInsets();
  const [addressOpen, setAddressOpen] = useState(false);
  const [resumeCheckout, setResumeCheckout] = useState(false);
  const [showOnlineInfo, setShowOnlineInfo] = useState(false);
  const [couponCode,setCouponCode] = useState(''), [offers,setOffers] = useState<{addressId:string;version:number;items:Coupon[]} | null>(null), [offersLoading,setOffersLoading] = useState(false), [offersError,setOffersError] = useState('');
  const cart = useCustomer(state => state.cart);
  const cartBusy = useCustomer(state => state.cartBusy);
  const cartSyncFailed = useCustomer(state => state.cartSyncFailed);
  const pendingVariantIds = useCustomer(state => state.pendingVariantIds);
  const undoVariantIds = useCustomer(state => state.undoVariantIds);
  const undoCart = useCustomer(state => state.undoCart);
  const products = useCustomer(state => state.products);
  const quote = useCustomer(state => state.quote);
  const pendingPlacement = useCustomer(state => state.pendingPlacement);
  const checkoutPhase = useCustomer(state => state.checkoutPhase);
  const checkoutError = useCustomer(state => state.checkoutError);
  const lastOrder = useCustomer(state => state.lastOrder);
  const selectedAddress = useCustomer(state => state.selectedAddress);
  const addresses = useCustomer(state => state.addresses);
  const locationRequired = useCustomer(state => state.locationRequired);
  const feeEstimate = useCustomer(state => state.feeEstimate);
  const feeLoading = useCustomer(state => state.feeLoading);
  const feeError = useCustomer(state => state.feeError);
  const reviewSlow = useCustomer(state => state.reviewSlow);
  const retryCart = useCustomer(state => state.retryCart);
  const updateCart = useCustomer(state => state.updateCart);
  const changeCoupon = useCustomer(state => state.changeCoupon);
  const createQuote = useCustomer(state => state.createQuote);
  const placeOrder = useCustomer(state => state.placeOrder);
  const refreshDeliverySettings = useCustomer(state => state.refreshDeliverySettings);
  const refreshCart = useCustomer(state => state.refreshCart);
  const checkPendingPlacement = useCustomer(state => state.checkPendingPlacement);
  const address = addresses.find(item => item.id === selectedAddress);
  const locationNeeded = locationRequired && !!address && !address.point;
  const lastFocusRef = useRef(0);
  useEffect(() => { void refreshDeliverySettings().catch(() => undefined); }, [refreshDeliverySettings]);
  // Dedupe focus fetches: a silent revalidate is enough within 15s; pull-to-refresh still forces.
  // A pending placement also reconciles via placement-status on focus (no resubmit).
  useFocusEffect(useCallback(() => {
    if (pendingPlacement) void checkPendingPlacement();
    const now = Date.now();
    if (now - lastFocusRef.current < 15_000) return;
    lastFocusRef.current = now;
    void refreshCart({silent:true});
  }, [refreshCart, checkPendingPlacement, pendingPlacement]));
  // Pull-to-refresh reconciles pending cart writes and placement status without
  // creating an order; optimistic quantities stay visible meanwhile.
  const { refreshing: cartRefreshing, onRefresh: onCartRefresh } = useRefresh(async () => {
    await Promise.allSettled([refreshCart(), refreshDeliverySettings().catch(() => undefined), useCustomer.getState().checkPendingPlacement()]);
  });
  // Checkout phases from the existing fields: preparing (reviewing), confirming (placing),
  // still-checking (checking/uncertain/pending), confirmed (lastOrder), rejected (idle+error).
  const locked = isCheckoutLocked(checkoutPhase, pendingPlacement);
  const checkoutStatus = deriveCheckoutStatus({ phase: checkoutPhase, pending: pendingPlacement, checkoutError, lastOrder });
  const reviewing = checkoutStatus === 'preparing';
  const placing = checkoutPhase === 'placing' || checkoutPhase === 'checking';
  const failed = checkoutStatus === 'rejected';
  const placed = checkoutStatus === 'confirmed';
  const placedCopy = lastOrder ? describePlacementOrder(lastOrder) : null;
  const wrongAddress = !!cart?.addressId && cart.addressId !== selectedAddress;
  const offersReady = !!cart?.addressId && cart.addressId === selectedAddress;
  const review = () => {if (!address || locationNeeded) {setResumeCheckout(true);setAddressOpen(true);} else void createQuote();};
  const submit = async () => { await placeOrder(); };
  const loadOffers = async () => {if (!selectedAddress || !cart) return;setOffersLoading(true);setOffersError('');try {const result = await customerApi.coupons(await accessToken(),selectedAddress);setOffers({addressId:selectedAddress,version:cart.version,items:result.items});} catch {setOffersError('Couldn’t load offers.');} finally {setOffersLoading(false);}};
  const currentOffers = offers?.addressId === selectedAddress && offers.version === cart?.version ? offers.items : null;
  const itemSubtotal = useMemo(() => (cart?.lines ?? []).reduce((total,line) => total+BigInt(line.lineSubtotalPaise),0n).toString(), [cart?.lines]);
  const retryFees = useCallback(() => { void refreshDeliverySettings().catch(() => undefined); }, [refreshDeliverySettings]);
  // The displayed subtotal selects the band; the quote stays authoritative once it exists.
  const feeBand = !quote && feeEstimate && selectedAddress && cart?.lines.length ? lookupFeeBand(feeEstimate.bands, itemSubtotal) : null;
  const productsById = useMemo(() => new Map(products.map((product) => [product.variantId, product])), [products]);
  const quoteIssuesById = useMemo(() => new Map((quote?.quote.issues ?? []).map((issue) => [issue.variantId, issue])), [quote]);
  const quoteLinesById = useMemo(() => new Map((quote?.quote.lines ?? []).map((line) => [line.variantId, line])), [quote]);
  const cartIssuesById = useMemo(() => new Map(cart?.issues.map((issue) => [issue.variantId, issue])), [cart?.issues]);
  const expiryText = useMemo(() => quote ? new Intl.DateTimeFormat('en-IN', {hour:'numeric', minute:'2-digit', timeZone:'Asia/Kolkata'}).format(new Date(quote.intentExpiresAt)) : null, [quote]);
  const lines: ServerCart['lines'] = cart?.lines ?? EMPTY_LINES;
  const renderLine = useCallback(({ item: line }: { item: ServerCart['lines'][number] }) => {
    const item = productsById.get(line.variantId);
    const issue = quoteIssuesById.get(line.variantId) ?? (cartIssuesById.get(line.variantId)?.code === 'PRICE_CHANGED' ? cartIssuesById.get(line.variantId) : undefined);
    const freshPrice = quoteLinesById.get(line.variantId)?.unitPricePaise ?? line.currentUnitPricePaise;
    const available = issue?.code === 'QTY_REDUCED' ? Number(/quantity reduced to (\d+)/.exec(issue.detail ?? '')?.[1]) : NaN;
    return <CartLineItem variantId={line.variantId} name={line.productName ?? item?.name ?? 'Cart item'} variantName={line.variantName ?? item?.variantName ?? 'Product'} image={line.image ?? item?.images[0] ?? null} quantity={line.quantity} unitPricePaise={line.unitPricePaise} issueCode={issue?.code ?? null} freshPrice={freshPrice ?? null} available={available} locked={locked} saving={pendingVariantIds.includes(line.variantId)} undoable={undoVariantIds.includes(line.variantId)} updateCart={updateCart} undoCart={undoCart} />;
  }, [productsById, quoteIssuesById, quoteLinesById, cartIssuesById, locked, pendingVariantIds, undoVariantIds, updateCart, undoCart]);
  return <Screen><FlatList data={lines} keyExtractor={item => item.variantId} renderItem={renderLine} style={{flex:1}}
    contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12, flexGrow: 1 }]} showsVerticalScrollIndicator={false}
    refreshControl={<RefreshControl refreshing={cartRefreshing} onRefresh={() => void onCartRefresh()} tintColor={colors.green} />}
    ListHeaderComponent={<View style={{gap:12}}>
    <Heading title="Your cart" sub="Fresh picks, delivered to your door" /><ErrorBanner />
    {cartSyncFailed && <Button label="Retry saving cart" variant="soft" onPress={() => void retryCart()} />}
    {placed && lastOrder && placedCopy && <Card><AppText style={shared.label} accessibilityLiveRegion="polite">{placementOrderTitle(lastOrder)} · {placedCopy.title}</AppText><AppText style={shared.muted}>{placedCopy.detail}</AppText><View style={shared.row}>{lastOrder.orderId ? <Button label="View order" size="sm" variant="soft" onPress={() => router.push({ pathname: '/orders/[orderId]', params: { orderId: lastOrder.orderId } })} /> : null}<Button label="View orders" size="sm" variant="ghost" onPress={() => router.push('/my-dairy')} /></View></Card>}
    {locked && <Card><AppText style={shared.label} accessibilityLiveRegion="polite">{placing ? 'Placing order…' : 'Checking order…'}</AppText><AppText style={shared.muted}>{ORDER_CONFIRMATION_WAIT} You can keep browsing; this does not create another order.</AppText><Button label="View orders" variant="soft" size="sm" onPress={() => router.push('/my-dairy')} /></Card>}
    <Card><View style={shared.row}><Ionicons name="location-outline" size={20} color={colors.green} /><View style={{flex:1}}><AppText style={shared.label}>Deliver to</AppText><AppText style={shared.muted}>{address ? [address.line1, address.pincode].join(', ') : 'Select a delivery address'}</AppText></View><Button label="Change" variant="ghost" size="sm" disabled={locked} onPress={() => setAddressOpen(true)} /></View></Card>
    {locationNeeded && <Card><AppText style={shared.body}>Your address is saved. Confirm its location when you are there before reviewing your order.</AppText><Button label="Confirm address location" size="sm" variant="soft" disabled={locked} onPress={() => setAddressOpen(true)} /></Card>}
    {pendingPlacement && <Card><AppText style={shared.label}>Order confirmation pending</AppText><AppText style={shared.body}>We could not confirm the last request. Retry it safely using the same order request before starting another checkout.</AppText><Button label="Check or retry order" fullWidth loading={placing} onPress={() => void submit()} /></Card>}
    {lines.length > 0 && wrongAddress && <Card><AppText style={shared.body}>We’ll check availability for your selected address when you review the order.</AppText></Card>}
    </View>}
    ListEmptyComponent={<Card style={styles.empty}><Ionicons name="basket-outline" color={colors.green} size={40} /><AppText style={styles.emptyTitle}>Your cart is empty</AppText><AppText style={[shared.muted, {textAlign:'center'}]}>Explore the farm and find something fresh.</AppText><Button label="Browse the farm" style={{alignSelf:'center'}} onPress={() => router.push('/products')} /></Card>}
    ListFooterComponent={cart && lines.length ? <View style={{gap:12}}>
      {cart.issues.length > 0 && <Card><AppText style={shared.body}>Some items need attention. Review the order for current availability and prices.</AppText></Card>}
      <Card><AppText style={shared.label}>Offers</AppText>
        {!offersReady && <AppText style={shared.muted}>Review your order first to check offers for your address.</AppText>}
        {cart.couponCode ? <View style={shared.row}><AppText style={[shared.body,{flex:1}]}>Applied: {cart.couponCode}</AppText><Button label="Remove" variant="ghost" size="sm" disabled={locked || !offersReady} onPress={() => void changeCoupon(null)} /></View> : <>
          <View style={shared.row}><TextInput style={[shared.input,{flex:1}]} value={couponCode} onChangeText={setCouponCode} placeholder="Offer code" autoCapitalize="characters" maxLength={40} accessibilityLabel="Offer code" editable={!locked} /><Button label="Apply" variant="soft" size="sm" disabled={!couponCode.trim() || locked || !offersReady} onPress={() => void changeCoupon(couponCode)} /></View>
          <Button label="See available offers" variant="ghost" size="sm" loading={offersLoading} disabled={!offersReady || locked} onPress={() => void loadOffers()} />
          {!!offersError && <AppText style={styles.issue} accessibilityLiveRegion="polite">{offersError}</AppText>}{offersLoading && !currentOffers && <CardListSkeleton label="Loading available offers" count={2} />}
          {currentOffers && (currentOffers.length ? currentOffers.map(offer => <View key={offer.code} style={shared.row}><AppText style={[shared.body,{flex:1}]}>{offer.code} · {offer.kind === 'FREE_DELIVERY' ? 'Free delivery' : offer.kind === 'FLAT' ? `${formatPaise(offer.valuePaise)} off` : `${Number(offer.valuePaise)/100}% off`}</AppText><Button label="Apply" variant="soft" size="sm" disabled={locked} onPress={() => void changeCoupon(offer.code)} /></View>) : <AppText style={shared.muted}>No offers are currently available for this cart.</AppText>)}
        </>}
      </Card>
      <Card><AppText style={shared.label}>Payment method</AppText><View style={styles.paymentChoice}><Ionicons name="cash-outline" size={22} color={colors.green} /><View style={{flex:1}}><AppText style={shared.label}>Cash on delivery</AppText><AppText style={shared.muted}>{!quote ? 'Availability confirmed when you review your order' : !quote.codAvailable ? 'Unavailable for this order' : 'Pay when your order arrives'}</AppText></View><Ionicons name={quote && !quote.codAvailable ? 'radio-button-off' : 'radio-button-on'} size={20} color={colors.green} /></View><Pressable style={styles.paymentChoice} accessibilityRole="button" accessibilityLabel="Online payments" onPress={() => setShowOnlineInfo(true)}><Ionicons name="card-outline" size={22} color={colors.brown} /><View style={{flex:1}}><AppText style={shared.label}>Online payments</AppText><AppText style={shared.muted}>Coming soon</AppText></View><Ionicons name="chevron-forward" size={18} color={colors.textSecondary} /></Pressable>{showOnlineInfo && <AppText style={shared.body}>We’re currently working on online payments.</AppText>}</Card>
      <Card><AppText style={shared.label}>Order summary</AppText>{quote ? <><MoneyRow label="Items" value={quote.quote.subtotalPaise} />{quote.quote.fees.map((fee, index) => <MoneyRow key={`${fee.kind}-${index}`} label={fee.kind.replaceAll('_', ' ').toLowerCase()} value={fee.amountPaise} />)}<MoneyRow label="Tax included" value={quote.quote.taxTotalPaise} />{BigInt(quote.quote.discountPaise) > 0n && <MoneyRow label="Discount" value={`-${quote.quote.discountPaise}`} />}<MoneyRow label="Total" value={quote.quote.totalPaise} />{quote.quote.wallet && BigInt(quote.quote.wallet.cashPaise) + BigInt(quote.quote.wallet.promoPaise) > 0n && <MoneyRow label="Wallet applied" value={`-${BigInt(quote.quote.wallet.cashPaise) + BigInt(quote.quote.wallet.promoPaise)}`} />}<MoneyRow label="Due on delivery" value={quote.quote.amountDuePaise} />{quote.quote.issues.map((issue,index) => <AppText key={`${issue.code}-${index}`} style={styles.issue} accessibilityLiveRegion="polite">{issue.code === 'PRICE_CHANGED' ? 'A product price changed. Please review it above.' : issue.code === 'ITEM_UNAVAILABLE' ? 'An item is unavailable at this address. Please review it above.' : issue.code === 'QTY_REDUCED' ? 'An item has less stock than requested. Please review it above.' : issue.detail ?? issue.code.replaceAll('_',' ').toLowerCase()}</AppText>)}<AppText style={shared.muted}>Quote expires {expiryText}. {quote.quote.amountDuePaise === '0' ? 'No payment due on delivery.' : quote.codAvailable ? 'Payment: cash on delivery.' : 'Cash on delivery is unavailable.'}</AppText></> : <><MoneyRow label="Items" value={itemSubtotal} />
        {!selectedAddress ? <>
          <AppText style={shared.muted}>Choose a delivery address to see estimated delivery charges.</AppText>
          <Button label="Choose address" variant="soft" size="sm" disabled={locked} onPress={() => setAddressOpen(true)} />
        </> : feeBand ? <>
          <MoneyRow label="Estimated charges before offers" value={feeBandTotalPaise(feeBand)} />
          <AppText style={shared.muted}>Delivery {formatPaise(feeBand.deliveryPaise)} · handling {formatPaise(feeBand.handlingPaise)}{BigInt(feeBand.smallCartPaise) > 0n ? ` · small cart ${formatPaise(feeBand.smallCartPaise)}` : ''}{BigInt(feeBand.surgePaise) > 0n ? ` · surge ${formatPaise(feeBand.surgePaise)}` : ''}. Final fees are confirmed when you review.</AppText>
          {!!feeError && <View style={shared.row}><AppText style={[shared.muted,{flex:1}]}>{feeError}</AppText><Button label="Retry" variant="soft" size="sm" onPress={retryFees} /></View>}
        </> : <>
          <AppText style={shared.muted}>Review your order to check delivery fees and availability.</AppText>
          {feeLoading && <View style={styles.saving} accessibilityLabel="Checking delivery charges" accessibilityState={{busy:true}}><ActivityIndicator size="small" color={colors.green} /><AppText style={shared.muted}>Checking delivery charges…</AppText></View>}
          {!!feeError && !feeLoading && <View style={shared.row}><AppText style={[shared.muted,{flex:1}]}>{feeError}</AppText><Button label="Retry" variant="soft" size="sm" onPress={retryFees} /></View>}
        </>}
        {reviewing && reviewSlow && <AppText style={shared.muted} accessibilityLiveRegion="polite">Reviewing your order…</AppText>}</>}
      {cartSyncFailed && <View style={shared.row}><AppText style={[shared.muted,{flex:1}]}>Some cart changes are waiting to be saved.</AppText><Button label="Retry" variant="soft" size="sm" onPress={() => void retryCart()} /></View>}
      {!!checkoutError && <AppText style={styles.issue} accessibilityLiveRegion="polite">{checkoutError}</AppText>}
      {!!quote?.quote.referralClaimId && <AppText style={shared.muted}>Your referral free delivery is applied to this order.</AppText>}
      {quote && !quote.codAvailable && <AppText style={styles.issue} accessibilityLiveRegion="polite">Cash on delivery is not available for this order.</AppText>}
      <Button label={quote ? 'Refresh order summary' : 'Review order'} variant="soft" fullWidth loading={reviewing} disabled={locked || pendingVariantIds.length > 0} onPress={review} />
      {quote && <Button label={quote.quote.amountDuePaise === '0' ? 'Place order' : 'Place cash on delivery order'} fullWidth loading={placing} disabled={locked || cartBusy || !quote.codAvailable || quote.quote.issues.length > 0 || wrongAddress} onPress={() => void submit()} />}
      {locked && <AppText style={shared.muted} accessibilityLiveRegion="polite">{failed ? checkoutError : ORDER_CONFIRMATION_WAIT}</AppText>}
      </Card>
    </View> : undefined}
  /><AddressPanel visible={addressOpen} onClose={() => {setAddressOpen(false);setResumeCheckout(false);}} onLocationConfirmed={() => {if (resumeCheckout) {setResumeCheckout(false);void createQuote();}}} /></Screen>;
}
const styles = StyleSheet.create({
  moneyRow: {flexDirection:'row', justifyContent:'space-between', gap:12},
  empty: {alignItems:'center', paddingVertical:30}, emptyTitle: {fontFamily:fonts.semibold, fontSize:17, color:colors.brownDark},
  saving: {flexDirection:'row', alignItems:'center', gap:6, marginTop:2},
  stepper: {flexDirection:'row', alignItems:'center', backgroundColor:colors.greenSoft, borderRadius:30},
  sideCol: {alignItems:'flex-end', gap:2},
  thumbnail: {width:58,height:68,borderRadius:12,backgroundColor:colors.greenIce,alignItems:'center',justifyContent:'center'}, thumbnailImage:{width:'100%',height:'100%'},
  paymentChoice: {flexDirection:'row',alignItems:'center',gap:10,paddingVertical:7},
  price: {fontFamily:fonts.semibold, color:colors.green, fontSize:13, marginTop:4}, issue: {color:colors.danger, fontSize:12},
});
