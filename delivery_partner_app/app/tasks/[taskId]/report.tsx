import { BackHandler, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { ApiError, riderApi, UploadError, type Task } from '../../../src/api';
import { performAction } from '../../../src/actions';
import { Brand } from '../../../src/components/Brand';
import { CardListSkeleton } from '../../../src/components/Skeleton';
import { Button, Card, Chip, PageTitle, Text } from '../../../src/components/Ui';
import { ensurePartnerIdentity } from '../../../src/partner-session';
import { isValidPartnerTaskId } from '../../../src/notification-routing';
import { uploadProof } from '../../../src/files';
import { colors, fonts } from '../../../src/theme';

/**
 * Report a problem — plan3 §3 `/tasks/[taskId]/report`.
 * Concise reason picker; full page for wrong-address notes, contact
 * attempts that require review, or an eligible delivery issue with
 * evidence. Operational transitions reuse task-action routes; evidence
 * uses the allowed attachment / POD flow. Report is opened from its task.
 */
export default function TaskReportRoute() {
  const params = useLocalSearchParams<{ taskId: string }>();
  const id = Array.isArray(params.taskId) ? params.taskId[0] : params.taskId;
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('CUSTOMER_UNREACHABLE');
  const [wrongAddress, setWrongAddress] = useState('');
  const [evidence, setEvidence] = useState<string | null>(null);
  const [evidenceBusy, setEvidenceBusy] = useState(false);
  const [evidenceError, setEvidenceError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    if (!id || !isValidPartnerTaskId(id)) {
      setLoading(false);
      setError('This delivery link is not valid.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      setTask(await riderApi.task(id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not load this delivery.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    void ensurePartnerIdentity().then((identity) => {
      if (!active) return;
      if (!identity) {
        setError('Please sign in to report a problem.');
        setLoading(false);
        return;
      }
      void load();
    }).catch(() => {
      if (active) {
        setError('Could not load this delivery.');
        setLoading(false);
      }
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (router.canGoBack()) router.back();
      else if (id) router.replace(`/tasks/[taskId]` as never, { taskId: id } as never);
      else router.replace('/');
      return true;
    });
    return () => sub.remove();
  }, [router, id]);

  async function run(label: string, work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      const refreshed = id && isValidPartnerTaskId(id) ? await riderApi.task(id) : null;
      if (refreshed) setTask(refreshed);
      setError('');
      if (label === 'fail') {
        // Returned container: back to task once reported.
        if (router.canGoBack()) router.back();
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not complete the request.');
    } finally {
      setBusy(false);
    }
  }

  const subject = async () => (await ensurePartnerIdentity().catch(() => null))?.subject ?? 'unknown';

  async function recordContact() {
    if (!task || !id) return;
    await run('contact', async () => {
      const sub = await subject();
      await performAction(sub, id, 'contact-attempts', (key) => riderApi.taskAction(id, 'contact-attempts', {}, key));
    });
  }

  async function reportWrongAddress() {
    if (!task || !id || !wrongAddress.trim()) return;
    await run('wrong-address', async () => {
      const sub = await subject();
      await performAction(sub, id, 'wrong-address', (key) => riderApi.taskAction(id, 'wrong-address', { reason: wrongAddress.trim() }, key));
    });
  }

  async function reportFailed() {
    if (!task || !id) return;
    await run('fail', async () => {
      const sub = await subject();
      await performAction(sub, id, 'fail', (key) => riderApi.taskAction(id, 'fail', { reason }, key));
    });
  }

  async function chooseEvidence() {
    if (!task || !id) return;
    setEvidenceBusy(true);
    setEvidenceError('');
    try {
      const account = (await ensurePartnerIdentity().catch(() => null))?.subject ?? 'unknown';
      const mediaId = await uploadProof(id, account);
      if (mediaId) setEvidence(mediaId);
    } catch (failure) {
      setEvidenceError(failure instanceof ApiError || failure instanceof UploadError ? failure.message : 'Could not upload proof. Please try again.');
    } finally {
      setEvidenceBusy(false);
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    await load().catch(() => undefined);
    setRefreshing(false);
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else if (id) router.replace(`/tasks/[taskId]` as never, { taskId: id } as never);
    else router.replace('/');
  }

  const reasons: [string, string][] = task?.codAmountPaise !== null
    ? [['CUSTOMER_UNREACHABLE','Customer unreachable'],['PACKAGE_DAMAGED','Package damaged'],['VEHICLE_BREAKDOWN','Vehicle breakdown'],['COD_REFUSED','Cash refused']]
    : [['CUSTOMER_UNREACHABLE','Customer unreachable'],['PACKAGE_DAMAGED','Package damaged'],['VEHICLE_BREAKDOWN','Vehicle breakdown']];

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
        <PageTitle title="Report a problem" subtitle={task ? `Order ${task.orderNumber}` : 'Delivery issue'} />
        {loading ? (
          <CardListSkeleton label="Loading delivery for report" count={2} />
        ) : error && !task ? (
          <Card>
            <Text accessibilityRole="alert" style={styles.sub}>{error}</Text>
            <View style={{ height: 12 }} />
            <Button label="Try again" secondary onPress={() => void load()} />
          </Card>
        ) : task ? (
          <>
            <Card>
              <Text style={styles.strong}>Choose a reason</Text>
              <Text style={styles.sub}>The order will be returned or flagged according to your delivery stage. Server checks for custody and cash still apply.</Text>
              <View style={styles.chips}>
                {reasons.map(([value, label]) => <Chip key={value} label={label} active={reason === value} onPress={() => setReason(value)} />)}
              </View>
            </Card>
            <Card>
              <Text style={styles.strong}>Wrong address</Text>
              <Text style={styles.sub}>Describe what is wrong. This is reviewed before the delivery is failed.</Text>
              <TextInput value={wrongAddress} onChangeText={setWrongAddress} placeholder="Describe a wrong address" placeholderTextColor={colors.muted} style={styles.input} maxLength={300} />
              <Button label="Report wrong address" secondary compact disabled={busy || !wrongAddress.trim()} onPress={() => void reportWrongAddress()} />
            </Card>
            <Card>
              <Text style={styles.strong}>Contact attempts</Text>
              <Text style={styles.sub}>Record each call or visit. Reporting an unreachable customer requires the recorded attempts.</Text>
              <View style={{ height: 10 }} />
              <Button label="Record contact attempt" secondary compact disabled={busy} onPress={() => void recordContact()} />
            </Card>
            <Card>
              <Text style={styles.strong}>Evidence</Text>
              <Text style={styles.sub}>Attach a JPEG or PNG photo for a delivery issue that needs review.</Text>
              <View style={{ height: 10 }} />
              <Button label={evidence ? 'Photo uploaded' : evidenceBusy ? 'Uploading…' : 'Upload photo'} secondary compact disabled={evidenceBusy || busy} onPress={() => void chooseEvidence()} />
              {evidenceError ? <Text style={styles.error}>{evidenceError}</Text> : null}
              {evidence ? <Text style={styles.sub}>Evidence ready. Report the failure to include it.</Text> : null}
            </Card>
            <Button label="Report failed delivery" disabled={busy} onPress={() => void reportFailed()} />
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <Text style={styles.small}>If the report succeeds you will return to the delivery. If it is rejected, the message above explains the required step.</Text>
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
  small: { color: colors.secondary, fontSize: 10, marginTop: 8, lineHeight: 16 },
  input: { borderWidth: 1, borderColor: colors.lineStrong, backgroundColor: colors.backgroundTop, color: colors.text, paddingHorizontal: 12, minHeight: 48, borderRadius: 12, marginVertical: 10, fontFamily: fonts.regular },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 12 },
  error: { color: colors.danger, fontSize: 12, marginTop: 8 },
});
