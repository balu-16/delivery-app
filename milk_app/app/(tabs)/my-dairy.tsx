import { useFocusEffect, router } from 'expo-router';
import { useCallback, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Card, ErrorBanner, formatPaise, Heading, shared } from '@/components/connected/Shared';
import { SubscriptionManagement } from '@/components/connected/SubscriptionManagement';
import { colors, fonts } from '@/constants/theme';
import { customerDetailsApi, type CustomerOrder, type CustomerSubscription } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { startOrderRealtime } from '@/src/orderRealtime';
import { useCustomer } from '@/src/store/customer';

const date = (value: string) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat('en-IN', { day:'numeric', month:'short', year:'numeric', timeZone:'Asia/Kolkata' }).format(d); };
const label = (value: string) => value.replaceAll('_', ' ').toLowerCase();
const openStatus = (status: string) => ['CONFIRMED', 'PICKING', 'PACKED', 'OUT_FOR_DELIVERY'].includes(status);
export default function MyDairy() {
  const insets = useSafeAreaInsets();
  const { orders, subscriptions, products, pendingSubscription, pendingSubscriptionAction, createSubscription, runSubscriptionAction, loadActivity, cancelOrder, reorder, busy } = useCustomer();
  const [selected, setSelected] = useState<CustomerOrder | null>(null);
  const [selectedSubscription, setSelectedSubscription] = useState<CustomerSubscription | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false), [tracking, setTracking] = useState(''), [code, setCode] = useState('');
  const [loading, setLoading] = useState(true);
  useFocusEffect(useCallback(() => { let active = true; void loadActivity().finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [loadActivity]));
  const orderId = selected?.orderId;
  useFocusEffect(useCallback(() => {
    if (!orderId) return;
    let active = true;
    const refresh = async () => {
      try { const data = await customerDetailsApi.tracking(await accessToken(), orderId); if (active) setTracking(data.eta ? `${label(data.taskStatus)} · ${data.eta.minMinutes}–${data.eta.maxMinutes} min` : label(data.taskStatus)); }
      catch { if (active) setTracking('Tracking will appear when a delivery partner is assigned.'); }
    };
    void refresh();
    let stopSocket: (() => void) | undefined;
    try { stopSocket = startOrderRealtime(orderId, () => void refresh(), () => {
      void refresh(); void loadActivity(); void accessToken().then(token => customerDetailsApi.order(token, orderId)).then(order => { if (active) setSelected(current => current?.orderId === orderId ? order : current); }).catch(() => {});
    }); } catch { /* polling remains available */ }
    const timer = setInterval(() => void refresh(), 30000);
    return () => { active = false; clearInterval(timer); stopSocket?.(); };
  }, [orderId, loadActivity]));
  const open = (order: CustomerOrder) => { setTracking(''); setCode(''); setConfirmCancel(false); setSelected(order); void accessToken().then(token => customerDetailsApi.order(token, order.orderId)).then(detail => setSelected(current => current?.orderId === detail.orderId ? detail : current)).catch(() => {}); };
  const showCode = async () => { if (!orderId) return; try { const result = await customerDetailsApi.deliveryCode(await accessToken(), orderId); setCode(result.code); } catch { setCode('A delivery code is not available yet.'); } };
  return <Screen><ScrollView contentContainerStyle={[shared.scroll, {paddingTop:insets.top+12}]} showsVerticalScrollIndicator={false}>
    <Heading title="My Dairy" sub="Your orders in one place" /><ErrorBanner />
    <View style={shared.row}><AppText style={styles.section}>Orders</AppText><Button label="Refresh" variant="ghost" size="sm" onPress={() => void loadActivity()} /></View>
    {loading ? <AppText style={shared.muted}>Loading orders…</AppText> : orders.length === 0 ? <Card><AppText style={shared.label}>No orders yet</AppText><AppText style={shared.muted}>Your fresh deliveries will appear here.</AppText><Button label="Explore products" variant="soft" size="sm" onPress={() => router.push('/products')} /></Card> : orders.map(order => <Card key={order.orderId}><View style={shared.row}><View style={{flex:1}}><AppText style={shared.label}>Order {order.orderNumber}</AppText><AppText style={shared.muted}>{date(order.placedAt)} · {label(order.status)}</AppText></View><AppText style={styles.total}>{formatPaise(order.totalPaise)}</AppText></View><Button label="View details" variant="soft" size="sm" onPress={() => open(order)} /></Card>)}
    {!!(pendingSubscription || pendingSubscriptionAction || subscriptions.length) && <><AppText style={styles.section}>Subscriptions</AppText>
    {pendingSubscription && <Card><AppText style={shared.label}>Subscription confirmation pending</AppText><AppText style={shared.body}>Retry the same request to check whether it was created.</AppText><Button label="Check or retry" fullWidth loading={busy} onPress={() => void createSubscription()} /></Card>}
    {pendingSubscriptionAction && <Card><AppText style={shared.label}>Subscription change pending</AppText><AppText style={shared.body}>Check the previous request before making another change.</AppText><Button label="Check or retry change" fullWidth loading={busy} onPress={() => void runSubscriptionAction()} /></Card>}
    {subscriptions.map(sub => <Card key={sub.id}><AppText style={shared.label}>{products.find(item => item.variantId === sub.variant_id)?.name ?? 'Dairy subscription'}</AppText><AppText style={shared.muted}>{label(sub.status)} · Next delivery: {sub.next_delivery_date ? date(sub.next_delivery_date) : 'not scheduled'}</AppText><Button label="Manage" size="sm" variant="soft" onPress={() => setSelectedSubscription(sub)} /></Card>)}</>}
  </ScrollView><BottomSheet visible={!!selected} onClose={() => setSelected(null)} title={selected ? `Order ${selected.orderNumber}` : 'Order'} subtitle={selected ? `${date(selected.placedAt)} · ${label(selected.status)}` : undefined}>
    {selected && <View style={{gap:10}}><ErrorBanner />{selected.items.map(item => <View key={item.id} style={styles.moneyRow}><AppText style={shared.body}>{item.name} × {item.orderedQty}</AppText><AppText style={shared.body}>{formatPaise(item.unitPricePaise)} each</AppText></View>)}<View style={styles.moneyRow}><AppText style={shared.label}>Total</AppText><AppText style={shared.label}>{formatPaise(selected.totalPaise)}</AppText></View><AppText style={shared.muted}>Payment: {label(selected.paymentStatus)}</AppText>
      {openStatus(selected.status) && <><AppText style={shared.label}>Delivery progress</AppText><AppText style={shared.body}>{tracking || 'Checking delivery progress…'}</AppText><Button label="Show delivery code" variant="soft" size="sm" onPress={() => void showCode()} />{!!code && <AppText style={shared.label}>{code}</AppText>}</>}
      {['CONFIRMED', 'PENDING_PAYMENT'].includes(selected.status) && (confirmCancel ? <><AppText style={shared.body}>Cancel this order?</AppText><View style={shared.row}><Button label="Yes, cancel" size="sm" loading={busy} onPress={() => void cancelOrder(selected.orderId).then(() => { setSelected(null); setConfirmCancel(false); })} /><Button label="Keep order" variant="ghost" size="sm" onPress={() => setConfirmCancel(false)} /></View></> : <Button label="Cancel order" variant="outline" size="sm" onPress={() => setConfirmCancel(true)} />)}
      <Button label="Add items to cart again" variant="soft" fullWidth loading={busy} onPress={() => void reorder(selected.orderId).then(() => { setSelected(null); router.push('/cart'); })} />
    </View>}
  </BottomSheet>{selectedSubscription && <SubscriptionManagement key={selectedSubscription.id} subscription={selectedSubscription} name={products.find(item => item.variantId === selectedSubscription.variant_id)?.name ?? 'Dairy subscription'} onClose={() => setSelectedSubscription(null)} />}</Screen>;
}
const styles = StyleSheet.create({ section:{fontFamily:fonts.semibold,fontSize:17,color:colors.brownDark,flex:1}, total:{fontFamily:fonts.semibold,color:colors.green}, moneyRow:{flexDirection:'row',justifyContent:'space-between',gap:12} });
