import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Alert, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AssistantCard } from '@/components/connected/AssistantCard';
import { AddressPanel } from '@/components/connected/AddressPanel';
import { AssistantHelpSheet } from '@/components/connected/AssistantHelpSheet';
import { AssistantDecisionSheet } from '@/components/connected/AssistantDecisionSheet';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { addressContinuationKey, continuationText, lastShoppingRequest, readAddressContinuation, type AddressContinuation } from '@/src/agent/address-continuation';
import { decisionWasRecorded } from '@/src/agent/confirmation-recovery';
import { agentClient } from '@/src/agent/client';
import { pendingCardActionKey, readPendingCardAction, type PendingCardAction } from '@/src/agent/pending-card-action';
import { toolActivity, updateActiveTools } from '@/src/agent/activity';
import { agentStrings } from '@/src/agent/strings';
import type { AgentCard, AgentConfig, AgentEvent, AgentLocale, AgentMessage, AgentThread, AgentThreadSummary } from '@/src/agent/types';
import { useCustomer } from '@/src/store/customer';
import { usePushStatus } from '@/src/notifications/push';
import { customerApi, customerDetailsApi } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { ApiError } from '@/src/api/client';
import { requestMessage } from '@/src/api/messages';
import { distinctAddressCards, pendingLocationAddressId } from '@/src/agent/distinct-address-cards';
import { requireLocationServices } from '@/src/utils/location-policy';

const initialConfig: AgentConfig = { enabled: false, suggestedPrompts: [], maxMessageChars: 2000, disclosureVersion: '1', supportedLocales: ['en'] };
function extractCard(data: Record<string, unknown>): AgentCard | null {
  if (typeof data.cardId !== 'string' || typeof data.type !== 'string' || !data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload)) return null;
  return { cardId: data.cardId, type: data.type as AgentCard['type'], payload: data.payload as Record<string, unknown> };
}

export default function AssistantScreen() {
  const profile = useCustomer(state => state.profile);
  const params = useLocalSearchParams<{ threadId?: string; nudgeName?: string }>();
  const threadId = typeof params.threadId === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(params.threadId) ? params.threadId : undefined;
  const locale: AgentLocale = 'en';
  const nudgeName = typeof params.nudgeName === 'string' ? params.nudgeName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) : '';
  return <AssistantConversation key={`${profile?.userId ?? ''}:${locale}:${threadId ?? ''}:${nudgeName}`} userId={profile?.userId ?? ''} locale={locale} initialThreadId={threadId} profileName={profile?.name ?? ''} nudgeName={nudgeName} />;
}

function AssistantConversation({ userId, locale, initialThreadId, profileName, nudgeName }: { userId: string; locale: AgentLocale; initialThreadId?: string; profileName: string; nudgeName: string }) {
  const insets = useSafeAreaInsets(), t = agentStrings(locale);
  const [config, setConfig] = useState(initialConfig), [consent, setConsent] = useState<'loading' | 'required' | 'accepted'>('loading');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [thread, setThread] = useState<AgentThread | null>(null), [input, setInput] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const [cardStorage, setCardStorage] = useState<{ threadId: string; recover: boolean } | null>(null);
  const cardStorageReady = !!thread && cardStorage?.threadId === thread.id;
  const recoverCardAction = cardStorageReady && cardStorage?.recover === true;
  const [loadingHistory, setLoadingHistory] = useState(false), [feedback, setFeedback] = useState<Record<string, 'up' | 'down'>>({});
  const [addressOpen, setAddressOpen] = useState(false);
  const [pendingContinuation, setPendingContinuation] = useState<AddressContinuation | null>(null);
  const addressList = useCustomer(state => state.addresses);
  const [nudgeVisible, setNudgeVisible] = useState(!!nudgeName);
  const [supportOpen, setSupportOpen] = useState(false);
  const [decisionCard, setDecisionCard] = useState<AgentCard | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false), [chatHistory, setChatHistory] = useState<AgentThreadSummary[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null), [historyBusy, setHistoryBusy] = useState(false), [historyError, setHistoryError] = useState('');
  const [addressSeed, setAddressSeed] = useState<{ addressId?: string; line1?: string; line2?: string; pincode?: string; phone?: string; contact?: string; focus?: 'line1' | 'pincode' | 'phone' } | undefined>();
  const [streaming, setStreaming] = useState(false);
  const [pendingAttach, setPendingAttach] = useState<{ threadId: string; runId: string } | null>(null);
  const [showBrowseNotice, setShowBrowseNotice] = useState(false), [alertsEnabled, setAlertsEnabled] = useState(false);
  const pushStatus = usePushStatus(state => state.status);
  const controller = useRef<AbortController | null>(null), pending = useRef<{ id: string; text: string } | null>(null);
  const cardActionInFlight = useRef(false);
  const locationCheckInFlight = useRef(false);
  const pendingCardAction = useRef<PendingCardAction | null>(null);
  const pendingDecision = useRef<{ draftId: string; decision: 'approve' | 'reject'; clientActionId: string } | null>(null);
  const continuationRef = useRef<AddressContinuation | null>(null);
  const continuationThread = useRef('');
  const continuationWrites = useRef(Promise.resolve());
  const mounted = useRef(false), stopRequested = useRef(false);
  const threadRef = useRef<AgentThread | null>(null);
  const attachRef = useRef<(threadId: string, runId: string) => void>(() => undefined);
  const continuationRunRef = useRef<(id: string, text: string) => void>(() => undefined);
  const attachedRun = useRef(''), sentContinuation = useRef('');
  const list = useRef<FlatList<AgentMessage>>(null);
  const shouldScrollToEnd = useRef(true);

  useEffect(() => { threadRef.current = thread; }, [thread]);

  useEffect(() => {
    let active = true;
    continuationRef.current = null; continuationThread.current = ''; sentContinuation.current = '';
    if (thread?.id && userId) void AsyncStorage.getItem(addressContinuationKey(userId, thread.id)).then(raw => {
      if (!active) return;
      if (!raw) {setPendingContinuation(null);return;}
      const saved = readAddressContinuation(raw);
      if (saved) {continuationRef.current = saved;continuationThread.current = thread.id;setPendingContinuation(saved);}
      else setError('The saved order continuation could not be restored. Please ask the assistant again.');
    }).catch(() => {if (active) setError('Could not restore the previous request. Please ask the assistant again.');});
    return () => {active = false;};
  }, [userId, thread?.id]);
  const saveContinuation = (value: AddressContinuation) => {
    if (!userId || !thread) return;
    continuationRef.current = value; continuationThread.current = thread.id; setPendingContinuation(value);
    const key = addressContinuationKey(userId, thread.id);
    continuationWrites.current = continuationWrites.current.then(() => AsyncStorage.setItem(key, JSON.stringify(value))).catch(() => {
      if (continuationRef.current?.id === value.id) {continuationRef.current = null;setPendingContinuation(null);}
      setError('Could not save the order continuation. Please ask the assistant again after confirming your location.');
    });
  };

  useEffect(() => {
    let active = true;
    mounted.current = true;
    void accessToken().then(token => customerDetailsApi.notificationPreferences(token)).then(preferences => {
      if (active) setAlertsEnabled(preferences.find(item => item.category === 'ASSISTANT_UPDATES')?.enabled === true);
    }).catch(() => { if (active) setAlertsEnabled(false); });
    void Promise.all([agentClient.config(locale), agentClient.consentStatus()]).then(async ([settings, state]) => {
      if (!active) return;
      setConfig(settings);
      if (!settings.enabled) throw new Error('AGENT_DISABLED');
      if (!state.accepted || state.version !== settings.disclosureVersion) { setConsent('required'); return; }
      const current = initialThreadId ? await agentClient.thread(initialThreadId) : await agentClient.current();
      if (active) { setThread(current); setConsent('accepted'); }
      if (current.status !== 'archived') {
        const job = await agentClient.currentRun(current.id).catch(() => null);
        if (active && job && (job.state === 'queued' || job.state === 'running')) {
          const latest = await agentClient.thread(current.id);
          if (active) { setThread(latest); setPendingAttach({ threadId: current.id, runId: job.id }); }
        } else if (active && job?.state === 'failed') setError(t.error);
      }
    }).catch(() => { if (active) { setError(t.error); setConsent('loading'); } });
    return () => { active = false; mounted.current = false; controller.current?.abort(); };
  }, [locale, t.error, initialThreadId, loadAttempt]);

  useEffect(() => {
    let active = true;
    pendingCardAction.current = null;
    if (!thread?.id) return () => { active = false; };
    const threadId = thread.id;
    void AsyncStorage.getItem(pendingCardActionKey(threadId)).then(raw => {
      if (!active) return;
      const saved = raw ? readPendingCardAction(raw) : null;
      if (raw && !saved) {
        setError('A previous cart update could not be restored safely. Review your cart and contact support before making another change.');
        return;
      }
      pendingCardAction.current = saved; setCardStorage({ threadId, recover: !!saved });
    }).catch(() => { if (active) setError('Could not restore your cart update. Check your connection and reopen the chat.'); });
    return () => { active = false; };
  }, [thread?.id]);
  const refresh = useCallback(async () => {
    const id = threadRef.current?.id;
    const current = id ? await agentClient.thread(id) : await agentClient.current();
    if (mounted.current) setThread(current);
    return current;
  }, []);
  const accept = async () => {
    setBusy(true); setError('');
    try {
      await agentClient.consent(config.disclosureVersion);
      const current = initialThreadId ? await agentClient.thread(initialThreadId) : await agentClient.current();
      setThread(current); setConsent('accepted');
      const job = await agentClient.currentRun(current.id).catch(() => null);
      if (job && (job.state === 'queued' || job.state === 'running')) setPendingAttach({ threadId: current.id, runId: job.id });
    }
    catch { setError(t.error); } finally { setBusy(false); }
  };
  const createChat = async () => {
    if (busy) return;
    if (!cardStorageReady || pendingCardAction.current) { setError('Finish the previous cart update before starting a new chat.'); return; }
    setBusy(true); setError('');
    try { setThread(await agentClient.create()); pending.current = null; setCanRetry(false); router.setParams({ threadId: undefined, nudgeName: undefined }); }
    catch { setError(t.error); } finally { setBusy(false); }
  };
  const newChat = () => {
    const pendingConfirmation = thread?.messages.some(message => message.cards.some(card => {
      if (!['order_confirm', 'cancel_confirm', 'refund_confirm'].includes(card.type)) return false;
      const status = typeof card.payload.status === 'string' ? card.payload.status : 'pending';
      const expiry = typeof card.payload.expiresAt === 'string' ? Date.parse(card.payload.expiresAt) : NaN;
      return status === 'pending' && (!Number.isFinite(expiry) || expiry > Date.now());
    }));
    if (!pendingConfirmation) { void createChat(); return; }
    Alert.alert('Start a new chat?', 'Your pending confirmation will be cancelled. You can still view this conversation in chat history.', [
      { text: 'Keep current chat', style: 'cancel' },
      { text: 'Start new chat', onPress: () => void createChat() },
    ]);
  };
  const loadChatHistory = async (cursor?: string) => {
    if (historyBusy) return;
    setHistoryBusy(true); setHistoryError('');
    try {
      const page = await agentClient.threads(cursor);
      setChatHistory(current => cursor ? [...current, ...page.items] : page.items);
      setHistoryCursor(page.nextCursor);
    } catch { setHistoryError('Could not load your chats. Please try again.'); }
    finally { setHistoryBusy(false); }
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
  const run = async (kind: 'message' | 'resume' | 'attach', details: { id: string; text?: string; decision?: 'approve' | 'reject'; threadId?: string }) => {
    const threadId = details.threadId ?? thread?.id;
    if (!threadId || streaming || (kind !== 'attach' && thread?.status === 'archived')) return;
    if (kind !== 'attach' && (!cardStorageReady || pendingCardAction.current)) { setError('Finish the previous cart update before continuing.'); return; }
    const isOrderApproval = kind === 'resume' && details.decision === 'approve' && thread?.messages.some(message => message.cards.some(card => card.type === 'order_confirm' && card.payload.draftId === details.id));
    if (isOrderApproval && !pendingDecision.current) {
      if (locationCheckInFlight.current) return;
      locationCheckInFlight.current = true;
      try { if (await useCustomer.getState().refreshDeliverySettings()) await requireLocationServices(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check location. Please try again.'); return; }
      finally { locationCheckInFlight.current = false; }
    }
    stopRequested.current = false;
    const abort = new AbortController(); controller.current = abort; setStreaming(true); setError(''); setStatus(t.activityPreparing);
    const temporaryId = randomUUID();
    if (kind === 'message') {
      setThread(current => current ? { ...current, messages: [...current.messages.filter(message => message.id !== details.id), { id: details.id, role: 'user', text: details.text ?? '', cards: [], createdAt: new Date().toISOString() }, { id: temporaryId, role: 'assistant', text: '', cards: [], createdAt: new Date().toISOString() }] } : current);
    } else setThread(current => current ? { ...current, messages: [...current.messages, { id: temporaryId, role: 'assistant', text: '', cards: [], createdAt: new Date().toISOString() }] } : current);
    let runFailure = '', activeTools: string[] = [], waitingForConfirmation = false, hasReply = false, runId = kind === 'attach' ? details.id : '', sequence = '';
    const onEvent = (event: AgentEvent) => {
      if (!mounted.current) return;
      if (event.sequence) sequence = event.sequence;
      if (event.event === 'run.started' && typeof event.data.runId === 'string') { runId = event.data.runId; setShowBrowseNotice(true); }
      if (event.event === 'tool.status' && typeof event.data.labelKey === 'string') {
        activeTools = updateActiveTools(activeTools, event.data.labelKey, event.data.phase);
        if (!waitingForConfirmation) setStatus(activeTools.length ? toolActivity(activeTools[activeTools.length - 1]!, t, details.decision) : hasReply ? '' : t.activityPreparing);
      }
      if (event.event === 'draft.required') { waitingForConfirmation = true; setStatus(t.activityWaiting); }
      if (event.event === 'run.error') {
        runFailure = typeof event.data.code === 'string' ? event.data.code : 'AGENT_UNAVAILABLE';
        setStatus('');
        if (!(runFailure === 'RUN_ABORTED' && stopRequested.current)) setError(runFailure === 'DRAFT_PENDING' ? t.draftPending : t.error);
      }
      if (event.event === 'message.delta' && typeof event.data.text === 'string') {
        const delta = event.data.text;
        hasReply = true;
        if (!activeTools.length && !waitingForConfirmation) setStatus('');
        setThread(current => current ? { ...current, messages: current.messages.map(message => message.id === temporaryId ? { ...message, text: message.text + delta } : message) } : current);
      }
      if (event.event === 'card') {
        const card = extractCard(event.data);
        if (card) {
          setThread(current => current ? { ...current, messages: current.messages.map(message => message.id === temporaryId ? { ...message, cards: [...message.cards, card] } : message) } : current);
          const addressId = pendingLocationAddressId(card);
          const original = threadRef.current?.id === threadId ? lastShoppingRequest(threadRef.current.messages) : undefined;
          if (addressId && original) {
            const existing = continuationRef.current;
            saveContinuation({id:existing?.sourceId === original.id ? existing.id : randomUUID(),sourceId:original.id,addressId,waitingForLocation:true,selected:false});
            void useCustomer.getState().refreshAddresses().catch(() => undefined);
          }
        }
      }
    };
    try {
      try {
        if (kind === 'message') await agentClient.message(threadId, details.id, details.text ?? '', locale, abort.signal, onEvent);
        else if (kind === 'resume') {
          const decision = details.decision!;
          const action = pendingDecision.current?.draftId === details.id && pendingDecision.current.decision === decision
            ? pendingDecision.current : { draftId: details.id, decision, clientActionId: randomUUID() };
          pendingDecision.current = action;
          await agentClient.resume(threadId, details.id, decision, locale, abort.signal, onEvent, action.clientActionId);
        }
        else await agentClient.followRun(threadId, details.id, abort.signal, onEvent);
      } catch (error) {
        if (abort.signal.aborted || !runId) throw error;
        await agentClient.followRun(threadId, runId, abort.signal, onEvent, sequence || undefined);
      }
      pending.current = null; setCanRetry(false);
      if (kind === 'resume') pendingDecision.current = null;
      const refreshed = await refresh();
      if (kind === 'message' && continuationRef.current?.id === details.id) {
        continuationRef.current = null; setPendingContinuation(null);
        await continuationWrites.current;
        await AsyncStorage.removeItem(addressContinuationKey(userId, threadId)).catch(() => undefined);
      }
      if (runFailure && kind === 'resume' && details.decision && decisionWasRecorded(refreshed, details.id, details.decision)) {
        // The action may have committed before a connection or model failure.
        // The refreshed card displays the authoritative recorded outcome.
        setError('');
        runFailure = '';
      }
      if (runFailure && kind === 'message') setInput(current => current || details.text || '');
      if (stopRequested.current) void AccessibilityInfo.announceForAccessibility(t.stopped);
      else if (!runFailure) void AccessibilityInfo.announceForAccessibility(t.completed);
    } catch (failure) {
      if (!abort.signal.aborted && mounted.current) {
        setError(failure instanceof ApiError ? requestMessage(failure, 'send this message') : runId ? t.activityOffline : t.offline);
        try {
          const refreshed = await refresh();
          if (kind === 'resume' && details.decision && decisionWasRecorded(refreshed, details.id, details.decision)) {
            pendingDecision.current = null;
            setError('');
          }
        } catch { /* Keep the on-screen response until reconnection. */ }
      }
    } finally {
      if (controller.current === abort) controller.current = null;
      if (mounted.current) { setStreaming(false); setStatus(''); setShowBrowseNotice(false); }
    }
  };
  const stop = async () => {
    if (!thread || !controller.current) return;
    stopRequested.current = true; setStatus(t.stopped);
    try { await agentClient.cancel(thread.id); }
    catch { stopRequested.current = false; setError(t.error); }
  };
  const send = (value = input) => {
    const text = value.trim(); if (!text || streaming || busy || thread?.status === 'archived' || text.length > config.maxMessageChars) return;
    if (!cardStorageReady || pendingCardAction.current) { setError('Finish the previous cart update before continuing.'); return; }
    if (/\b(?:never mind|nevermind|forget|cancel|stop)\b/i.test(text) && continuationRef.current && thread && userId) {
      continuationRef.current = null; setPendingContinuation(null);
      const key = addressContinuationKey(userId, thread.id);
      continuationWrites.current = continuationWrites.current.then(() => AsyncStorage.removeItem(key)).catch(() => undefined);
    }
    const current = pending.current?.text === text ? pending.current : { id: randomUUID(), text };
    pending.current = current; setCanRetry(true); setInput(''); void run('message', current);
  };
  const setRecoverCardAction = (recover: boolean) => setCardStorage(current =>
    current && current.threadId === thread?.id ? { ...current, recover } : current,
  );
  // Keep callbacks current after commit, before processing a reconnect or address handoff.
  useEffect(() => {
    attachRef.current = (threadId, runId) => { void run('attach', { id: runId, threadId }); };
    continuationRunRef.current = (id, text) => {pending.current = {id,text};setCanRetry(true);void run('message',{id,text});};
  });
  useEffect(() => {
    if (!busy && !streaming && pendingAttach && attachedRun.current !== pendingAttach.runId) {
      attachedRun.current = pendingAttach.runId;
      attachRef.current(pendingAttach.threadId, pendingAttach.runId);
    }
  }, [busy, streaming, pendingAttach]);
  useEffect(() => {
    if (continuationThread.current === thread?.id && pendingContinuation?.addressId && (pendingContinuation.selected || pendingContinuation.waitingForLocation) && addressList.some(item => item.id === pendingContinuation.addressId && (item.point || !useCustomer.getState().locationRequired)) && !busy && !streaming && cardStorageReady && !recoverCardAction && sentContinuation.current !== pendingContinuation.id) {
      const source = thread?.messages.find(message => message.id === pendingContinuation.sourceId);
      sentContinuation.current = pendingContinuation.id;
      if (!source) {void Promise.resolve().then(() => setError('Your location is confirmed. Please repeat your shopping request so the assistant can continue.'));return;}
      const text = continuationText(source.text);
      const address = addressList.find(item => item.id === pendingContinuation.addressId)!;
      void continuationWrites.current.then(async () => {
        if (!address.point && useCustomer.getState().locationRequired) return;
        const service = await customerApi.serviceability(await accessToken(),address.pincode);
        if (continuationRef.current?.id !== pendingContinuation.id) return;
        if (useCustomer.getState().selectedAddress !== address.id) {setError('Select the saved delivery address before continuing your request.');return;}
        if (!service.serviceable) {setError('Your address is saved, but delivery is not available there right now. Please try again later or choose another address.');return;}
        continuationRunRef.current(pendingContinuation.id,text);
      }).catch(() => setError('Your location is saved, but we could not check delivery. Check your connection and try your request again.'));
    }
  }, [pendingContinuation, addressList, thread, busy, streaming, cardStorageReady, recoverCardAction]);
  const cardAction = async (cardId: string, action: string, payload: Record<string, unknown>) => {
    if (!thread) return;
    if (action === 'open_screen') {
      if (payload.screen === 'addresses') {
        const original = lastShoppingRequest(thread.messages);
        const addressId = typeof payload.addressId === 'string' ? payload.addressId : null;
        const knownAddress = useCustomer.getState().addresses.find(item => item.id === addressId);
        if (original) {
          const existing = continuationRef.current;
          saveContinuation({id:existing?.sourceId === original.id ? existing.id : randomUUID(), sourceId:original.id, addressId, waitingForLocation:payload.needsLocation === true || (useCustomer.getState().locationRequired && knownAddress?.point === null), selected:false});
        }
        setAddressSeed({
          addressId: typeof payload.addressId === 'string' ? payload.addressId : undefined,
          line1: typeof payload.line1 === 'string' ? payload.line1 : undefined,
          line2: typeof payload.line2 === 'string' ? payload.line2 : undefined,
          pincode: typeof payload.pincode === 'string' ? payload.pincode : undefined,
          phone: typeof payload.phone === 'string' ? payload.phone : undefined,
          contact: typeof payload.contact === 'string' ? payload.contact : profileName || undefined,
          focus: payload.focus === 'line1' || payload.focus === 'pincode' || payload.focus === 'phone' ? payload.focus : undefined,
        });
        setAddressOpen(true);
      }
      else if (payload.screen === 'cart') router.push('/cart' as Href);
      else if (payload.screen === 'products') router.push('/products' as Href);
      else if (payload.screen === 'orders') router.push('/my-dairy' as Href);
      return;
    }
    if (streaming || busy || cardActionInFlight.current) return;
    if (!cardStorageReady) { setError('Your cart update is still being restored. Please try again.'); return; }
    if (action === 'retry_confirmation') {
      const type = typeof payload.type === 'string' ? payload.type : '';
      send(type === 'cancel_confirm' ? 'Please prepare the cancellation again.' : type === 'refund_confirm' ? 'Please prepare the refund request again.' : 'Please prepare my order again.');
      return;
    }
    const encoded = JSON.stringify(payload);
    const old = pendingCardAction.current;
    if (old && (old.cardId !== cardId || old.action !== action || old.payload !== encoded)) {
      setError('The previous cart update may still be processing. Please retry it before making another change.');
      return;
    }
    if (action !== 'add_to_cart') return;
    const current: PendingCardAction = old ?? { cardId, action, payload: encoded, id: randomUUID() };
    pendingCardAction.current = current;
    cardActionInFlight.current = true;
    setBusy(true); setError(''); setStatus(action === 'add_to_cart' ? t.activityAdding : t.activityPreparing);
    try {
      await AsyncStorage.setItem(pendingCardActionKey(thread.id), JSON.stringify(current));
      const result = await agentClient.action(thread.id, cardId, action, payload, current.id);
      await AsyncStorage.removeItem(pendingCardActionKey(thread.id));
      pendingCardAction.current = null;
      setRecoverCardAction(false);
      const refreshed = await Promise.allSettled([refresh(), useCustomer.getState().refreshCart()]);
      if (refreshed.some(item => item.status === 'rejected')) setError('Your cart was updated, but the chat could not refresh. Reopen the chat to see the latest details.');
      if (result && typeof result === 'object' && 'clamped' in result && result.clamped === true) appendIssueCard({ cardId: randomUUID(), type: 'out_of_stock', payload: { title: 'Availability changed', description: 'The quantity was adjusted to what is available. Review your cart before ordering.' } });
    } catch (failure) {
      if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500 && failure.status !== 408 && failure.status !== 429 && failure.code !== 'RUN_IN_PROGRESS') {
        try { await AsyncStorage.removeItem(pendingCardActionKey(thread.id)); pendingCardAction.current = null; setRecoverCardAction(false); }
        catch { setRecoverCardAction(true); setError('This cart update needs a safe retry before another change.'); return; }
        if (failure.code === 'INVENTORY_INSUFFICIENT') appendIssueCard({ cardId: randomUUID(), type: 'out_of_stock', payload: { title: 'Item unavailable', description: 'This item is no longer available. Browse other products or review your cart.' } });
        else if (failure.code === 'ADDRESS_NOT_SERVICEABLE') appendIssueCard({ cardId: randomUUID(), type: 'delivery_unavailable', payload: { title: 'Delivery is unavailable here', description: 'Choose another address or try again later.' } });
        else setError(failure.code === 'CONCURRENT_MODIFICATION' ? 'Your delivery address changed. Search for the item again.' : 'Could not add this item. Check its availability and try again.');
      } else { setRecoverCardAction(true); setError('This cart update may already be applied. Retry safely to check.'); }
    }
    finally { cardActionInFlight.current = false; setBusy(false); setStatus(''); }
  };
  const appendIssueCard = (card: AgentCard) => {
    setThread(current => {
      if (!current?.messages.length) return current;
      const messages = current.messages.slice();
      const last = messages[messages.length - 1];
      if (!last || last.role !== 'assistant') return { ...current, messages: [...messages, { id: randomUUID(), role: 'assistant', text: '', cards: [card], createdAt: new Date().toISOString() }] };
      messages[messages.length - 1] = { ...last, cards: [...last.cards, card] };
      return { ...current, messages };
    });
  };
  const renderMessage = ({ item }: { item: AgentMessage }) => !item.text && !item.cards.length ? null : <View style={[styles.message, item.role === 'user' ? styles.userMessage : styles.assistantMessage]}>
    {!!item.text && <Text selectable style={styles.body}>{item.text}</Text>}
    {distinctAddressCards(item.cards).map(card => <AssistantCard key={card.cardId} card={card} locale={locale} busy={busy || streaming || thread?.status === 'archived'} onDecision={(id, decision) => void run('resume', { id, decision })} onAction={cardAction} onReview={setDecisionCard} />)}
    {item.role === 'assistant' && !busy && !!(item.text || item.cards.length) && <View style={styles.feedback}>
      <Pressable accessibilityRole="button" accessibilityLabel={t.feedbackUp} accessibilityState={{ selected: feedback[item.id] === 'up' }} onPress={() => void rate(item.id, 'up')} hitSlop={8}><Ionicons name={feedback[item.id] === 'up' ? 'thumbs-up' : 'thumbs-up-outline'} size={18} color="#526c39" /></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={t.feedbackDown} accessibilityState={{ selected: feedback[item.id] === 'down' }} onPress={() => void rate(item.id, 'down')} hitSlop={8}><Ionicons name={feedback[item.id] === 'down' ? 'thumbs-down' : 'thumbs-down-outline'} size={18} color="#526c39" /></Pressable>
    </View>}
  </View>;
  return <View style={[styles.root, { paddingTop: insets.top }]}>
    <View style={styles.header}><Pressable accessibilityRole="button" accessibilityLabel={t.close} hitSlop={12} onPress={() => router.back()}><Ionicons name="arrow-back" size={24} color="#263520" /></Pressable><Text style={styles.headerTitle}>{t.title}</Text>{consent === 'accepted' && <><Pressable accessibilityRole="button" accessibilityLabel="Chat history" hitSlop={10} disabled={busy || streaming} onPress={() => { setHistoryOpen(true); void loadChatHistory(); }} style={styles.headerButton}><Ionicons name="time-outline" size={23} color="#365a25" /></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Ask support" hitSlop={10} onPress={() => setSupportOpen(true)} style={styles.headerButton}><Ionicons name="headset-outline" size={23} color="#365a25" /></Pressable><Pressable accessibilityRole="button" disabled={busy || streaming} onPress={newChat} style={styles.headerButton}><Text style={styles.link}>{t.newChat}</Text></Pressable></>}</View>
    {consent === 'required' ? <View style={styles.consent}><Ionicons name="chatbubble-ellipses-outline" size={36} color="#405f29" /><Text style={styles.heading}>{t.consentTitle}</Text><Text style={styles.body}>{t.consentBody}</Text>{!!error && <Text style={styles.error}>{error}</Text>}<Pressable accessibilityRole="button" disabled={busy} onPress={() => void accept()} style={styles.primary}><Text style={styles.primaryText}>{t.agree}</Text></Pressable><Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.secondary}><Text style={styles.link}>{t.decline}</Text></Pressable></View>
    : consent === 'loading' ? <View style={styles.consent}><Text style={styles.body}>{error || t.loading}</Text>{!!error && <><Pressable accessibilityRole="button" onPress={() => { setError(''); setLoadAttempt(value => value + 1); }} style={styles.primary}><Text style={styles.primaryText}>{t.retry}</Text></Pressable><Pressable accessibilityRole="button" onPress={() => router.back()} style={styles.secondary}><Text style={styles.link}>{t.close}</Text></Pressable></>}</View>
    : <KeyboardAvoidingView style={styles.grow} behavior="padding" automaticOffset>
      <FlatList ref={list} data={thread?.messages ?? []} keyExtractor={item => item.id} renderItem={renderMessage} contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled" onScroll={event => { const {contentOffset,contentSize,layoutMeasurement} = event.nativeEvent; shouldScrollToEnd.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 100; }} scrollEventThrottle={32} onContentSizeChange={() => { if (shouldScrollToEnd.current) list.current?.scrollToEnd({ animated: false }); }} ListFooterComponent={status ? <Text style={styles.activity} accessibilityLiveRegion="polite">{status}</Text> : undefined} ListHeaderComponent={thread?.nextCursor ? <Pressable accessibilityRole="button" disabled={loadingHistory} onPress={() => void loadEarlier()} style={styles.chip}><Text style={styles.link}>{loadingHistory ? t.loadingEarlier : t.earlier}</Text></Pressable> : undefined} ListEmptyComponent={<View style={styles.empty}><Text style={styles.heading}>{t.greeting}</Text><View style={styles.suggestions}>{config.suggestedPrompts.map(prompt => <Pressable key={prompt} style={styles.chip} onPress={() => send(prompt)} accessibilityRole="button"><Text style={styles.link}>{prompt}</Text></Pressable>)}</View></View>} />
      {showBrowseNotice && <View style={styles.browseNotice}><Text style={styles.browseText}>{pushStatus === 'enabled' && alertsEnabled ? t.browseNotice : t.browseNoticeNoPush}</Text><Pressable accessibilityRole="button" accessibilityLabel={t.dismissNotice} hitSlop={8} onPress={() => setShowBrowseNotice(false)}><Ionicons name="close" size={18} color="#526c39" /></Pressable></View>}
      {nudgeVisible && <View style={styles.browseNotice}><Pressable accessibilityRole="button" disabled={busy || streaming} style={{ flex: 1 }} onPress={() => { setInput(`Show me ${nudgeName} again`); setNudgeVisible(false); }}><Text style={styles.browseText}>Suggested: Show me {nudgeName} again</Text><Text style={styles.link}>Use suggestion</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Dismiss suggestion" hitSlop={8} onPress={() => setNudgeVisible(false)}><Ionicons name="close" size={18} color="#526c39" /></Pressable></View>}
      {recoverCardAction && <View style={styles.browseNotice}><Text style={styles.browseText}>A cart update needs to be checked before you continue.</Text><Pressable accessibilityRole="button" disabled={busy || streaming} onPress={() => { const action = pendingCardAction.current; if (action) void cardAction(action.cardId, action.action, JSON.parse(action.payload) as Record<string, unknown>); }}><Text style={styles.link}>Retry safely</Text></Pressable></View>}
      {!!error && <View style={styles.errorRow}><Text style={styles.error}>{error}</Text>{canRetry && <Pressable onPress={() => send(pending.current?.text)}><Text style={styles.link}>{t.retry}</Text></Pressable>}</View>}
      {thread?.status === 'archived' ? <Text style={styles.status}>{t.archived}</Text> : <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}><TextInput style={styles.input} multiline value={input} onChangeText={setInput} placeholder={t.input} accessibilityLabel={t.input} maxLength={config.maxMessageChars} editable={!streaming && !busy} /><Pressable style={styles.send} accessibilityRole="button" accessibilityLabel={streaming ? t.stop : t.send} disabled={!streaming && !input.trim()} onPress={() => streaming ? void stop() : send()}><Ionicons name={streaming ? 'stop' : 'send'} size={20} color="#fff" /></Pressable></View>}
    </KeyboardAvoidingView>}
    <AddressPanel visible={addressOpen} seed={addressSeed} onClose={() => setAddressOpen(false)} onAddressSaved={id => {if (continuationRef.current) saveContinuation({...continuationRef.current,addressId:id,waitingForLocation:true,selected:false});}} onLocationConfirmed={id => {if (continuationRef.current) saveContinuation({...continuationRef.current,addressId:id,waitingForLocation:false,selected:true});}} />
    <AssistantHelpSheet visible={supportOpen} onClose={() => setSupportOpen(false)} />
    <AssistantDecisionSheet key={decisionCard?.cardId ?? 'closed'} card={decisionCard} onClose={() => setDecisionCard(null)}
      onAddresses={() => { const card = decisionCard; setDecisionCard(null); if (card) setTimeout(() => void cardAction(card.cardId, 'open_screen', { screen: 'addresses' }), 150); }}
      onCart={() => { const card = decisionCard; setDecisionCard(null); if (card) setTimeout(() => void cardAction(card.cardId, 'open_screen', { screen: 'cart' }), 150); }}
      onProducts={() => { const card = decisionCard; setDecisionCard(null); if (card) setTimeout(() => void cardAction(card.cardId, 'open_screen', { screen: 'products' }), 150); }}
      onSupport={() => { setDecisionCard(null); setTimeout(() => setSupportOpen(true), 150); }} />
    <BottomSheet visible={historyOpen} onClose={() => setHistoryOpen(false)} title="Chat history">
      <View style={{ gap: 8 }}>
        {chatHistory.map(chat => <Pressable key={chat.id} accessibilityRole="button" style={styles.historyItem} onPress={() => { setHistoryOpen(false); setTimeout(() => router.setParams({ threadId: chat.id, nudgeName: undefined }), 150); }}>
          <Text style={styles.historyTitle}>{chat.title || 'Conversation'}</Text>
          <Text style={styles.status}>{new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(chat.lastMessageAt))}{chat.status === 'active' ? ' · Current' : ''}</Text>
        </Pressable>)}
        {!!historyError && <Text style={styles.error}>{historyError}</Text>}
        {!historyBusy && !historyError && !chatHistory.length && <Text style={styles.body}>No chats yet.</Text>}
        {(historyCursor || historyError) && <Pressable accessibilityRole="button" disabled={historyBusy} style={styles.chip} onPress={() => void loadChatHistory(historyError ? undefined : historyCursor ?? undefined)}><Text style={styles.link}>{historyError ? 'Try again' : 'Load more chats'}</Text></Pressable>}
        {historyBusy && <Text style={styles.status}>Loading chats…</Text>}
      </View>
    </BottomSheet>
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#f8f9f6' }, grow: { flex: 1 }, header: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, backgroundColor: '#fff', borderBottomWidth: 1, borderColor: '#e1e3dc' }, headerTitle: { flex: 1, fontSize: 19, fontWeight: '700', color: '#263520' }, headerButton: { minHeight: 44, justifyContent: 'center' }, historyItem: { padding: 12, borderRadius: 12, borderWidth: 1, borderColor: '#e1e3dc', gap: 4 }, historyTitle: { fontSize: 15, fontWeight: '600', color: '#263520' },
  consent: { flex: 1, justifyContent: 'center', padding: 28, gap: 18 }, heading: { color: '#263520', fontSize: 22, fontWeight: '700' }, body: { fontSize: 15, lineHeight: 22, color: '#293027' }, link: { color: '#365a25', fontWeight: '700' }, primary: { backgroundColor: '#405f29', minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 12 }, primaryText: { color: '#fff', fontWeight: '700' }, secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  list: { padding: 16, gap: 12, flexGrow: 1 }, empty: { paddingVertical: 28, gap: 16 }, suggestions: { gap: 8, alignItems: 'flex-start' }, chip: { padding: 12, minHeight: 44, borderRadius: 18, borderWidth: 1, borderColor: '#d8dfd0', backgroundColor: '#fff' }, message: { maxWidth: '92%', borderRadius: 14, padding: 12, gap: 8 }, userMessage: { alignSelf: 'flex-end', backgroundColor: '#e3eddb' }, assistantMessage: { alignSelf: 'flex-start', backgroundColor: '#fff', borderWidth: 1, borderColor: '#e6e9e3' },
  status: { paddingHorizontal: 18, paddingBottom: 5, color: '#687263' }, browseNotice: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 10, backgroundColor: '#edf3e7' }, browseText: { flex: 1, color: '#405f29', fontSize: 13, lineHeight: 18 }, errorRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 6 }, error: { color: '#a2382e', flexShrink: 1 }, composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, backgroundColor: '#fff', paddingHorizontal: 12, paddingTop: 10, borderTopWidth: 1, borderColor: '#e1e3dc' }, input: { flex: 1, backgroundColor: '#f4f5f2', borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, minHeight: 46, maxHeight: 120, color: '#252820', fontSize: 15 }, send: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center', backgroundColor: '#405f29' },
  feedback: { flexDirection: 'row', gap: 18, alignItems: 'center', paddingTop: 6 }, activity: {alignSelf:'flex-start', color:'#687263', fontSize:13, paddingHorizontal:4, paddingVertical:4},
});
