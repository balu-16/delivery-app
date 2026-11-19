import { useFocusEffect, router } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Card, ErrorBanner, formatPaise, Heading, shared } from '@/components/connected/Shared';
import { SubscriptionManagement } from '@/components/connected/SubscriptionManagement';
import { CardListSkeleton, SkeletonBlock } from '@/components/animations/Skeleton';
import { colors, fonts } from '@/constants/theme';
import { customerDetailsApi, type CustomerOrder, type CustomerSubscription } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { startOrderRealtime } from '@/src/orderRealtime';
import { useCustomer } from '@/src/store/customer';
import { useRefresh } from '@/hooks/useRefresh';

const date = (value: string) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? value : dateFormatter.format(d); };
const label = (value: string) => value.replaceAll('_', ' ').toLowerCase();
const openStatus = (status: string) => ['CONFIRMED', 'PICKING', 'PACKED', 'OUT_FOR_DELIVERY'].includes(status);
const dateFormatter = new Intl.DateTimeFormat('en-IN', { day:'numeric', month:'short', year:'numeric', timeZone:'Asia/Kolkata' });
export default function MyDairy() {
  const insets = useSafeAreaInsets();
  const orders = useCustomer(state => state.orders);
  const subscriptions = useCustomer(state => state.subscriptions);
  const products = useCustomer(state => state.products);
  const pendingSubscription = useCustomer(state => state.pendingSubscription);
  const pendingSubscriptionAction = useCustomer(state => state.pendingSubscriptionAction);
  const createSubscription = useCustomer(state => state.createSubscription);
  const runSubscriptionAction = useCustomer(state => state.runSubscriptionAction);
  const loadActivity = useCustomer(state => state.loadActivity);
  const cancelOrder = useCustomer(state => state.cancelOrder);
  const reorder = useCustomer(state => state.reorder);
  const busy = useCustomer(state => state.orderBusyId !== null);
  const orderBusyId = useCustomer(state => state.orderBusyId);
  const activityLoad = useCustomer(state => state.activityLoad);
  const productsById = useMemo(() => new Map(products.map((product) => [product.variantId, product])), [products]);
  const [selected, setSelected] = useState<CustomerOrder | null>(null);
  const [selectedSubscription, setSelectedSubscription] = useState<CustomerSubscription | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false), [tracking, setTracking] = useState(''), [code, setCode] = useState('');
  const [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState(false);
  const detailRequest = useRef(0);
  useFocusEffect(useCallback(() => { void loadActivity({silent:false}); }, [loadActivity]));
  const { refreshing: dairyRefreshing, onRefresh: onDairyRefresh } = useRefresh(() => loadActivity({silent:true}));
  const orderId = selected?.orderId;
  useFocusEffect(useCallback(() => {
    if (!orderId) return;
    let active = true;
    let lastRefresh = 0;
    const refresh = async () => {
      const now = Date.now();
      if (now - lastRefresh < 10000) return;
      lastRefresh = now;
      try { const data = await customerDetailsApi.tracking(await accessToken(), orderId); if (active) setTracking(data.eta ? `${label(data.taskStatus)} · ${data.eta.minMinutes}–${data.eta.maxMinutes} min` : label(data.taskStatus)); }
      catch { if (active) setTracking('Tracking will appear when a delivery partner is assigned.'); }
    };
    void refresh();
    let stopSocket: (() => void) | undefined;
    try { stopSocket = startOrderRealtime(orderId, () => void refresh(), () => {
      void refresh(); void loadActivity({silent:true}); void accessToken().then(token => customerDetailsApi.order(token, orderId)).then(order => { if (active) setSelected(current => current?.orderId === orderId ? order : current); }).catch(() => {});
    }); } catch { /* polling remains available */ }
    const timer = setInterval(() => void refresh(), 30000);
    return () => { active = false; clearInterval(timer); stopSocket?.(); };
  }, [orderId, loadActivity]));
  const open = (order: CustomerOrder) => {
    const request = ++detailRequest.current;
    setTracking(''); setCode(''); setConfirmCancel(false); setSelected(order); setDetailLoading(true); setDetailError(false);
    void accessToken().then(token => customerDetailsApi.order(token, order.orderId))
      .then(detail => { if (request === detailRequest.current) setSelected(current => current?.orderId === detail.orderId ? detail : current); })
      .catch(() => { if (request === detailRequest.current) setDetailError(true); })
      .finally(() => { if (request === detailRequest.current) setDetailLoading(false); });
  };
  const showCode = async () => { if (!orderId) return; try { const result = await customerDetailsApi.deliveryCode(await accessToken(), orderId); setCode(result.code); } catch { setCode('A delivery code is not available yet.'); } };
  const { refreshing: detailRefreshing, onRefresh: onDetailRefresh } = useRefresh(async () => { const current = useCustomer.getState().orders.find(item => item.orderId === orderId) ?? selected; if (current) await open(current); });
  return <Screen><ScrollView contentContainerStyle={[shared.scroll, {paddingTop:insets.top+12, flexGrow: 1}]} showsVerticalScrollIndicator={false}
    refreshControl={<RefreshControl refreshing={dairyRefreshing} onRefresh={() => void onDairyRefresh()} tintColor={colors.green} />}>
    <Heading title="My Dairy" sub="Your orders in one place" /><ErrorBanner />
    <AppText style={styles.section}>Orders</AppText>
    {activityLoad.orders === 'idle' || activityLoad.orders === 'loading' ? <CardListSkeleton label="Loading orders" /> : activityLoad.orders === 'error' ? <Card><AppText style={shared.body}>Couldn’t load orders.</AppText><Button label="Try again" variant="soft" size="sm" onPress={() => void loadActivity()} /></Card> : orders.length === 0 ? <Card><AppText style={shared.label}>No orders yet</AppText><AppText style={shared.muted}>Your fresh deliveries will appear here.</AppText><Button label="Explore products" variant="soft" size="sm" onPress={() => router.push('/products')} /></Card> : orders.map(order => <Card key={order.orderId}><View style={shared.row}><View style={{flex:1}}><AppText style={shared.label}>Order {order.orderNumber}</AppText><AppText style={shared.muted}>{date(order.placedAt)} · {label(order.status)}</AppText></View><AppText style={styles.total}>{formatPaise(order.totalPaise)}</AppText></View><Button label="View details" variant="soft" size="sm" onPress={() => open(order)} /></Card>)}
    {!!(pendingSubscription || pendingSubscriptionAction || subscriptions.length || activityLoad.subscriptions !== 'success') && <><AppText style={styles.section}>Subscriptions</AppText>
    {pendingSubscription && <Card><AppText style={shared.label}>Subscription confirmation pending</AppText><AppText style={shared.body}>Retry the same request to check whether it was created.</AppText><Button label="Check or retry" fullWidth loading={busy} onPress={() => void createSubscription()} /></Card>}
    {pendingSubscriptionAction && <Card><AppText style={shared.label}>Subscription change pending</AppText><AppText style={shared.body}>Check the previous request before making another change.</AppText><Button label="Check or retry change" fullWidth loading={busy} onPress={() => void runSubscriptionAction()} /></Card>}
    {activityLoad.subscriptions === 'idle' || activityLoad.subscriptions === 'loading' ? <CardListSkeleton label="Loading subscriptions" count={2} /> : activityLoad.subscriptions === 'error' ? <Card><AppText style={shared.body}>Couldn’t load subscriptions.</AppText><Button label="Try again" variant="soft" size="sm" onPress={() => void loadActivity()} /></Card> : subscriptions.map(sub => <Card key={sub.id}><AppText style={shared.label}>{productsById.get(sub.variant_id)?.name ?? 'Dairy subscription'}</AppText><AppText style={shared.muted}>{label(sub.status)} · Next delivery: {sub.next_delivery_date ? date(sub.next_delivery_date) : 'not scheduled'}</AppText><Button label="Manage" size="sm" variant="soft" onPress={() => setSelectedSubscription(sub)} /></Card>)}</>}
  </ScrollView><BottomSheet visible={!!selected} onClose={() => { detailRequest.current++; setSelected(null); }} title={selected ? `Order ${selected.orderNumber}` : 'Order'} subtitle={selected ? `${date(selected.placedAt)} · ${label(selected.status)}` : undefined} refreshControl={<RefreshControl refreshing={detailRefreshing} onRefresh={() => void onDetailRefresh()} tintColor={colors.green} />}>
    {detailLoading ? <CardListSkeleton label="Loading order details" count={2} /> : detailError && selected ? <View style={{gap:10}}><AppText style={shared.body}>Couldn’t load order details.</AppText><Button label="Try again" variant="soft" onPress={() => open(selected)} /></View> : selected && <View style={{gap:10}}><ErrorBanner />{selected.items.map(item => <View key={item.id} style={styles.moneyRow}><AppText style={shared.body}>{item.name} × {item.orderedQty}</AppText><AppText style={shared.body}>{formatPaise(item.unitPricePaise)} each</AppText></View>)}<View style={styles.moneyRow}><AppText style={shared.label}>Total</AppText><AppText style={shared.label}>{formatPaise(selected.totalPaise)}</AppText></View><AppText style={shared.muted}>Payment: {label(selected.paymentStatus)}</AppText>
      {openStatus(selected.status) && <><AppText style={shared.label}>Delivery progress</AppText>{tracking ? <AppText style={shared.body}>{tracking}</AppText> : <View accessible accessibilityLabel="Loading delivery progress" accessibilityState={{busy:true}}><SkeletonBlock width="75%" height={14} /></View>}<Button label="Show delivery code" variant="soft" size="sm" onPress={() => void showCode()} />{!!code && <AppText style={shared.label}>{code}</AppText>}</>}
      {['CONFIRMED', 'PENDING_PAYMENT'].includes(selected.status) && (confirmCancel ? <><AppText style={shared.body}>Cancel this order?</AppText><View style={shared.row}><Button label="Yes, cancel" size="sm" loading={busy && orderBusyId===selected.orderId} disabled={busy && orderBusyId!==selected.orderId} onPress={() => void cancelOrder(selected.orderId).then((ok) => { if (ok) { setSelected(null); setConfirmCancel(false); } })} /><Button label="Keep order" variant="ghost" size="sm" onPress={() => setConfirmCancel(false)} /></View></> : <Button label="Cancel order" variant="outline" size="sm" onPress={() => setConfirmCancel(true)} />)}
      <Button label="Add items to cart again" variant="soft" fullWidth loading={busy && orderBusyId===selected.orderId} disabled={busy && orderBusyId!==selected.orderId} onPress={() => void reorder(selected.orderId).then((ok) => { if (ok) { setSelected(null); router.push('/cart'); } })} />
    </View>}
  </BottomSheet>{selectedSubscription && <SubscriptionManagement key={selectedSubscription.id} subscription={selectedSubscription} name={productsById.get(selectedSubscription.variant_id)?.name ?? 'Dairy subscription'} onClose={() => setSelectedSubscription(null)} />}</Screen>;
}
const styles = StyleSheet.create({ section:{fontFamily:fonts.semibold,fontSize:17,color:colors.brownDark,flex:1}, total:{fontFamily:fonts.semibold,color:colors.green}, moneyRow:{flexDirection:'row',justifyContent:'space-between',gap:12} });
