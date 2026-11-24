import { router, type Href } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { PageHeader } from '@/components/connected/PageHeader';
import { Card, ErrorBanner, shared } from '@/components/connected/Shared';
import { PushSettings } from '@/components/connected/PushNotifications';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { colors } from '@/constants/theme';
import { useCustomer } from '@/src/store/customer';
import { useRefresh } from '@/hooks/useRefresh';
import { customerDetailsApi } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { assistantNotificationTarget } from '@/src/agent/notification-target';
import { resolveCustomerNotification, shouldNavigateCustomer } from '@/src/notifications/resolver';

const dateFn = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(d);
};

export default function NotificationsPage() {
  const insets = useSafeAreaInsets();
  const { notifications, loadNotifications, readNotifications, accountLoad } = useCustomer();

  useEffect(() => { void loadNotifications(); }, [loadNotifications]);
  const { refreshing, onRefresh } = useRefresh(() => loadNotifications());

  const onTap = (item: (typeof notifications)[number]) => {
    void accessToken()
      .then(t => customerDetailsApi.readNotification(t, item.id))
      .then(() => loadNotifications())
      .catch(() => undefined);
    const data = item.payload?.data && typeof item.payload.data === 'object' && !Array.isArray(item.payload.data) ? (item.payload.data as Record<string, unknown>) : {};
    const flat = { ...data, deepLink: item.payload?.deepLink, notificationId: item.id };
    const resolved = resolveCustomerNotification(flat);
    if (resolved && shouldNavigateCustomer(resolved.route)) {
      const route = resolved.route;
      router.push((route.params ? { pathname: route.pathname, params: route.params } : route.pathname) as Href);
      return;
    }
    const target = assistantNotificationTarget(flat);
    if (target) router.push({ pathname: '/agent', params: target } as Href);
    else router.push('/notifications');
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12, flexGrow: 1 }]} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.green} />}>
        <PageHeader title="Notifications" sub="Order updates and alerts" onBack={() => router.canGoBack() ? router.back() : router.replace('/profile')} />
        <ErrorBanner />
        <PushSettings />
        {accountLoad.notifications === 'idle' || accountLoad.notifications === 'loading' ? (
          <CardListSkeleton count={3} label="Loading notifications" />
        ) : accountLoad.notifications === 'error' ? (
          <Card><AppText style={shared.muted}>Couldn’t load notifications.</AppText><Button label="Try again" size="sm" variant="soft" onPress={() => void loadNotifications()} /></Card>
        ) : (
          <>
            {notifications.length > 0 && <Button label="Mark all as read" size="sm" variant="soft" onPress={() => void readNotifications()} />}
            {notifications.length ? (
              notifications.map(item => (
                <Pressable key={item.id} onPress={() => onTap(item)} accessibilityRole="button" accessibilityLabel={`Notification ${item.title}`}>
                  <Card style={!item.readAt ? styles.unread : undefined}>
                    <AppText style={shared.label}>{item.title}</AppText>
                    <AppText style={shared.body}>{item.body}</AppText>
                    <AppText style={shared.muted}>{dateFn(item.createdAt)}{item.readAt ? '' : ' · Unread'}</AppText>
                  </Card>
                </Pressable>
              ))
            ) : (
              <AppText style={shared.muted}>You have no notifications.</AppText>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
const styles = StyleSheet.create({ unread: { borderColor: colors.green, borderWidth: 1 } });
