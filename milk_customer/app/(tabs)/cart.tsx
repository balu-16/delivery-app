import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { AddressPanel } from '@/components/connected/AddressPanel';
import { Card, ErrorBanner, formatPaise, Heading, shared } from '@/components/connected/Shared';
import { useProductPhoto } from '@/components/connected/useProductPhoto';
import { colors, fonts } from '@/constants/theme';
import { useCustomer } from '@/src/store/customer';
import { customerApi, type Coupon } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';

function MoneyRow({ label, value }: { label: string; value: string }) {
  return <View style={styles.moneyRow}><AppText style={shared.body}>{label}</AppText><AppText style={shared.label}>{formatPaise(value)}</AppText></View>;
}
function CartPhoto({path, name}: {path:string | null | undefined; name:string}) {
  const photo = useProductPhoto(path, name);
  return <View style={styles.thumbnail}>{photo.source ? <Image source={photo.source} onError={photo.onError} style={styles.thumbnailImage} contentFit="contain" accessibilityLabel={photo.illustrative ? `${name}, illustration` : name} /> : <Ionicons name="leaf-outline" size={24} color={colors.green} />}</View>;
}
export default function Cart() {
  const insets = useSafeAreaInsets();
  const [addressOpen, setAddressOpen] = useState(false);
  const [placed, setPlaced] = useState(false);
  const [showOnlineInfo, setShowOnlineInfo] = useState(false);
  const [couponCode,setCouponCode] = useState(''), [offers,setOffers] = useState<{addressId:string;version:number;items:Coupon[]} | null>(null), [offersLoading,setOffersLoading] = useState(false), [offersError,setOffersError] = useState('');
  const { cart, cartBusy, products, quote, pendingPlacement, busy, selectedAddress, addresses, updateCart, changeCoupon, createQuote, placeOrder } = useCustomer();
  const address = addresses.find(item => item.id === selectedAddress);
  const wrongAddress = !!cart && cart.addressId !== selectedAddress;
  const submit = async () => { if (await placeOrder()) setPlaced(true); };
  const loadOffers = async () => {if (!selectedAddress || !cart) return;setOffersLoading(true);setOffersError('');try {const result = await customerApi.coupons(await accessToken(),selectedAddress);setOffers({addressId:selectedAddress,version:cart.version,items:result.items});} catch {setOffersError('Could not load offers. Please try again.');} finally {setOffersLoading(false);}};
  const currentOffers = offers?.addressId === selectedAddress && offers.version === cart?.version ? offers.items : null;
  return <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
    <Heading title="Your cart" sub="Fresh picks, delivered to your door" /><ErrorBanner />
    {placed && <Card><AppText style={shared.label}>Order placed</AppText><AppText style={shared.muted}>You can follow its progress in My Dairy.</AppText><Button label="View orders" size="sm" variant="soft" onPress={() => router.push('/my-dairy')} /></Card>}
    <Card><View style={shared.row}><Ionicons name="location-outline" size={20} color={colors.green} /><View style={{flex:1}}><AppText style={shared.label}>Deliver to</AppText><AppText style={shared.muted}>{address ? [address.line1, address.pincode].join(', ') : 'Select a delivery address'}</AppText></View><Button label="Change" variant="ghost" size="sm" onPress={() => setAddressOpen(true)} /></View></Card>
    {pendingPlacement && <Card><AppText style={shared.label}>Order confirmation pending</AppText><AppText style={shared.body}>We could not confirm the last request. Retry it safely using the same order request before starting another checkout.</AppText><Button label="Check or retry order" fullWidth loading={busy} onPress={() => void submit()} /></Card>}
    {!cart?.lines.length ? <Card style={styles.empty}><Ionicons name="basket-outline" color={colors.green} size={40} /><AppText style={styles.emptyTitle}>Your cart is empty</AppText><AppText style={[shared.muted, {textAlign:'center'}]}>Explore the farm and find something fresh.</AppText><Button label="Browse the farm" style={{alignSelf:'center'}} onPress={() => router.push('/products')} /></Card> : <>
      {wrongAddress && <Card><AppText style={shared.body}>Your cart was built for another address. Review availability and pricing at this address before changing quantities.</AppText><Button label="Review cart" variant="soft" size="sm" onPress={() => void createQuote()} disabled={busy || !!pendingPlacement} /></Card>}
      {cart.lines.map(line => {
        const item = products.find(product => product.variantId === line.variantId);
        const name = line.productName ?? item?.name ?? 'Cart item';
        const issue = quote?.quote.issues.find(value => value.variantId === line.variantId && (value.code === 'PRICE_CHANGED' || value.code === 'QTY_REDUCED'));
        const fresh = quote?.quote.lines.find(value => value.variantId === line.variantId);
        return <Card key={line.variantId}>
          <View style={shared.row}>
            <CartPhoto path={line.image ?? item?.images[0]} name={name} />
            <View style={{flex:1}}><AppText style={shared.label}>{name}</AppText><AppText style={shared.muted}>{line.variantName ?? item?.variantName ?? 'Product'}</AppText><AppText style={styles.price}>{formatPaise(line.unitPricePaise)} each</AppText></View>
            <View style={styles.stepper}><Button size="sm" variant="ghost" label="−" accessibilityLabel={`Remove one ${name}`} onPress={() => void updateCart(line.variantId, -1)} disabled={cartBusy || wrongAddress || !!pendingPlacement} /><AppText style={shared.label}>{line.quantity}</AppText><Button size="sm" variant="ghost" label="+" accessibilityLabel={`Add one ${name}`} onPress={() => void updateCart(line.variantId, 1)} disabled={cartBusy || wrongAddress || !!pendingPlacement} /></View>
          </View>
          {issue && <><AppText style={shared.muted}>{issue.code === 'PRICE_CHANGED' && fresh ? `Current price: ${formatPaise(fresh.unitPricePaise)} each.` : 'The requested quantity is no longer available.'}</AppText><Button label={issue.code === 'PRICE_CHANGED' ? 'Accept updated price' : 'Accept available quantity'} size="sm" variant="soft" disabled={cartBusy || wrongAddress || !!pendingPlacement} onPress={() => void updateCart(line.variantId, 0)} /></>}
        </Card>;
      })}
      {cart.issues.length > 0 && <Card><AppText style={shared.body}>Some items need attention. Review the order for current availability and prices.</AppText></Card>}
      <Card><AppText style={shared.label}>Offers</AppText>{cart.couponCode ? <View style={shared.row}><AppText style={[shared.body,{flex:1}]}>Applied: {cart.couponCode}</AppText><Button label="Remove" variant="ghost" size="sm" disabled={cartBusy || !!pendingPlacement || wrongAddress} onPress={() => void changeCoupon(null)} /></View> : <><View style={shared.row}><TextInput style={[shared.input,{flex:1}]} value={couponCode} onChangeText={setCouponCode} placeholder="Offer code" autoCapitalize="characters" maxLength={40} accessibilityLabel="Offer code" /><Button label="Apply" variant="soft" size="sm" disabled={!couponCode.trim() || cartBusy || !!pendingPlacement || wrongAddress} onPress={() => void changeCoupon(couponCode)} /></View><Button label="See available offers" variant="ghost" size="sm" loading={offersLoading} disabled={wrongAddress || !!pendingPlacement} onPress={() => void loadOffers()} />{!!offersError && <AppText style={styles.issue}>{offersError}</AppText>}{currentOffers && (currentOffers.length ? currentOffers.map(offer => <View key={offer.code} style={shared.row}><AppText style={[shared.body,{flex:1}]}>{offer.code} · {offer.kind === 'FREE_DELIVERY' ? 'Free delivery' : offer.kind === 'FLAT' ? `${formatPaise(offer.valuePaise)} off` : `${Number(offer.valuePaise)/100}% off`}</AppText><Button label="Apply" variant="soft" size="sm" disabled={cartBusy || !!pendingPlacement} onPress={() => void changeCoupon(offer.code)} /></View>) : <AppText style={shared.muted}>No offers are currently available for this cart.</AppText>)}</>}</Card>
      <Card><AppText style={shared.label}>Payment method</AppText><View style={styles.paymentChoice}><Ionicons name="cash-outline" size={22} color={colors.green} /><View style={{flex:1}}><AppText style={shared.label}>Cash on delivery</AppText><AppText style={shared.muted}>{!quote ? 'Availability confirmed when you review your order' : !quote.codAvailable ? 'Unavailable for this order' : 'Pay when your order arrives'}</AppText></View><Ionicons name={quote && !quote.codAvailable ? 'radio-button-off' : 'radio-button-on'} size={20} color={colors.green} /></View><Pressable style={styles.paymentChoice} accessibilityRole="button" accessibilityLabel="Online payments" onPress={() => setShowOnlineInfo(true)}><Ionicons name="card-outline" size={22} color={colors.brown} /><View style={{flex:1}}><AppText style={shared.label}>Online payments</AppText><AppText style={shared.muted}>Coming soon</AppText></View><Ionicons name="chevron-forward" size={18} color={colors.textSecondary} /></Pressable>{showOnlineInfo && <AppText style={shared.body}>We’re currently working on online payments.</AppText>}</Card>
      <Card><AppText style={shared.label}>Order summary</AppText>{quote ? <><MoneyRow label="Items" value={quote.quote.subtotalPaise} />{quote.quote.fees.map((fee, index) => <MoneyRow key={`${fee.kind}-${index}`} label={fee.kind.replaceAll('_', ' ').toLowerCase()} value={fee.amountPaise} />)}<MoneyRow label="Tax" value={quote.quote.taxTotalPaise} />{BigInt(quote.quote.discountPaise) > 0n && <MoneyRow label="Discount" value={`-${quote.quote.discountPaise}`} />}<MoneyRow label="Total" value={quote.quote.totalPaise} />{quote.quote.wallet && BigInt(quote.quote.wallet.cashPaise) + BigInt(quote.quote.wallet.promoPaise) > 0n && <MoneyRow label="Wallet applied" value={`-${BigInt(quote.quote.wallet.cashPaise) + BigInt(quote.quote.wallet.promoPaise)}`} />}<MoneyRow label="Due on delivery" value={quote.quote.amountDuePaise} />{quote.quote.issues.map((issue,index) => <AppText key={`${issue.code}-${index}`} style={styles.issue}>{issue.detail ?? issue.code.replaceAll('_',' ').toLowerCase()}</AppText>)}<AppText style={shared.muted}>Quote expires {new Intl.DateTimeFormat('en-IN', {hour:'numeric', minute:'2-digit', timeZone:'Asia/Kolkata'}).format(new Date(quote.intentExpiresAt))}. {quote.quote.amountDuePaise === '0' ? 'No payment due on delivery.' : quote.codAvailable ? 'Payment: cash on delivery.' : 'Cash on delivery is unavailable.'}</AppText></> : <AppText style={shared.muted}>Review your order to see current prices, fees and availability.</AppText>}
      <Button label={quote ? 'Refresh order summary' : 'Review order'} variant="soft" fullWidth loading={busy && !pendingPlacement} disabled={cartBusy || !!pendingPlacement} onPress={() => void createQuote()} />
      {!!quote?.quote.referralClaimId && <AppText style={shared.muted}>Your referral free delivery is applied to this order.</AppText>}
      {quote && !quote.codAvailable && <AppText style={styles.issue}>Cash on delivery is not available for this order.</AppText>}
      {quote && <Button label={quote.quote.amountDuePaise === '0' ? 'Place order' : 'Place cash on delivery order'} fullWidth loading={busy} disabled={cartBusy || !!pendingPlacement || !quote.codAvailable || quote.quote.issues.length > 0 || wrongAddress} onPress={() => void submit()} />}
      </Card>
    </>}
  </ScrollView><AddressPanel visible={addressOpen} onClose={() => setAddressOpen(false)} /></Screen>;
}
const styles = StyleSheet.create({
  moneyRow: {flexDirection:'row', justifyContent:'space-between', gap:12},
  empty: {alignItems:'center', paddingVertical:30}, emptyTitle: {fontFamily:fonts.semibold, fontSize:17, color:colors.brownDark},
  stepper: {flexDirection:'row', alignItems:'center', backgroundColor:colors.greenSoft, borderRadius:30},
  thumbnail: {width:58,height:68,borderRadius:12,backgroundColor:colors.greenIce,alignItems:'center',justifyContent:'center'}, thumbnailImage:{width:'100%',height:'100%'},
  paymentChoice: {flexDirection:'row',alignItems:'center',gap:10,paddingVertical:7},
  price: {fontFamily:fonts.semibold, color:colors.green, fontSize:13, marginTop:4}, issue: {color:colors.danger, fontSize:12},
});
