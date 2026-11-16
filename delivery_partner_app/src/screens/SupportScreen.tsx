import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { performAction } from '../actions';
import { riderApi, type Ticket } from '../api';
import { Button, Card, IconBox, PageTitle, Text } from '../components/Ui';
import { CardListSkeleton } from '../components/Skeleton';
import { colors, fonts } from '../theme';
import { shortTime } from './liveHelpers';

export function SupportScreen({ subject }: { subject: string }) {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<{ id: string; body: string; created_at: string }[]>([]);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [ticketsState, setTicketsState] = useState<'loading' | 'success' | 'error'>('loading');
  const [retry, setRetry] = useState(0), [messageLoading, setMessageLoading] = useState(false), [messageError, setMessageError] = useState(false), [moreLoading, setMoreLoading] = useState(false);
  const messageRequest = useRef(0);
  async function refresh(id = selected) {
    const list = await riderApi.tickets(); setTickets(list.items); setCursor(list.nextCursor);
    if (id) setMessages((await riderApi.ticket(id)).messages);
  }
  useEffect(() => {
    let active = true;
    void riderApi.tickets().then((page) => { if (active) { setTickets(page.items); setCursor(page.nextCursor); setTicketsState('success'); } })
      .catch((failure: unknown) => { if (active) { setTicketsState(previous => previous === 'success' ? previous : 'error'); setError(failure instanceof Error ? failure.message : 'Could not load support.'); } });
    return () => { active = false; };
  }, [retry, subject]);
  async function send() {
    const text = body.trim(); if (!text || busy || messageLoading || messageError) return;
    setBusy(true); setError('');
    try {
      if (selected) {
        await performAction(subject, selected, 'support-message', (key) => riderApi.ticketMessage(selected, text, key));
        setBody(''); await refresh(selected);
      } else {
        const ticket = await performAction(subject, 'new', 'support-ticket', (key) => riderApi.createTicket('DELIVERY', text, key));
        setBody(''); setSelected(ticket.id); await refresh(ticket.id);
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not send your message.'); }
    finally { setBusy(false); }
  }
  async function open(id: string) {
    const request = ++messageRequest.current;
    setSelected(id); setMessages([]); setError(''); setMessageLoading(true); setMessageError(false);
    try { const result = await riderApi.ticket(id); if (request === messageRequest.current) setMessages(result.messages); }
    catch (failure) { if (request === messageRequest.current) { setMessageError(true); setError(failure instanceof Error ? failure.message : 'Could not load messages.'); } }
    finally { if (request === messageRequest.current) setMessageLoading(false); }
  }
  return <>
    <PageTitle title="Help & support" subtitle={selected ? 'Your support conversation' : 'Send a message to the support team.'} />
    {selected ? <><Button label="All conversations" secondary compact onPress={() => { messageRequest.current++; setMessageLoading(false); setMessageError(false); setSelected(null); setMessages([]); }} />
      <View style={{ height: 12 }} />
      {messageLoading ? <CardListSkeleton label="Loading conversation" /> : messageError ? <Button label="Try again" secondary compact onPress={() => void open(selected)} /> : messages.map((message) => <Card key={message.id}><Text>{message.body}</Text><Text style={styles.muted}>{shortTime(message.created_at)}</Text></Card>)}
    </> : <>{ticketsState === 'loading' ? <CardListSkeleton label="Loading support conversations" /> : ticketsState === 'error' ? <Button label="Try again" secondary compact onPress={() => { setTicketsState('loading'); setError(''); setRetry(value => value + 1); }} /> : tickets.length === 0 ? <Text style={styles.muted}>No conversations yet.</Text> : tickets.map((ticket) => <Pressable key={ticket.id} onPress={() => void open(ticket.id)} accessibilityRole="button">
      <Card><View style={styles.row}><IconBox name="chatbubble-ellipses-outline" /><View><Text style={styles.strong}>{ticket.category}</Text><Text style={styles.muted}>{ticket.status.replaceAll('_', ' ')} · {shortTime(ticket.created_at)}</Text></View></View></Card>
    </Pressable>)}
      {cursor ? <Button label={moreLoading ? 'Loading…' : 'Load more'} secondary compact disabled={moreLoading} onPress={() => { setMoreLoading(true); void riderApi.tickets(cursor).then((page) => { setTickets((previous) => [...previous, ...page.items]); setCursor(page.nextCursor); }).catch(() => setError('Could not load conversations.')).finally(() => setMoreLoading(false)); }} /> : null}
    </>}
    <Card><Text style={styles.strong}>{selected ? 'Reply' : 'Start a conversation'}</Text>
      <TextInput multiline value={body} onChangeText={setBody} maxLength={2000} style={styles.input} placeholder="How can we help?" placeholderTextColor={colors.muted} />
      <Button label={busy ? 'Sending…' : 'Send message'} disabled={busy || messageLoading || messageError || !body.trim()} onPress={() => void send()} />
    </Card>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </>;
}
const styles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, strong: { fontFamily: fonts.semibold, fontSize: 14 },
  muted: { color: colors.secondary, fontSize: 11, marginTop: 4 }, input: { minHeight: 90, textAlignVertical: 'top', borderWidth: 1, borderColor: colors.lineStrong,
    borderRadius: 12, padding: 12, marginVertical: 12, backgroundColor: colors.backgroundTop, color: colors.text, fontFamily: fonts.regular }, error: { color: colors.danger, marginBottom: 10 } });
