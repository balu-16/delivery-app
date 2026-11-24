import { BackHandler, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { riderApi, type Notice } from '../src/api';
import { Brand } from '../src/components/Brand';
import { CardListSkeleton } from '../src/components/Skeleton';
import { Button, Card, PageTitle, Text } from '../src/components/Ui';
import { resolvePartnerNotification, shouldNavigate, partnerHref } from '../src/notification-routing';
import { ensurePartnerIdentity } from '../src/partner-session';
import { colors } from '../src/theme';
import { shortTime } from '../src/screens/liveHelpers';

/**
 * Partner notifications inbox — plan3 §3 `/notifications`.
 * Independent inbox with unread states and row / bulk marking.
 * Inbox taps, foreground push taps and cold-start responses share the
 * typed resolver. Unknown events fall back here. Warm start preserves
 * the current stack; cold start waits for the correct account.
 */
export default function NotificationsRoute() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [items, setItems] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [marking, setMarking] = useState(false);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    setError('');
    try {
      const page = await riderApi.notifications();
      setItems(page.items);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load notifications.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void ensurePartnerIdentity().then((identity) => {
      if (!active) return;
      if (!identity) {
        setError('Please sign in to view notifications.');
        setLoading(false);
        return;
      }
      void load();
    }).catch(() => {
      if (active) {
        setError('Could not load notifications.');
        setLoading(false);
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (router.canGoBack()) router.back();
      else router.replace('/');
      return true;
    });
    return () => sub.remove();
  }, [router]);

  async function onRefresh() {
    setRefreshing(true);
    await load(true).catch(() => undefined);
    setRefreshing(false);
  }

  async function markAll() {
    setMarking(true);
    try {
      await riderApi.readNotifications();
      setItems((current) => current.map((n: Notice) => ({ ...n, readAt: (n as unknown as { readAt: string }).readAt ?? new Date().toISOString() })));
      await load(true);
    } catch {
      setError('Could not mark all as read. Try again.');
    } finally {
      setMarking(false);
    }
  }

  async function open(notice: Notice) {
    const resolved = resolvePartnerNotification(notice as unknown as Record<string, unknown>);
    const href = partnerHref(resolved);
    try {
      const id = (notice as unknown as { id: string }).id;
      if (typeof id === 'string') {
        // Deduplicated read update via existing notification ID.
        await riderApi.readNotification(id).catch(() => undefined);
      }
    } catch {
      // Read failure must not block navigation.
    }
    if (shouldNavigate(href)) {
      if (href.params) router.push(href.pathname as never, href.params as never);
      else router.push(href.pathname as never);
    }
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={goBack} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}><Brand /></View>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { flexGrow: 1, paddingBottom: insets.bottom + 30 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.greenDark} />}
      >
        <PageTitle title="Notifications" subtitle="Updates about your deliveries and account." />
        {loading ? (
          <CardListSkeleton label="Loading notifications" count={3} />
        ) : error && items.length === 0 ? (
          <Card>
            <Text accessibilityRole="alert" style={styles.sub}>{error}</Text>
            <View style={{ height: 12 }} />
            <Button label="Try again" secondary onPress={() => void load()} />
          </Card>
        ) : (
          <>
            {items.length > 0 ? <Button label={marking ? 'Marking…' : 'Mark all read'} secondary compact disabled={marking} onPress={() => void markAll()} /> : <Card><Text style={styles.sub}>No notifications yet.</Text></Card>}
            <View style={{ height: 12 }} />
            {items.map((notice) => (
              <Pressable key={notice.id} accessibilityRole="button" onPress={() => void open(notice)}>
                <Card>
                  <Text style={styles.strong}>{(notice as unknown as { title: string }).title}</Text>
                  <Text style={styles.sub}>{(notice as unknown as { body: string }).body}</Text>
                  <Text style={styles.small}>{shortTime((notice as unknown as { createdAt: string }).createdAt)}</Text>
                </Card>
              </Pressable>
            ))}
            {error ? <Text accessibilityRole="alert" style={styles.small}>{error}</Text> : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 58, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', gap: 8 },
  backBtn: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 17 },
  strong: { fontSize: 14 },
  sub: { color: colors.secondary, fontSize: 12, lineHeight: 19, marginTop: 4 },
  small: { color: colors.secondary, fontSize: 10, marginTop: 4 },
});
