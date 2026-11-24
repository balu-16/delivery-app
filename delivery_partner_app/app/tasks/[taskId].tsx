import { BackHandler, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useCallback, useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { ApiError, riderApi, type Task, type TaskHistoryDetail } from '../../src/api';
import { performAction } from '../../src/actions';
import { Brand } from '../../src/components/Brand';
import { CardListSkeleton } from '../../src/components/Skeleton';
import { Button, Card, PageTitle, Text } from '../../src/components/Ui';
import { TaskDetail } from '../../src/screens/TaskDetail';
import { ensurePartnerIdentity } from '../../src/partner-session';
import { isValidPartnerTaskId } from '../../src/notification-routing';
import { colors } from '../../src/theme';
import { formatMoney, shortTime } from '../../src/screens/liveHelpers';

/**
 * Partner task detail — plan3 §3 `/tasks/[taskId]`.
 * Validated UUID taskId only. Retains the card snapshot while refreshing
 * that task; shows order number, status, current stop, directions and the
 * next eligible action above secondary content. Handover, pickup, customer
 * navigation, cash collection, delivery code and proof upload stay inside
 * this workflow. Old active-task links resolving to eligible history show
 * the final status via the history endpoint.
 *
 * Cold start waits for the signed-in account and returns to Tasks.
 * Report is opened from here at `/tasks/[taskId]/report`.
 */
export default function TaskDetailRoute() {
  const { taskId } = useLocalSearchParams<{ taskId: string }>();
  const id = Array.isArray(taskId) ? taskId[0] : taskId;
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [task, setTask] = useState<Task | null>(null);
  const [history, setHistory] = useState<TaskHistoryDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [subject, setSubject] = useState('unknown');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!id || !isValidPartnerTaskId(id)) {
      setFailed(true);
      setLoading(false);
      setError('This delivery link is not valid.');
      return;
    }
    setLoading(true);
    setFailed(false);
    setError('');
    try {
      const detail = await riderApi.task(id);
      setTask(detail);
      setHistory(null);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) {
        // Try history: old active-task link resolving to eligible history.
        try {
          const h = await riderApi.taskHistory(id);
          setHistory(h);
          setTask(null);
        } catch {
          setFailed(true);
          setError('This delivery is no longer assigned to you. Check your history for its latest status.');
        }
      } else {
        setFailed(true);
        setError(failure instanceof Error ? failure.message : 'Could not load this delivery.');
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    let active = true;
    void ensurePartnerIdentity()
      .then((identity) => {
        if (!active) return;
        if (!identity) {
          setFailed(true);
          setError('Please sign in to view this delivery.');
          setLoading(false);
          return;
        }
        setSubject(identity.subject);
        void load();
      })
      .catch(() => {
        if (active) {
          setFailed(true);
          setError('Could not load this delivery.');
          setLoading(false);
        }
      });
    return () => { active = false; };
  }, [load]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (router.canGoBack()) router.back();
      else router.replace('/');
      return true;
    });
    return () => sub.remove();
  }, [router]);

  async function run(action: string, body: unknown): Promise<boolean> {
    if (!task || busy) return false;
    const scope = `task:${task.id}`;
    if (busyId === scope) return false;
    setBusy(true);
    setBusyId(scope);
    setError('');
    const subject = (await ensurePartnerIdentity().catch(() => null))?.subject ?? 'unknown';
    setSubject(subject);
    try {
      await performAction(subject, task.id, action, (key) => riderApi.taskAction(task.id, action, body, key));
      // Retain the card snapshot while refreshing that task.
      const refreshed = await riderApi.task(task.id);
      setTask(refreshed);
      setError('');
      return true;
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 0 || failure.status >= 500)) {
        setError(`${failure.message} The request may have gone through; refresh and retry the same action to confirm.`);
      } else {
        setError(failure instanceof Error ? failure.message : 'Could not complete the request.');
      }
      // Best-effort refresh; error must not be hidden.
      await riderApi.task(task.id).then(setTask).catch(() => undefined);
      return false;
    } finally {
      setBusy(false);
      setBusyId(null);
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    await load().catch(() => undefined);
    setRefreshing(false);
  }

  function goTasks() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  function goReport() {
    if (!id) return;
    router.push(`/tasks/[taskId]/report` as never, { taskId: id } as never);
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
        {history ? (
          <>
            <PageTitle title={`Order ${history.orderNumber}`} subtitle={history.status.replaceAll('_', ' ')} />
            <Card>
              <Text style={styles.strong}>This delivery is complete.</Text>
              <Text style={styles.sub}>Final status: {history.status.replaceAll('_', ' ')}</Text>
              <Text style={styles.small}>Assigned {shortTime(history.assignedAt)}{history.earnings.totalPaise ? ` · Earned ${formatMoney(history.earnings.totalPaise)}` : ''}</Text>
            </Card>
            <Button label="View history details" secondary onPress={() => router.push(`/history/[taskId]` as never, { taskId: history.taskId } as never)} />
            <View style={{ height: 10 }} />
            <Button label="Back to tasks" onPress={goTasks} />
          </>
        ) : failed ? (
          <>
            {error ? <Text style={styles.warning}>{error}</Text> : null}
            <PageTitle title="Delivery unavailable" subtitle="This order is no longer assigned to you. Check your history for its latest status." />
            {loading ? <CardListSkeleton label="Loading delivery details" count={2} /> : null}
            <Button label="Back to tasks" onPress={goTasks} />
            <View style={{ height: 10 }} />
            <Button label="Try again" secondary onPress={() => void load()} />
          </>
        ) : task ? (
          <>
            <TaskDetail task={task} account={subject} enabled={true} busy={busy} run={run} />
            <View style={{ height: 10 }} />
            <Button label="Report a problem" secondary onPress={goReport} />
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          </>
        ) : (
          <>
            <PageTitle title="Delivery" subtitle="Loading details…" />
            <CardListSkeleton label="Loading delivery details" count={2} />
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
  strong: { fontFamily: 'Poppins_600SemiBold' as never, fontSize: 14, color: colors.text } as never,
  sub: { color: colors.secondary, fontSize: 12, lineHeight: 19, marginTop: 4 },
  small: { color: colors.secondary, fontSize: 10, marginTop: 4 },
  error: { color: colors.danger, fontSize: 12, marginTop: 10, textAlign: 'center' },
  warning: { color: colors.danger, backgroundColor: '#FAE9D5', padding: 9, textAlign: 'center', fontSize: 11, marginBottom: 12 },
});
