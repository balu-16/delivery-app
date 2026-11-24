import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { Card, ErrorBanner, formatPaise, Heading, shared } from '@/components/connected/Shared';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { colors, fonts } from '@/constants/theme';
import { useCustomer } from '@/src/store/customer';
import { useRefresh } from '@/hooks/useRefresh';
import { belongsToGroup, statusLabel, type OrderGroup } from '@/src/utils/order-groups';

const date = (value: string) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : dateFormatter.format(d);
};
const dateFormatter = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

type FilterKey = OrderGroup;

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'active', label: 'In progress' },
  { key: 'delivered', label: 'Delivered' },
  { key: 'cancelled', label: 'Cancelled' },
];

// Client-side fallback grouping: when server ignores ?group=, we already filtered in store.
// This component also defensively filters by status to keep UI correct on old servers.
function OrderCard({ orderId, orderNumber, status, placedAt, totalPaise }: { orderId: string; orderNumber: string; status: string; placedAt: string; totalPaise: string }) {
  return (
    <Card>
      <View style={shared.row}>
        <View style={{ flex: 1 }}>
          <AppText style={shared.label}>Order {orderNumber}</AppText>
          <AppText style={shared.muted}>{date(placedAt)} · {statusLabel(status)}</AppText>
        </View>
        <AppText style={styles.total}>{formatPaise(totalPaise)}</AppText>
      </View>
      <Button label="View details" variant="soft" size="sm" onPress={() => router.push({ pathname: '/orders/[orderId]', params: { orderId } })} />
    </Card>
  );
}

export default function MyDairy() {
  const insets = useSafeAreaInsets();
  const orders = useCustomer(s => s.orders);
  const ordersGroup = useCustomer(s => s.ordersGroup);
  const ordersCursor = useCustomer(s => s.ordersCursor);
  const ordersLoad = useCustomer(s => s.ordersLoad);
  const activityLoad = useCustomer(s => s.activityLoad);
  const loadActivity = useCustomer(s => s.loadActivity);
  const [localGroup, setLocalGroup] = useState<FilterKey>(ordersGroup ?? 'all');
  const [cursorByGroup, setCursorByGroup] = useState<Partial<Record<FilterKey, string | null>>>({});
  const listRef = useRef<FlatList>(null);

  // Preserve filter across navigation; sync store group when user switches chips.
  useEffect(() => {
    if (ordersGroup !== localGroup) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLocalGroup(ordersGroup ?? 'all');
    }
  }, [ordersGroup]); // eslint-disable-line

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadActivity({ group: localGroup, silent: false, cursor: cursorByGroup[localGroup] ?? undefined });
  }, [localGroup]); // eslint-disable-line

  const { refreshing, onRefresh } = useRefresh(async () => {
    await loadActivity({ group: localGroup, silent: true, cursor: cursorByGroup[localGroup] ?? undefined });
  });

  // Revalidate on return, deduped so rapid focus events don't refetch.
  const lastFocusRef = useRef(0);
  useFocusEffect(useCallback(() => {
    const now = Date.now();
    if (now - lastFocusRef.current < 15_000) return;
    lastFocusRef.current = now;
    void loadActivity({ group: localGroup, silent: true });
  }, [loadActivity, localGroup]));

  // Client-side defensive re-filter for tab correctness when server is old.
  const filtered = useMemo(() => {
    if (localGroup === 'all') return orders;
    // Store already filtered; re-apply for safety if needed.
    return orders.filter(o => belongsToGroup(o.status, localGroup));
  }, [orders, localGroup]);

  const preview = useMemo(() => {
    if (localGroup === 'delivered' || localGroup === 'cancelled') return null;
    // Most recent trackable active order (first in All/In progress list order is server order; we pick newest placedAt)
    const active = filtered.filter(o => belongsToGroup(o.status, 'active'));
    if (!active.length) return null;
    // Sort by placedAt desc to pick most recent.
    return [...active].sort((a, b) => new Date(b.placedAt).getTime() - new Date(a.placedAt).getTime())[0] ?? null;
  }, [filtered, localGroup]);

  const loadState = ordersLoad ?? activityLoad.orders;
  const loading = loadState === 'idle' || loadState === 'loading';
  const error = loadState === 'error';

  const onGroup = (g: FilterKey) => {
    setLocalGroup(g);
    // Preserve scroll position per group is handled by FlatList remount via key; we keep previous list instance per group via separate FlatLists? Use key prop.
    setTimeout(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }), 0);
  };

  const renderItem = ({ item }: { item: (typeof filtered)[number] }) => (
    <OrderCard orderId={item.orderId} orderNumber={item.orderNumber} status={item.status} placedAt={item.placedAt} totalPaise={item.totalPaise} />
  );

  const emptyText = localGroup === 'all' ? 'No orders yet' : localGroup === 'active' ? 'No orders in progress' : localGroup === 'delivered' ? 'No delivered orders yet' : 'No cancelled orders';

  return (
    <Screen>
      <FlatList
        ref={listRef}
        key={localGroup}
        data={filtered}
        renderItem={renderItem}
        keyExtractor={item => item.orderId}
        contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12, flexGrow: 1 }]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.green} />}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <Heading title="My Dairy" sub="Your orders in one place" />
            <ErrorBanner />
            {/* Group chips */}
            <View style={styles.chips}>
              {FILTERS.map(f => (
                <Pressable
                  key={f.key}
                  onPress={() => onGroup(f.key)}
                  accessibilityRole="button"
                  accessibilityLabel={`${f.label} filter`}
                  accessibilityState={{ selected: localGroup === f.key }}
                  style={[styles.chip, localGroup === f.key && styles.chipActive]}
                >
                  <AppText style={[styles.chipText, localGroup === f.key && styles.chipTextActive]}>{f.label}</AppText>
                </Pressable>
              ))}
            </View>
            <AppText style={styles.section}>Orders</AppText>
            {/* Lightweight live preview above list in All and In progress */}
            {preview && (
              <Card style={styles.preview}>
                <AppText style={shared.label}>Live update</AppText>
                <AppText style={shared.muted}>Order {preview.orderNumber} · {statusLabel(preview.status)}</AppText>
                <View style={shared.row}>
                  <Button label="View order" variant="soft" size="sm" onPress={() => router.push({ pathname: '/orders/[orderId]', params: { orderId: preview.orderId } })} />
                  <AppText style={styles.total}>{formatPaise(preview.totalPaise)}</AppText>
                </View>
              </Card>
            )}
            {loading ? <CardListSkeleton label="Loading orders" /> : error ? (
              <Card><AppText style={shared.body}>Couldn’t load orders.</AppText><Button label="Try again" variant="soft" size="sm" onPress={() => void loadActivity({ group: localGroup })} /></Card>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          !loading && !error ? (
            <Card>
              <AppText style={shared.label}>{emptyText}</AppText>
              <AppText style={shared.muted}>Your fresh deliveries will appear here.</AppText>
              <Button label="Explore products" variant="soft" size="sm" onPress={() => router.push('/products')} />
            </Card>
          ) : undefined
        }
        ListFooterComponent={ordersCursor ? (
          <Button
            label="Load more"
            variant="soft"
            size="sm"
            loading={loading}
            onPress={() =>
              void loadActivity({ group: localGroup, cursor: ordersCursor }).then(() => {
                const c = useCustomer.getState().ordersCursor;
                if (c) setCursorByGroup(prev => ({ ...prev, [localGroup]: c }));
              })
            }
          />
        ) : undefined}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  section: { fontFamily: fonts.semibold, fontSize: 17, color: colors.brownDark },
  total: { fontFamily: fonts.semibold, color: colors.green },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line },
  chipActive: { backgroundColor: colors.green, borderColor: colors.green },
  chipText: { fontSize: 12, fontFamily: fonts.semibold, color: colors.textSecondary },
  chipTextActive: { color: colors.inverse },
  preview: { borderColor: colors.green, borderWidth: 1 },
});
