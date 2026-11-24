import { BackHandler, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useEffect, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { riderApi, type Ticket } from '../../src/api';
import { performAction } from '../../src/actions';
import { Brand } from '../../src/components/Brand';
import { CardListSkeleton } from '../../src/components/Skeleton';
import { Button, Card, IconBox, PageTitle, Text } from '../../src/components/Ui';
import { ensurePartnerIdentity } from '../../src/partner-session';
import { colors, fonts } from '../../src/theme';
import { shortTime } from '../../src/screens/liveHelpers';

/**
 * Support inbox — plan3 §3 `/support`.
 * Full request list with Back to the caller. Cold start waits for the
 * correct signed-in account; pending applicants see the same stack with
 * the ONBOARDING category available. The composer stays above the
 * keyboard; drafts and idempotency keys are preserved per account/ticket.
 */
export default function SupportListRoute() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ prefill?: string; category?: string; onboarding?: string }>();
  const onboarding = params.onboarding === '1';

  const [subject, setSubject] = useState<string | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<'loading' | 'success' | 'error'>('loading');
  const [error, setError] = useState('');
  const [body, setBody] = useState(() => (typeof params.prefill === 'string' ? params.prefill : ''));
  const [category, setCategory] = useState(() => (params.category === 'ONBOARDING' || params.category === 'DELIVERY' ? params.category : 'DELIVERY'));
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [moreLoading, setMoreLoading] = useState(false);

  async function load() {
    setState('loading');
    setError('');
    try {
      const page = await riderApi.tickets(undefined, onboarding ? { onboarding: true } : undefined);
      setTickets(page.items);
      setCursor(page.nextCursor);
      setState('success');
    } catch (failure) {
      setState((prev) => (prev === 'success' ? prev : 'error'));
      setError(failure instanceof Error ? failure.message : 'Could not load support.');
    }
  }

  useEffect(() => {
    let active = true;
    void ensurePartnerIdentity().then((identity) => {
      if (!active) return;
      if (!identity) {
        setError('Please sign in to view support.');
        setState('error');
        setLoading(false);
        return;
      }
      setSubject(identity.subject);
      setLoading(false);
      void load();
    }).catch(() => {
      if (active) {
        setError('Could not load support.');
        setState('error');
        setLoading(false);
      }
    });
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    await load();
    setRefreshing(false);
  }

  async function send() {
    const text = body.trim();
    if (!text || busy || !subject) return;
    setBusy(true);
    setError('');
    try {
      const ticket = await performAction(subject, 'new', 'support-ticket', (key) => riderApi.createTicket(category, text, key));
      setBody('');
      router.push(`/support/[ticketId]` as never, { ticketId: ticket.id, ...(onboarding ? { onboarding: "1" } : {}) } as never);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not send your message.');
    } finally {
      setBusy(false);
    }
  }

  async function more() {
    if (!cursor || moreLoading) return;
    setMoreLoading(true);
    try {
      const page = await riderApi.tickets(cursor, onboarding ? { onboarding: true } : undefined);
      setTickets((prev) => [...prev, ...page.items]);
      setCursor(page.nextCursor);
    } catch {
      setError('Could not load conversations.');
    } finally {
      setMoreLoading(false);
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
        <PageTitle title="Help & support" subtitle="Send a message to the support team." />
        {loading || state === 'loading' && tickets.length === 0 ? (
          <CardListSkeleton label="Loading support conversations" />
        ) : state === 'error' && tickets.length === 0 ? (
          <Card>
            <Text accessibilityRole="alert" style={styles.muted}>{error || 'Could not load support.'}</Text>
            <View style={{ height: 12 }} />
            <Button label="Try again" secondary compact onPress={() => void load()} />
          </Card>
        ) : tickets.length === 0 ? (
          <Text style={styles.muted}>No conversations yet.</Text>
        ) : (
          <>
            {tickets.map((ticket) => (
              <Pressable key={ticket.id} accessibilityRole="button" onPress={() => router.push(`/support/[ticketId]` as never, { ticketId: ticket.id } as never)}>
                <Card>
                  <View style={styles.row}>
                    <IconBox name="chatbubble-ellipses-outline" />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.strong}>{ticket.category}</Text>
                      <Text style={styles.muted}>{ticket.status.replaceAll('_', ' ')} · {shortTime(ticket.created_at)}</Text>
                    </View>
                  </View>
                </Card>
              </Pressable>
            ))}
            {cursor ? <Button label={moreLoading ? 'Loading…' : 'Load more'} secondary compact disabled={moreLoading} onPress={() => void more()} /> : null}
          </>
        )}
        <Card>
          <Text style={styles.strong}>Start a conversation</Text>
          <View style={styles.categories}>
            {['DELIVERY', 'PAYOUT', 'ONBOARDING', 'GENERAL'].map((c) => (
              <Pressable key={c} accessibilityRole="button" accessibilityState={{ selected: category === c }} onPress={() => setCategory(c)} style={[styles.cat, category === c && styles.catActive]}>
                <Text style={[styles.catText, category === c && styles.catTextActive]}>{c}</Text>
              </Pressable>
            ))}
          </View>
          <TextInput
            multiline
            value={body}
            onChangeText={setBody}
            maxLength={2000}
            style={styles.input}
            placeholder="How can we help?"
            placeholderTextColor={colors.muted}
            accessibilityLabel="Support message"
          />
          <Button label={busy ? 'Sending…' : 'Send message'} disabled={busy || !body.trim()} onPress={() => void send()} />
        </Card>
        {error && tickets.length > 0 ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
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
  strong: { fontFamily: fonts.semibold, fontSize: 14 },
  muted: { color: colors.secondary, fontSize: 11, marginTop: 4 },
  input: { minHeight: 90, textAlignVertical: 'top', borderWidth: 1, borderColor: colors.lineStrong, borderRadius: 12, padding: 12, marginVertical: 12, backgroundColor: colors.backgroundTop, color: colors.text, fontFamily: fonts.regular },
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  cat: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.raised },
  catActive: { backgroundColor: colors.green, borderColor: colors.green },
  catText: { fontSize: 10, fontFamily: fonts.medium },
  catTextActive: { color: colors.inverse },
  error: { color: colors.danger, marginTop: 10, fontSize: 12 },
});
