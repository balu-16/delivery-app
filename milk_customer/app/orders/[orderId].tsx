import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { PageHeader } from '@/components/connected/PageHeader';
import { Card, ErrorBanner, formatPaise, shared } from '@/components/connected/Shared';
import { CardListSkeleton, SkeletonBlock } from '@/components/animations/Skeleton';
import { colors } from '@/constants/theme';
import { customerDetailsApi, type CustomerOrder } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { startOrderRealtime } from '@/src/orderRealtime';
import { useCustomer } from '@/src/store/customer';
import { useRefresh } from '@/hooks/useRefresh';
import { UUID_RE, isCancellable, isTrackable, statusLabel } from '@/src/utils/order-groups';

const dateFormatter = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const formatDate = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : dateFormatter.format(d);
};

export default function OrderDetailPage() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ orderId?: string }>();
  const rawId = typeof params.orderId === 'string' ? params.orderId : '';
  const valid = UUID_RE.test(rawId);
  const orderId = valid ? rawId : null;

  const cached = useCustomer(s => (orderId ? s.orders.find(o => o.orderId === orderId) : undefined));
  const loadActivity = useCustomer(s => s.loadActivity);
  const cancelOrder = useCustomer(s => s.cancelOrder);
  const reorder = useCustomer(s => s.reorder);
  const busy = useCustomer(s => s.orderBusyId !== null);
  const orderBusyId = useCustomer(s => s.orderBusyId);
  const justPlaced = useCustomer(s => s.lastOrder);

  const [order, setOrder] = useState<CustomerOrder | null>(cached ?? null);
  const [tracking, setTracking] = useState('');
  const [trackingLoading, setTrackingLoading] = useState(false);
  const [code, setCode] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const requestId = useRef(0);
  const trackingRequest = useRef(0);

  // Keep cached identity immediately; hydrate detail separately.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cached) setOrder(prev => (prev?.orderId === cached.orderId ? prev : cached));
  }, [cached?.orderId, cached?.status]); // eslint-disable-line

  const fetchOrder = useCallback(async () => {
    if (!orderId) return;
    const id = ++requestId.current;
    setLoading(true);
    setLoadError(false);
    try {
      const detail = await customerDetailsApi.order(await accessToken(), orderId);
      if (requestId.current === id) setOrder(detail);
    } catch {
      if (requestId.current === id) {
        if (!order) setLoadError(true);
      }
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [orderId, order?.orderId]); // eslint-disable-line

  useEffect(() => {
    if (!orderId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchOrder();
  }, [orderId]);

  // Tracking: fetch independently; preserve last snapshot on failure.
  const fetchTracking = useCallback(async () => {
    if (!orderId) return;
    const id = ++trackingRequest.current;
    setTrackingLoading(true);
    try {
      const data = await customerDetailsApi.tracking(await accessToken(), orderId);
      if (trackingRequest.current !== id) return;
      if (data.eta) setTracking(`${statusLabel(data.taskStatus)} · ${data.eta.minMinutes}–${data.eta.maxMinutes} min`);
      else setTracking(statusLabel(data.taskStatus));
    } catch {
      if (trackingRequest.current !== id) return;
      // Availability message while GPS/assignment unavailable — keep prior order usable.
      setTracking(prev => prev || 'Tracking will appear when a delivery partner is assigned.');
    } finally {
      if (trackingRequest.current === id) setTrackingLoading(false);
    }
  }, [orderId]);

  // Subscribe only while visible active order needs updates.
  const needsTracking = !!order && isTrackable(order.status);
  useEffect(() => {
    if (!orderId || !needsTracking) return;
    let active = true;
    let last = 0;
    const refresh = () => {
      const now = Date.now();
      if (now - last < 10000) return;
      last = now;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void fetchTracking();
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTracking();
    let stop: (() => void) | undefined;
    try {
      stop = startOrderRealtime(orderId, refresh, () => {
        void fetchTracking();
        void loadActivity({ silent: true }).catch(() => undefined);
        void accessToken().then(t => customerDetailsApi.order(t, orderId)).then(o => { if (active) setOrder(o); }).catch(() => undefined);
      });
    } catch { /* polling fallback */ }
    const timer = setInterval(() => void fetchTracking(), 30000);
    return () => { active = false; clearInterval(timer); stop?.(); };
  }, [orderId, needsTracking, fetchTracking, loadActivity]);

  const { refreshing, onRefresh } = useRefresh(async () => {
    if (!orderId) return;
    await Promise.allSettled([fetchOrder(), fetchTracking()]);
    void loadActivity({ silent: true }).catch(() => undefined);
  });

  const showCode = async () => {
    if (!orderId) return;
    try {
      const r = await customerDetailsApi.deliveryCode(await accessToken(), orderId);
      setCode(r.code);
    } catch {
      setCode('A delivery code is not available yet.');
    }
  };

  const handleCancel = async () => {
    if (!order) return;
    const ok = await cancelOrder(order.orderId);
    if (ok) {
      setConfirmCancel(false);
      // Update order cache snapshot locally.
      const updated = await customerDetailsApi.order(await accessToken(), order.orderId).catch(() => null);
      if (updated) setOrder(updated);
      else setOrder(prev => (prev ? { ...prev, status: 'CANCELLED' } : prev));
    }
  };

  const handleReorder = async () => {
    if (!order) return;
    const ok = await reorder(order.orderId);
    if (ok) router.push('/cart');
  };

  if (!valid || !orderId) {
    return (
      <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
        <PageHeader title="Order" onBack={() => router.canGoBack() ? router.back() : router.replace('/my-dairy')} />
        <Card><AppText style={shared.body}>This order could not be opened.</AppText><Button label="Back to My Dairy" variant="soft" size="sm" onPress={() => router.replace('/my-dairy')} /></Card>
      </ScrollView></Screen>
    );
  }

  // Cold-start: cached may be missing, but we still have orderId; fetch will fill.
  if (loading && !order) {
    return (
      <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
        <PageHeader title="Order" onBack={() => router.canGoBack() ? router.back() : router.replace('/my-dairy')} />
        <CardListSkeleton label="Loading order" count={3} />
      </ScrollView></Screen>
    );
  }

  if (loadError && !order) {
    return (
      <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
        <PageHeader title="Order" onBack={() => router.canGoBack() ? router.back() : router.replace('/my-dairy')} />
        <Card><AppText style={shared.body}>Couldn’t load this order.</AppText><Button label="Try again" variant="soft" size="sm" onPress={() => void fetchOrder()} /></Card>
      </ScrollView></Screen>
    );
  }

  if (!order) {
    return (
      <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
        <PageHeader title="Order" onBack={() => router.canGoBack() ? router.back() : router.replace('/my-dairy')} />
        <CardListSkeleton label="Loading order" count={3} />
      </ScrollView></Screen>
    );
  }

  const isActive = isTrackable(order.status) || ['PENDING_PAYMENT', 'CONFIRMED'].includes(order.status);
  const isDelivered = order.status === 'DELIVERED';
  const isCancelledLike = ['CANCELLED', 'EXPIRED', 'PAYMENT_FAILED', 'DELIVERY_FAILED', 'RETURNED_TO_STORE'].includes(order.status);
  const cancellable = isCancellable(order.status) || (order.status === 'CONFIRMED' || order.status === 'PENDING_PAYMENT');

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12, flexGrow: 1 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.green} />}
      >
        {/* Header paints immediately from cached identity; detail hydrates below. */}
        <PageHeader title={`Order ${order.orderNumber}`} sub={`${formatDate(order.placedAt)} · ${statusLabel(order.status)}`} onBack={() => router.canGoBack() ? router.back() : router.replace('/my-dairy')} />
        <ErrorBanner />

        {/* Map area — top when tracking available. Mock geometry reflects plan2 freshness rules. */}
        {isTrackable(order.status) && (
          <Card style={styles.mapCard}>
            <AppText style={shared.label}>Delivery map</AppText>
            {trackingLoading ? (
              <View accessibilityLabel="Loading tracking" accessibilityState={{ busy: true }}><SkeletonBlock width="90%" height={18} /></View>
            ) : (
              <AppText style={shared.body}>{tracking || 'Preparing delivery…'} </AppText>
            )}
            {/* When geometry/assignment/GPS unavailable we show the last confirmed stage + short message. */}
            {!tracking && !trackingLoading && <AppText style={shared.muted}>Live location will appear when the rider is assigned.</AppText>}
            {/* Rider marker is removed by the tracking API itself when assignment ends; we never render a stale marker client-side. */}
          </Card>
        )}

        {/* Items and amount */}
        <Card>
          <AppText style={shared.label}>Items</AppText>
          {order.items.map(item => (
            <View key={item.id} style={styles.moneyRow}>
              <AppText style={[shared.body, { flex: 1 }]}>{item.name} × {item.orderedQty}</AppText>
              <AppText style={shared.body}>{formatPaise(item.unitPricePaise)} each</AppText>
            </View>
          ))}
          <View style={styles.moneyRow}><AppText style={shared.label}>Total</AppText><AppText style={shared.label}>{formatPaise(order.totalPaise)}</AppText></View>
          <AppText style={shared.muted}>Payment: {statusLabel(order.paymentStatus)}</AppText>
        </Card>

        {/* Action area — one per state */}
        <Card>
          {isActive && (
            <>
              <AppText style={shared.label}>Delivery progress</AppText>
              {tracking ? <AppText style={shared.body}>{tracking}</AppText> : <View accessibilityLabel="Loading delivery progress" accessibilityState={{ busy: true }}><SkeletonBlock width="75%" height={14} /></View>}
              <Button label="Show delivery code" variant="soft" size="sm" onPress={() => void showCode()} />
              {!!code && <AppText style={shared.label}>{code}</AppText>}
              {cancellable && (
                confirmCancel ? (
                  <><AppText style={shared.body}>Cancel this order?</AppText>
                    <View style={shared.row}>
                      <Button label="Yes, cancel" size="sm" loading={busy && orderBusyId === order.orderId} disabled={busy && orderBusyId !== order.orderId} onPress={() => void handleCancel()} />
                      <Button label="Keep order" variant="ghost" size="sm" onPress={() => setConfirmCancel(false)} />
                    </View></>
                ) : (
                  <Button label="Cancel order" variant="outline" size="sm" onPress={() => setConfirmCancel(true)} />
                )
              )}
            </>
          )}
          {isDelivered && (
            <>
              <AppText style={shared.label}>Delivered</AppText>
              <AppText style={shared.body}>Your order is complete. Totals are shown above.</AppText>
              <Button label="Add items to cart again" variant="soft" fullWidth loading={busy && orderBusyId === order.orderId} disabled={busy && orderBusyId !== order.orderId} onPress={() => void handleReorder()} />
              {/* RECEIPT HOOK — plan2 approval is PENDING. Do not build preview/PDF here.
                  Integration point: after approval, render receipt summary + download with
                  separate download loading state. Keep this page’s totals authoritative. */}
              <AppText style={shared.muted}>Receipt PDF coming soon.</AppText>
            </>
          )}
          {isCancelledLike && (
            <>
              <AppText style={shared.label}>Status: {statusLabel(order.status)}</AppText>
              <AppText style={shared.body}>
                {order.status === 'CANCELLED' ? 'This order was cancelled. Any eligible refund will follow the usual timeline.'
                  : order.status === 'PAYMENT_FAILED' ? 'Payment did not complete. Please place a new order if you still want these items.'
                  : order.status === 'EXPIRED' ? 'This order expired before payment could be completed. Place a new order to continue.'
                  : order.status === 'DELIVERY_FAILED' ? 'Delivery could not be completed for this order. Eligible refunds are processed automatically.'
                  : order.status === 'RETURNED_TO_STORE' ? 'This order has been returned to the store. Any eligible refund will follow the usual timeline.'
                  : 'This order is no longer active.'}
              </AppText>
              <Button label="Need help with this order" variant="soft" size="sm" onPress={() => router.push({ pathname: '/support', params: { orderId: order.orderId } } as never)} />
            </>
          )}
        </Card>

        {/* Order-linked Help */}
        <Card>
          <AppText style={shared.label}>Need help?</AppText>
          <AppText style={shared.muted}>Our team can help with this order.</AppText>
          <Button label="Contact support" variant="soft" size="sm" onPress={() => router.push({ pathname: '/support', params: { orderId: order.orderId } } as never)} />
        </Card>

        {justPlaced && justPlaced.orderId === orderId && (
          <Card><AppText style={shared.body}>This order was just placed. If anything looks unexpected, you can keep the snapshot above.</AppText></Card>
        )}
      </ScrollView>
    </Screen>
  );
}
const styles = StyleSheet.create({
  moneyRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  mapCard: { minHeight: 80 },
});
