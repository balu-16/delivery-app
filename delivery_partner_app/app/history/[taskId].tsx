import { BackHandler, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { riderApi, type TaskHistoryDetail } from '../../src/api';
import { Brand } from '../../src/components/Brand';
import { CardListSkeleton } from '../../src/components/Skeleton';
import { Button, Card, PageTitle, Text } from '../../src/components/Ui';
import { ensurePartnerIdentity } from '../../src/partner-session';
import { isValidPartnerTaskId } from '../../src/notification-routing';
import { colors, fonts } from '../../src/theme';
import { formatMoney, shortTime } from '../../src/screens/liveHelpers';

/**
 * Read-only history — plan3 §3 `/history/[taskId]`.
 * Rider's own completed assignment via `GET /v1/rider/task-history/:taskId`.
 * History may carry attempt number; default is the rider's most recent
 * eligible attempt. Excludes delivery codes, contact data, other riders
 * and private proof links. Cold start returns to Tasks/Earnings.
 */
export default function HistoryRoute() {
  const params = useLocalSearchParams<{ taskId: string; attemptNo?: string }>();
  const id = Array.isArray(params.taskId) ? params.taskId[0] : params.taskId;
  const attemptRaw = Array.isArray(params.attemptNo) ? params.attemptNo[0] : params.attemptNo;
  const attemptNo = attemptRaw !== undefined && attemptRaw !== '' ? Number(attemptRaw) : undefined;
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [detail, setDetail] = useState<TaskHistoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    if (!id || !isValidPartnerTaskId(id)) {
      setLoading(false);
      setError('This history link is not valid.');
      return;
    }
    if (attemptNo !== undefined && (!Number.isInteger(attemptNo) || attemptNo < 0)) {
      setLoading(false);
      setError('This history link is not valid.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      setDetail(await riderApi.taskHistory(id, attemptNo));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load this history record.');
      setDetail(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void ensurePartnerIdentity().then((identity) => {
      if (!active) return;
      if (!identity) {
        setError('Please sign in to view history.');
        setLoading(false);
        return;
      }
      void load();
    }).catch(() => {
      if (active) {
        setError('Could not load this history record.');
        setLoading(false);
      }
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, attemptRaw]);

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
    await load().catch(() => undefined);
    setRefreshing(false);
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
        <PageTitle title="Delivery history" subtitle={detail ? `Order ${detail.orderNumber}` : 'Completed assignment'} />
        {loading ? (
          <CardListSkeleton label="Loading history details" count={2} />
        ) : error && !detail ? (
          <Card>
            <Text accessibilityRole="alert" style={styles.sub}>{error}</Text>
            <View style={{ height: 12 }} />
            <Button label="Try again" secondary onPress={() => void load()} />
            <View style={{ height: 8 }} />
            <Button label="Back" onPress={goBack} />
          </Card>
        ) : detail ? (
          <>
            <Card>
              <Text style={styles.strong}>{detail.status.replaceAll('_', ' ')}</Text>
              <Text style={styles.sub}>Attempt {detail.attemptNo} · Assigned {shortTime(detail.assignedAt)}</Text>
              {detail.pickupAt ? <Text style={styles.small}>Picked up {shortTime(detail.pickupAt)}</Text> : null}
              {detail.arrivedCustomerAt ? <Text style={styles.small}>Arrived at customer {shortTime(detail.arrivedCustomerAt)}</Text> : null}
              {detail.deliveredAt ? <Text style={styles.small}>Delivered {shortTime(detail.deliveredAt)}</Text> : null}
              {detail.failureReason ? <Text style={styles.small}>Reason: {detail.failureReason}</Text> : null}
            </Card>
            <Card>
              <Text style={styles.strong}>Earnings</Text>
              {detail.earnings.totalPaise ? (
                <>
                  <Text style={styles.strong}>Total {formatMoney(detail.earnings.totalPaise)}</Text>
                  <Text style={styles.sub}>Base {formatMoney(detail.earnings.basePaise)} · Distance {formatMoney(detail.earnings.distancePaise)} · Incentive {formatMoney(detail.earnings.incentivePaise)} · Tip {formatMoney(detail.earnings.tipPaise)}</Text>
                  {detail.earnings.distanceMetres !== null ? <Text style={styles.small}>Distance {(detail.earnings.distanceMetres / 1000).toFixed(1)} km</Text> : null}
                  {detail.earnings.distancePending ? <Text style={styles.small}>Distance pay is awaiting review.</Text> : null}
                  {detail.earnings.computedAt ? <Text style={styles.small}>Computed {shortTime(detail.earnings.computedAt)}</Text> : null}
                </>
              ) : (
                <Text style={styles.sub}>No earnings recorded for this attempt.</Text>
              )}
            </Card>
            <Text style={styles.small}>This is a read-only record of your own assignment. Delivery codes and contact details are never shown here.</Text>
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
  strong: { fontFamily: fonts.semibold, fontSize: 14 },
  sub: { color: colors.secondary, fontSize: 12, lineHeight: 19, marginTop: 4 },
  small: { color: colors.secondary, fontSize: 10, marginTop: 4 },
});
