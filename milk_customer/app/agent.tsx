import { Ionicons } from '@expo/vector-icons';
import { randomUUID } from 'expo-crypto';
import { router, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AssistantCard } from '@/components/connected/AssistantCard';
import { AddressPanel } from '@/components/connected/AddressPanel';
import { agentClient } from '@/src/agent/client';
import { agentStrings } from '@/src/agent/strings';
import type { AgentCard, AgentConfig, AgentEvent, AgentLocale, AgentMessage, AgentThread } from '@/src/agent/types';
import { useCustomer } from '@/src/store/customer';

const initialConfig: AgentConfig = { enabled: false, suggestedPrompts: [], maxMessageChars: 2000, disclosureVersion: '1', supportedLocales: ['en', 'hi', 'te'] };
function localeFor(value?: string | null): AgentLocale { return value === 'hi' || value === 'te' ? value : 'en'; }
function extractCard(data: Record<string, unknown>): AgentCard | null {
  if (typeof data.cardId !== 'string' || typeof data.type !== 'string' || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) return null;
  return { cardId: data.cardId, type: data.type as AgentCard['type'], payload: data.payload as Record<string, unknown> };
}

export default function AssistantScreen() {
  const profile = useCustomer(state => state.profile);
  const locale = localeFor(profile?.locale);
  return <AssistantConversation key={`${profile?.userId ?? ''}:${locale}`} locale={locale} />;
}

function AssistantConversation({ locale }: { locale: AgentLocale }) {
  const insets = useSafeAreaInsets(), t = agentStrings(locale);
  const [config, setConfig] = useState(initialConfig), [consent, setConsent] = useState<'loading' | 'required' | 'accepted'>('loading');
  const [thread, setThread] = useState<AgentThread | null>(null), [input, setInput] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false), [feedback, setFeedback] = useState<Record<string, 'up' | 'down'>>({});
  const [addressOpen, setAddressOpen] = useState(false);
  const controller = useRef<AbortController | null>(null), pending = useRef<{ id: string; text: string } | null>(null);
  const list = useRef<FlatList<AgentMessage>>(null);
  const shouldScrollToEnd = useRef(true);

  useEffect(() => {
    let active = true;
    void Promise.all([agentClient.config(locale), agentClient.consentStatus()]).then(async ([settings, state]) => {
      if (!active) return;
      setConfig(settings);
      if (!settings.enabled) throw new Error('AGENT_DISABLED');
      if (!state.accepted || state.version !== settings.disclosureVersion) { setConsent('required'); return; }
      const current = await agentClient.current();
      if (active) { setThread(current); setConsent('accepted'); }
    }).catch(() => { if (active) { setError(t.error); setConsent('loading'); } });
    return () => { active = false; controller.current?.abort(); };
  }, [locale, t.error]);

  const refresh = useCallback(async () => { const current = await agentClient.current(); setThread(current); }, []);
  const accept = async () => {
    setBusy(true); setError('');
    try { await agentClient.consent(config.disclosureVersion); const current = await agentClient.current(); setThread(current); setConsent('accepted'); }
    catch { setError(t.error); } finally { setBusy(false); }
  };
  const newChat = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { setThread(await agentClient.create()); pending.current = null; setCanRetry(false); }
    catch { setError(t.error); } finally { setBusy(false); }
  };
  const loadEarlier = async () => {
    if (!thread?.nextCursor || loadingHistory) return;
    const { id, nextCursor } = thread;
    setLoadingHistory(true); setError('');
    try {
      const page = await agentClient.history(id, nextCursor);
      shouldScrollToEnd.current = false;
      setThread(current => current?.id === id ? { ...current, messages: [...page.items, ...current.messages], nextCursor: page.nextCursor } : current);
    } catch { setError(t.error); } finally { setLoadingHistory(false); }
  };
  const rate = async (messageId: string, rating: 'up' | 'down') => {
    try { await agentClient.feedback(messageId, rating); setFeedback(current => ({ ...current, [messageId]: rating })); }
    catch { setError(t.error); }
  };
  const run = async (kind: 'message' | 'resume', details: { id: string; text?: string; decision?: 'approve' | 'reject' }) => {
    if (!thread || busy) return;
    const abort = new AbortController(); controller.current = abort; setBusy(true); setError(''); setStatus(t.thinking);
    const temporaryId = randomUUID();
    if (kind === 'message') {
      setThread(current => current ? { ...current, messages: [...current.messages, { id: details.id, role: 'user', text: details.text ?? '', cards: [], createdAt: new Date().toISOString() }, { id: temporaryId, role: 'assistant', text: '', cards: [], createdAt: new Date().toISOString() }] } : current);
    } else setThread(current => current ? { ...current, messages: [...current.messages, { id: temporaryId, role: 'assistant', text: '', cards: [], createdAt: new Date().toISOString() }] } : current);
    let runFailure = '';
    const onEvent = (event: AgentEvent) => {
      if (event.event === 'tool.status') setStatus(t.thinking);
      if (event.event === 'run.error') {
        runFailure = typeof event.data.code === 'string' ? event.data.code : 'AGENT_UNAVAILABLE';
        setError(runFailure === 'DRAFT_PENDING' ? t.draftPending : t.error);
      }
      if (event.event === 'message.delta' && typeof event.data.text === 'string') {
        const delta = event.data.text;
        setThread(current => current ? { ...current, messages: current.messages.map(message => message.id === temporaryId ? { ...message, text: message.text + delta } : message) } : current);
      }
      if (event.event === 'card') {
        const card = extractCard(event.data);
        if (card) setThread(current => current ? { ...current, messages: current.messages.map(message => message.id === temporaryId ? { ...message, cards: [...message.cards, card] } : message) } : current);
      }
    };
    try {
      if (kind === 'message') await agentClient.message(thread.id, details.id, details.text ?? '', locale, abort.signal, onEvent);
      else await agentClient.resume(thread.id, details.id, details.decision!, locale, abort.signal, onEvent);
      pending.current = null; setCanRetry(false);
      await refresh();
      if (runFailure && kind === 'message') setInput(current => current || details.text || '');
      if (!runFailure) void AccessibilityInfo.announceForAccessibility(t.completed);
    } catch {
      if (abort.signal.aborted) { pending.current = null; setCanRetry(false); setStatus(t.stopped); try { await agentClient.cancel(thread.id); await refresh(); } catch { /* A committed action is reconciled on next open. */ } }
      else { setError(t.offline); try { await refresh(); } catch { /* Keep the on-screen response until reconnection. */ } }
    } finally { controller.current = null; setBusy(false); setStatus(''); }
  };
  const send = (value = input) => {
    const text = value.trim(); if (!text || busy || text.length > config.maxMessageChars) return;
    const current = pending.current?.text === text ? pending.current : { id: randomUUID(), text };
    pending.current = current; setCanRetry(true); setInput(''); void run('message', current);
  };
  const cardAction = async (cardId: string, action: string, payload: Record<string, unknown>) => {
    if (!thread || busy) return;
    if (action === 'open_screen') {
      if (payload.screen === 'addresses') setAddressOpen(true);
      else if (payload.screen === 'cart') router.push('/cart' as Href);
      else if (payload.screen === 'orders') router.push('/my-dairy' as Href);
      return;
    }
    setBusy(true); setError('');
    try { await agentClient.action(thread.id, cardId, action, payload); await refresh(); }
    catch { setError(t.error); } finally { setBusy(false); }
  };
  const renderMessage = ({ item }: { item: AgentMessage }) => <View style={[styles.message, item.role === 'user' ? styles.userMessage : styles.assistantMessage]}>
    {!!item.text && <Text selectable style={styles.body}>{item.text}</Text>}
    {item.cards.map(card => <AssistantCard key={card.cardId} card={card} locale={locale} busy={busy} onDecision={(id, decision) => void run('resume', { id, decision })} onAction={(id, action, payload) => void cardAction(id, action, payload)} />)}
    {item.role === 'assistant' && !busy && !!(item.text || item.cards.length) && <View style={styles.feedback}>
      <Pressable accessibilityRole="button" accessibilityLabel={t.feedbackUp} accessibilityState={{ selected: feedback[item.id] === 'up' }} onPress={() => void rate(item.id, 'up')} hitSlop={8}><Ionicons name={feedback[item.id] === 'up' ? 'thumbs-up' : 'thumbs-up-outline'} size={18} color="#526c39" /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t.feedbackDown} accessibilityState={{ selected: feedback[item.id] === 'down' }} onPress={() => void rate(item.id, 'down')} hitSlop={8}><Ionicons name={feedback[item.id] === 'down' ? 'thumbs-down' : 'thumbs-down-outline'} size={18} color="#526c39" /></Pressable>
    </View>}
  </View>;
  return <View style={[styles.root, { paddingTop: insets.top }]}>
    <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel={t.close} hitSlop={12} onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color="#263520" /></Pressable><Text style={styles.headerTitle}>{t.title}</Text>{consent === 'accepted' && <Pressable accessibilityRole="button" disabled={busy} onPress={() => void newChat()} style={styles.headerButton}><Text style={styles.link}>{t.newChat}</Text></Pressable>}</View>
    {consent === 'required' ? <View style={styles.consent}><Ionicons name="chatbubble-ellipses-outline" size={36} color="#405f29" /><Text style={styles.heading}>{t.consentTitle}</Text><Text style={styles.body}>{t.consentBody}</Text>{!!error && <Text style={styles.error}>{error}</Text>}<Pressable accessibilityRole="button" disabled={busy} onPress={() => void accept()} style={styles.primary}><Text style={styles.primaryText}>{t.agree}</Text></Pressable><Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.secondary}><Text style={styles.link}>{t.decline}</Text></Pressable></View>
    : consent === 'loading' ? <View style={styles.consent}><Text style={styles.body}>{error || t.loading}</Text>{!!error && <Pressable onPress={() => router.back()} style={styles.secondary}><Text style={styles.link}>{t.close}</Text></Pressable>}</View>
    : <KeyboardAvoidingView style={styles.grow} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={insets.top}>
      <FlatList ref={list} data={thread?.messages ?? []} keyExtractor={item => item.id} renderItem={renderMessage} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled" onContentSizeChange={() => { if (shouldScrollToEnd.current) list.current?.scrollToEnd({ animated: false }); else shouldScrollToEnd.current = true; }} ListHeaderComponent={thread?.nextCursor ? <Pressable accessibilityRole="button" disabled={loadingHistory} onPress={() => void loadEarlier()} style={styles.chip}><Text style={styles.link}>{loadingHistory ? t.loadingEarlier : t.earlier}</Text></Pressable> : undefined} ListEmptyComponent={<View style={styles.empty}><Text style={styles.heading}>{t.greeting}</Text><View style={styles.suggestions}>{config.suggestedPrompts.map(prompt => <Pressable key={prompt} style={styles.chip} onPress={() => send(prompt)} accessibilityRole="button"><Text style={styles.link}>{prompt}</Text></Pressable>)}</View></View>} />
      {!!status && <Text style={styles.status}>{status}</Text>}{!!error && <View style={styles.errorRow}><Text style={styles.error}>{error}</Text>{canRetry && <Pressable onPress={() => send(pending.current?.text)}><Text style={styles.link}>{t.retry}</Text></Pressable>}</View>}
      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}><TextInput style={styles.input} multiline value={input} onChangeText={setInput} placeholder={t.input} accessibilityLabel={t.input} maxLength={config.maxMessageChars} editable={!busy} /><Pressable style={styles.send} accessibilityRole="button" accessibilityLabel={busy ? t.stop : t.send} disabled={!busy && !input.trim()} onPress={() => busy ? controller.current?.abort() : send()}><Ionicons name={busy ? 'stop' : 'send'} size={20} color="#fff" /></Pressable></View>
    </KeyboardAvoidingView>}
    <AddressPanel visible={addressOpen} onClose={() => setAddressOpen(false)} />
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f8f9f6' }, grow: { flex: 1 }, header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 18, backgroundColor: '#fff', borderBottomWidth: 1, borderColor: '#e1e3dc' }, headerTitle: { flex: 1, fontSize: 19, fontWeight: '700', color: '#263520' }, headerButton: { minHeight: 44, justifyContent: 'center' },
  consent: { flex: 1, justifyContent: 'center', padding: 28, gap: 18 }, heading: { color: '#263520', fontSize: 22, fontWeight: '700' }, body: { fontSize: 15, lineHeight: 22, color: '#293027' }, link: { color: '#365a25', fontWeight: '700' }, primary: { backgroundColor: '#405f29', minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12 }, primaryText: { color: '#fff', fontWeight: '700' }, secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  list: { padding: 16, gap: 12, flexGrow: 1 }, empty: { paddingVertical: 28, gap: 16 }, suggestions: { gap: 8, alignItems: 'flex-start' }, chip: { padding: 12, minHeight: 44, borderRadius: 18, borderWidth: 1, borderColor: '#d8dfd0', backgroundColor: '#fff' }, message: { maxWidth: '92%', borderRadius: 14, padding: 12, gap: 8 }, userMessage: { alignSelf: 'flex-end', backgroundColor: '#e3eddb' }, assistantMessage: { alignSelf: 'flex-start', backgroundColor: '#fff', borderWidth: 1, borderColor: '#e6e9e3' },
  status: { paddingHorizontal: 18, paddingBottom: 5, color: '#687263' }, errorRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 6 }, error: { color: '#a2382e', flexShrink: 1 }, composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: '#fff', paddingHorizontal: 12, paddingTop: 10, borderTopWidth: 1, borderColor: '#e1e3dc' }, input: { flex: 1, backgroundColor: '#f4f5f2', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, minHeight: 46, maxHeight: 120, color: '#252820', fontSize: 15 }, send: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: '#405f29' },
  feedback: { flexDirection: 'row', gap: 18, alignItems: 'center', paddingTop: 6 },
});
