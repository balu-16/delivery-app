import { BackHandler, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { ApiError, riderApi } from '../../src/api';
import { performAction } from '../../src/actions';
import { Brand } from '../../src/components/Brand';
import { CardListSkeleton } from '../../src/components/Skeleton';
import { Button, Card, IconBox, PageTitle, Text } from '../../src/components/Ui';
import { ensurePartnerIdentity } from '../../src/partner-session';
import { isValidPartnerOfferId } from '../../src/notification-routing';
import { colors } from '../../src/theme';
import { formatMoney, shortTime } from '../../src/screens/liveHelpers';

/**
 * Partner offer detail — plan3 §3 `/offers/[offerId]`.
 * Validated UUID offerId only. Cold start waits for the signed-in account
 * and restores Tasks as parent. Expired/revoked offers show a short message
 * and return to Tasks. After acceptance navigates to the assigned task when
 * still in that flow, otherwise refreshes the task list in the background.
 */
export default function OfferDetailRoute() {
  const { offerId } = useLocalSearchParams<{ offerId: string }>();
  const id = Array.isArray(offerId) ? offerId[0] : offerId;
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [offer, setOffer] = useState<Awaited<ReturnType<typeof riderApi.offer>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function load(silent = false) {
    if (!id || !isValidPartnerOfferId(id)) {
      setExpired(true);
      setLoading(false);
      setError('This offer link is not valid.');
      return;
    }
    if (!silent) setLoading(true);
    setError('');
    try {
      const detail = await riderApi.offer(id);
      setOffer(detail);
      setExpired(false);
    } catch (failure) {
      if (failure instanceof ApiError && (failure.code === 'OFFER_EXPIRED' || failure.code === 'RESOURCE_NOT_FOUND' || failure.code === 'OFFER_NO_LONGER_AVAILABLE')) {
        setExpired(true);
        setOffer(null);
        setError(failure.code === 'OFFER_EXPIRED' ? 'This offer has expired.' : 'This offer is no longer available.');
      } else {
        setError(failure instanceof Error ? failure.message : 'Could not load this offer.');
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      // Cold start waits for the correct signed-in account.
      const identity = await ensurePartnerIdentity().catch(() => null);
      if (!active) return;
      if (!identity) {
        // No session: show sign-in needed and return to the tab stack.
        setError('Please sign in to view this offer.');
        setLoading(false);
        return;
      }
      await load();
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (router.canGoBack()) router.back();
      else {
        router.replace('/');
      }
      return true;
    });
    return () => sub.remove();
  }, [router]);

  async function act(action: 'accept' | 'decline') {
    if (!offer || busy) return;
    setBusy(true);
    setError('');
    try {
      const subject = (await ensurePartnerIdentity().catch(() => null))?.subject ?? 'unknown';
      await performAction(subject, offer.offerId, action, (key) => action === 'accept' ? riderApi.accept(offer.offerId, key) : riderApi.decline(offer.offerId, key));
      if (action === 'accept') {
        // Navigate to the assigned task when still in the offer flow.
        router.replace(`/tasks/[taskId]` as never, { taskId: offer.taskId } as never);
      } else {
        router.back();
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && failure.code !== 'IDEMPOTENCY_KEY_REUSED') {
        // Definite rejection: surface immediately, keep the key for uncertain reuse already handled in performAction.
        setError(failure.message);
      } else if (failure instanceof ApiError && (failure.status === 0 || failure.status >= 500)) {
        setError(`${failure.message} The request may have gone through; refresh and retry the same action to confirm.`);
      } else {
        setError(failure instanceof Error ? failure.message : 'Could not complete the request.');
      }
      // Preserve the current screen; the offer list refreshes in the background via LivePartner.
    } finally {
      setBusy(false);
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    await load(true).catch(() => undefined);
    setRefreshing(false);
  }

  function goTasks() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={goTasks} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={22} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}><Brand /></View>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { flexGrow: 1, paddingBottom: insets.bottom + 30 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.greenDark} />}
      >
        <PageTitle title="Offer details" subtitle={offer ? `Order ${offer.orderNumber}` : 'Delivery offer'} />
        {loading && !offer ? (
          <CardListSkeleton label="Loading offer details" count={2} />
        ) : expired ? (
          <Card>
            <Text style={styles.strong}>{error || 'This offer is no longer available.'}</Text>
            <Text style={styles.sub}>No action is needed. You can view other deliveries in Tasks.</Text>
            <View style={{ height: 12 }} />
            <Button label="Back to tasks" onPress={goTasks} />
          </Card>
        ) : error && !offer ? (
          <Card>
            <Text accessibilityRole="alert" style={styles.sub}>{error}</Text>
            <View style={{ height: 12 }} />
            <Button label="Try again" secondary onPress={() => void load()} />
            <View style={{ height: 8 }} />
            <Button label="Back to tasks" secondary onPress={goTasks} />
          </Card>
        ) : offer ? (
          <>
            <Card>
              <View style={styles.row}>
                <IconBox name="cube-outline" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.strong}>{offer.orderNumber}</Text>
                  <Text style={styles.sub}>Pickup · {offer.storeName}</Text>
                </View>
              </View>
              <Text style={styles.small}>Offer expires {shortTime(offer.expiresAt)}{offer.codAmountPaise !== null ? ` · Cash ${formatMoney(offer.codAmountPaise)}` : ''}</Text>
              {offer.codAmountPaise !== null ? <Text style={styles.sub}>Cash on delivery: {formatMoney(offer.codAmountPaise)}</Text> : null}
            </Card>
            <View style={styles.buttons}>
              <Button label="Decline" secondary disabled={busy} style={{ flex: 1 }} onPress={() => void act('decline')} />
              <Button label="Accept" disabled={busy} style={{ flex: 1 }} onPress={() => void act('accept')} />
            </View>
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <Text style={styles.small}>Accepting assigns this delivery to you. If you are viewing another screen, the task list will update in the background.</Text>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 58, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', gap: 8 },
  backBtn: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  strong: { fontSize: 14, fontFamily: colors.text ? 'Poppins_600SemiBold' as never : undefined, color: colors.text } as never,
  sub: { color: colors.secondary, fontSize: 12, lineHeight: 19, marginTop: 4 },
  small: { color: colors.secondary, fontSize: 10, marginTop: 6, lineHeight: 16 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 12 },
  error: { color: colors.danger, fontSize: 12, marginTop: 10, textAlign: 'center' },
});
