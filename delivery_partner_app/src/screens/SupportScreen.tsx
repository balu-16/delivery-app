import { memo, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { performAction } from '../actions';
import { riderApi, type Ticket } from '../api';
import { Button, Card, IconBox, PageTitle, Text } from '../components/Ui';
import { CardListSkeleton } from '../components/Skeleton';
import { colors, fonts } from '../theme';
import { useRefresh } from '../useRefresh';
import { dedupedRead, liveRequestGeneration, shortTime } from './liveHelpers';

type SupportMessage = { id: string; body: string; created_at: string };

const TicketRow = memo(function TicketRow({ ticket, onOpen }: { ticket: Ticket; onOpen: (id: string) => void }) {
  return <Pressable onPress={() => onOpen(ticket.id)} accessibilityRole="button">
    <Card><View style={styles.row}><IconBox name="chatbubble-ellipses-outline" /><View><Text style={styles.strong}>{ticket.category}</Text><Text style={styles.muted}>{ticket.status.replaceAll('_', ' ')} · {shortTime(ticket.created_at)}</Text></View></View></Card>
  </Pressable>;
});

const MessageRow = memo(function MessageRow({ message }: { message: SupportMessage }) {
  return <Card><Text>{message.body}</Text><Text style={styles.muted}>{shortTime(message.created_at)}</Text></Card>;
});

export function SupportScreen({ subject, refreshSignal = 0, onboarding = false, initialDraft = '' }: {
  subject: string;
  refreshSignal?: number;
  onboarding?: boolean;
  initialDraft?: string;
}) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [help, setHelp] = useState<import('../api').AppContentItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [body, setBody] = useState(initialDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [ticketsState, setTicketsState] = useState<'loading' | 'success' | 'error'>('loading');
  const [retry, setRetry] = useState(0), [messageLoading, setMessageLoading] = useState(false), [messageError, setMessageError] = useState(false), [moreLoading, setMoreLoading] = useState(false);
  const messageRequest = useRef(0);
  const scope = onboarding ? 'onboarding:' : '';
  const selectedRef = useRef(selected);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  async function refreshTickets() {
    const generation = liveRequestGeneration();
    try {
      const page = await dedupedRead(subject, `${scope}tickets`, signal => riderApi.tickets(undefined, { onboarding, signal }));
      if (generation !== liveRequestGeneration()) return;
      setTickets(page.items); setCursor(page.nextCursor); setTicketsState('success');
    } catch (failure) {
      if (generation !== liveRequestGeneration()) return;
      setTicketsState(previous => previous === 'success' ? previous : 'error');
      setError(failure instanceof Error ? failure.message : 'Could not load support.');
    }
  }
  async function refreshMessages(id: string) {
    const generation = liveRequestGeneration();
    const request = ++messageRequest.current;
    setMessageLoading(true); setMessageError(false);
    try {
      const result = await dedupedRead(subject, `${scope}ticket:${id}`, signal => riderApi.ticket(id, { onboarding, signal }));
      if (generation !== liveRequestGeneration() || request !== messageRequest.current) return;
      setMessages(result.messages);
      setMessagesLoaded(true);
    } catch (failure) {
      if (generation !== liveRequestGeneration() || request !== messageRequest.current) return;
      setMessageError(true); setError(failure instanceof Error ? failure.message : 'Could not load messages.');
    } finally { if (request === messageRequest.current && generation === liveRequestGeneration()) setMessageLoading(false); }
  }
  async function refresh(id = selectedRef.current) {
    await Promise.all([refreshTickets(), id ? refreshMessages(id) : undefined]);
  }
  const refreshVisible = () => selectedRef.current ? refreshMessages(selectedRef.current) : refreshTickets();
  const pull = useRefresh(refreshVisible);
  const pullProps = { refreshing: pull.refreshing, onRefresh: () => { void pull.onRefresh(); } };
  const refreshed = useRef(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      const generation = liveRequestGeneration();
      try {
        const page = await dedupedRead(subject, `${scope}tickets`, signal => riderApi.tickets(undefined, { onboarding, signal }));
        if (!active || generation !== liveRequestGeneration()) return;
        setTickets(page.items); setCursor(page.nextCursor); setTicketsState('success');
      } catch (failure) {
        if (!active || generation !== liveRequestGeneration()) return;
        setTicketsState(previous => previous === 'success' ? previous : 'error');
        setError(failure instanceof Error ? failure.message : 'Could not load support.');
      }
    })();
    return () => { active = false; };
  }, [onboarding, retry, scope, subject]);
  // Pull-to-refresh: revalidate the ticket list (and open conversation)
  // without dropping the visible content or the draft reply.
  useEffect(() => {
    if (refreshSignal === 0 || refreshed.current === refreshSignal) return;
    refreshed.current = refreshSignal;
    void refreshVisible();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);
  // RIDER_HELP (customize2 §3E): prior view kept during refresh.
  useEffect(() => {
    let active = true;
    riderApi.appContent('en').then((items) => { if (active) setHelp(items); }).catch(() => undefined);
    return () => { active = false; };
  }, [subject]);
  const helpItem = help?.find(item => item.slot === 'RIDER_HELP');
  const helpCard = helpItem?.state === 'VISIBLE'
    ? <Card><Text style={styles.strong}>{helpItem.title ?? 'Help & support'}</Text>{helpItem.body ? <Text style={styles.muted}>{helpItem.body}</Text> : null}</Card>
    : helpItem?.state === 'DISABLED' || helpItem?.state === 'INACTIVE' ? null : null;
  async function send() {
    const text = body.trim(); if (!text || busy || messageLoading || messageError) return;
    setBusy(true); setError('');
    try {
      if (selected) {
        await performAction(subject, selected, 'support-message', (key) => riderApi.ticketMessage(selected, text, key, onboarding));
        setBody(''); await refresh(selected);
      } else {
        const category = onboarding ? 'ONBOARDING' : 'DELIVERY';
        const ticket = await performAction(subject, `${scope}new`, 'support-ticket', (key) => riderApi.createTicket(category, text, key));
        setBody(''); setMessagesLoaded(false); setSelected(ticket.id); await refresh(ticket.id);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send your message.'); }
    finally { setBusy(false); }
  }
  async function open(id: string) {
    setSelected(id);
    setMessages([]);
    setMessagesLoaded(false);
    setError('');
    await refreshMessages(id);
  }
  async function moreTickets() {
    if (!cursor || moreLoading) return;
    const current = cursor;
    setMoreLoading(true);
    try {
      const page = await dedupedRead(subject, `${scope}tickets:${current}`, signal => riderApi.tickets(current, { onboarding, signal }));
      setTickets((previous) => [...previous, ...page.items]); setCursor(page.nextCursor);
    } catch { setError('Could not load conversations.'); }
    finally { setMoreLoading(false); }
  }
  const reply = <Card><Text style={styles.strong}>{selected ? 'Reply' : 'Start a conversation'}</Text>
    <TextInput accessibilityLabel={selected ? 'Reply message' : 'Help message'} multiline value={body} onChangeText={setBody} maxLength={2000} style={styles.input} placeholder="How can we help?" placeholderTextColor={colors.muted} />
    <Button label={busy ? 'Sending…' : 'Send message'} disabled={busy || messageLoading || messageError || !body.trim()} onPress={() => void send()} />
  </Card>;
  const errorLine = error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null;
  const canShowMessages = messagesLoaded || (!messageLoading && !messageError);
  const allConversations = () => {
    messageRequest.current++;
    setMessageLoading(false);
    setMessageError(false);
    setSelected(null);
    setMessages([]);
    setMessagesLoaded(false);
    setError('');
  };
  if (selected) return <View style={styles.root}>
    <View style={styles.list}>
      {canShowMessages ? <FlatList {...pullProps} data={messages} removeClippedSubviews keyExtractor={(message) => message.id}
        renderItem={({ item }) => <MessageRow message={item} />}
        ListHeaderComponent={<><PageTitle title="Help & support" subtitle="Your support conversation" />{helpCard}
          <Button label="All conversations" secondary compact onPress={allConversations} />
          <View style={{ height: 12 }} /></>}
        ListFooterComponent={<>{reply}{errorLine}</>} /> : <>
        <Button label="All conversations" secondary compact onPress={allConversations} />
        {messageLoading
          ? <CardListSkeleton label="Loading conversation" />
          : <Button label="Try again" secondary compact onPress={() => void refreshMessages(selected)} />}
        {reply}{errorLine}
      </>}
    </View>
  </View>;
  return <View style={styles.root}>
    <View style={styles.list}>
      {ticketsState === 'loading' ? <CardListSkeleton label="Loading support conversations" /> : ticketsState === 'error' ? <><Button label="Try again" secondary compact onPress={() => { setTicketsState('loading'); setError(''); setRetry(value => value + 1); }} />{reply}{errorLine}</> : <FlatList {...pullProps} data={tickets} removeClippedSubviews keyExtractor={(ticket) => ticket.id}
        renderItem={({ item }) => <TicketRow ticket={item} onOpen={open} />}
        ListHeaderComponent={<><PageTitle title="Help & support" subtitle="Send a message to the support team." />{helpCard}</>}
        ListEmptyComponent={<Text style={styles.muted}>No conversations yet.</Text>}
        ListFooterComponent={<>{cursor ? <Button label={moreLoading ? 'Loading…' : 'Load more'} secondary compact disabled={moreLoading} onPress={() => void moreTickets()} /> : null}{reply}{errorLine}</>} />}
    </View>
  </View>;
}
const styles = StyleSheet.create({ root: { flex: 1 }, list: { flex: 1, width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, strong: { fontFamily: fonts.semibold, fontSize: 14 },
  muted: { color: colors.secondary, fontSize: 11, marginTop: 4 }, input: { minHeight: 90, textAlignVertical: 'top', borderWidth: 1, borderColor: colors.lineStrong,
    borderRadius: 12, padding: 12, marginVertical: 12, backgroundColor: colors.backgroundTop, color: colors.text, fontFamily: fonts.regular }, error: { color: colors.danger, marginBottom: 10 } });
