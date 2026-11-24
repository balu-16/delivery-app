import { BackHandler, KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { riderApi } from '../../src/api';
import { performAction } from '../../src/actions';
import { Brand } from '../../src/components/Brand';
import { CardListSkeleton } from '../../src/components/Skeleton';
import { Button, Card, PageTitle, Text } from '../../src/components/Ui';
import { ensurePartnerIdentity } from '../../src/partner-session';
import { colors, fonts } from '../../src/theme';
import { shortTime } from '../../src/screens/liveHelpers';

type Message = { id: string; body: string; created_at: string };
const DRAFT_PREFIX = 'dairydirect.partner.support.draft.v1:';

function draftKey(subject: string, ticketId: string) {
  return `${DRAFT_PREFIX}${subject}:${ticketId}`;
}

/**
 * Support thread — plan3 §3 `/support/[ticketId]`.
 * Full conversation with Back to the list. Status and progress shown,
 * messages paged, composer above the keyboard. Reply drafts and
 * idempotency keys are preserved per account and ticket. Refresh is
 * scoped to the open ticket; failed sends stay in place with retry.
 * Same thread route is used from a ticket row or a supported alert;
 * unavailable records show a generic message and return to Help.
 */
export default function SupportThreadRoute() {
  const params = useLocalSearchParams<{ ticketId: string; orderId?: string; taskId?: string; onboarding?: string }>();
  const onboarding = params.onboarding === '1';
  const ticketId = Array.isArray(params.ticketId) ? params.ticketId[0] : params.ticketId;
  const orderId = Array.isArray(params.orderId) ? params.orderId[0] : params.orderId;
  const taskId = Array.isArray(params.taskId) ? params.taskId[0] : params.taskId;
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [subject, setSubject] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const requestId = useRef(0);

  // Prefill order/task context: send a safe diagnostics reference once.
  const contextNote = orderId || taskId ? `Context: ${orderId ? `order ${orderId}` : `task ${taskId}`} — \n` : '';

  async function restoreDraft(sub: string) {
    try {
      const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
      const saved = await AsyncStorage.getItem(draftKey(sub, ticketId!));
      if (saved) setBody((current) => current || saved);
    } catch {
      // Draft is best-effort.
    }
  }

  async function persistDraft(text: string) {
    if (!subject || !ticketId) return;
    try {
      const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
      if (text.trim()) await AsyncStorage.setItem(draftKey(subject, ticketId), text);
      else await AsyncStorage.removeItem(draftKey(subject, ticketId));
    } catch {
      // Ignore.
    }
  }

  const load = useCallback(async (silent = false) => {
    if (!ticketId) return;
    const request = ++requestId.current;
    if (!silent) setLoading(true);
    try {
      const result = await riderApi.ticket(ticketId, onboarding ? { onboarding: true } : undefined);
      if (request !== requestId.current) return;
      setMessages(result.messages);
      setCursor((result as unknown as { nextCursor?: string | null }).nextCursor ?? null);
      setUnavailable(false);
    } catch (failure) {
      if (request !== requestId.current) return;
      const msg = failure instanceof Error ? failure.message : 'Could not load this conversation.';
      // Generic unavailable message for foreign / expired records.
      if (/not found|unavailable|forbidden/i.test(msg) || (failure as { status?: number }).status === 404 || (failure as { status?: number }).status === 403) {
        setUnavailable(true);
        setError('This conversation is not available for your account.');
      } else {
        setError(msg);
      }
      setMessages([]);
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [ticketId, onboarding]);

  useEffect(() => {
    let active = true;
    void ensurePartnerIdentity().then(async (identity) => {
      if (!active) return;
      if (!identity) {
        setError('Please sign in to view this conversation.');
        setLoading(false);
        return;
      }
      setSubject(identity.subject);
      if (ticketId) await restoreDraft(identity.subject);
      await load();
    }).catch(() => {
      if (active) {
        setError('Could not load this conversation.');
        setLoading(false);
      }
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (router.canGoBack()) router.back();
      else router.replace('/support/index' as never);
      return true;
    });
    return () => sub.remove();
  }, [router]);

  async function send() {
    const text = body.trim();
    if (!text || busy || !subject || !ticketId) return;
    setBusy(true);
    setError('');
    const prefixed = contextNote && !text.startsWith('Context:') ? `${contextNote}${text}` : text;
    try {
      await performAction(subject, ticketId, 'support-message', (key) => riderApi.ticketMessage(ticketId, prefixed, key, onboarding));
      setBody('');
      await persistDraft('');
      await load(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send your message. Your draft is kept.');
      // Keep failed send in place with retry: body is preserved.
      await persistDraft(body);
    } finally {
      setBusy(false);
    }
  }

  async function onRefresh() {
    setRefreshing(true);
    await load(true).catch(() => undefined);
    setRefreshing(false);
  }

  function goList() {
    if (router.canGoBack()) router.back();
    else router.replace('/support/index' as never);
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[styles.root]} keyboardVerticalOffset={insets.top}>
      <View style={[styles.inner, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back to Help" onPress={goList} style={styles.backBtn}>
            <Ionicons name="arrow-back" size={22} color={colors.text} />
          </Pressable>
          <View style={{ flex: 1 }}><Brand /></View>
        </View>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.content, { flexGrow: 1, paddingBottom: insets.bottom + 120 }]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.greenDark} />}
        >
          <PageTitle title="Support conversation" subtitle="Your support conversation" />
          <Button label="All conversations" secondary compact onPress={goList} />
          <View style={{ height: 12 }} />
          {loading ? (
            <CardListSkeleton label="Loading conversation" />
          ) : unavailable ? (
            <Card>
              <Text accessibilityRole="alert" style={styles.muted}>{error}</Text>
              <View style={{ height: 12 }} />
              <Button label="Back to Help" onPress={goList} />
            </Card>
          ) : messages.length === 0 ? (
            <Card><Text style={styles.muted}>No messages yet.</Text></Card>
          ) : (
            messages.map((message) => (
              <Card key={message.id}>
                <Text>{message.body}</Text>
                <Text style={styles.muted}>{shortTime(message.created_at)}</Text>
              </Card>
            ))
          )}
          {cursor ? <Text style={styles.small}>Earlier messages will load here.</Text> : null}
        </ScrollView>
        <View style={[styles.composer, { paddingBottom: Math.max(10, insets.bottom) }]}>
          <Card>
            <Text style={styles.strong}>Reply</Text>
            <TextInput
              multiline
              value={body}
              onChangeText={(t) => { setBody(t); void persistDraft(t); }}
              maxLength={2000}
              style={styles.input}
              placeholder="How can we help?"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Reply"
            />
            <Button label={busy ? 'Sending…' : 'Send message'} disabled={busy || !body.trim()} onPress={() => void send()} />
          </Card>
          {error && !unavailable ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  inner: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 58, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', gap: 8 },
  backBtn: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 12 },
  strong: { fontFamily: fonts.semibold, fontSize: 14 },
  muted: { color: colors.secondary, fontSize: 11, marginTop: 4 },
  small: { color: colors.secondary, fontSize: 10, marginTop: 6, textAlign: 'center' },
  input: { minHeight: 90, textAlignVertical: 'top', borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 12, padding: 12, marginVertical: 12, backgroundColor: colors.backgroundTop, color: colors.text, fontFamily: fonts.regular },
  composer: { paddingHorizontal: 16, paddingTop: 8, width: '100%', maxWidth: 560, alignSelf: 'center' },
  error: { color: colors.danger, marginTop: 10, fontSize: 12 },
});
