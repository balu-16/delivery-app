import { router, useLocalSearchParams } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { PageHeader } from '@/components/connected/PageHeader';
import { Card, shared } from '@/components/connected/Shared';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { colors } from '@/constants/theme';
import { customerDetailsApi, type SupportTicket, type SupportMessage, type SupportProgress } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { useRefresh } from '@/hooks/useRefresh';
import { sendSupportMessage, supportSendError } from '@/src/support/send-message';
import { UUID_RE } from '@/src/utils/order-groups';

const dateFn = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(d);
};

export default function SupportThreadPage() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ ticketId?: string }>();
  const id = typeof params.ticketId === 'string' && UUID_RE.test(params.ticketId) ? params.ticketId : null;
  const profile = useCustomer(s => s.profile);
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [progress, setProgress] = useState<SupportProgress[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [text, setText] = useState('');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const reqId = useRef(0);
  const sending = useRef(false);

  const fetch = async () => {
    if (!id) { setNotFound(true); return; }
    const rid = ++reqId.current;
    setLoading(true); setLoadError(false);
    try {
      const result = await customerDetailsApi.ticket(await accessToken(), id);
      if (reqId.current !== rid) return;
      setTicket(result.ticket); setMessages(result.messages); setProgress(result.progress ?? []);
    } catch {
      if (reqId.current !== rid) return;
      setLoadError(true);
      setError('Couldn’t load this request.');
    } finally { if (reqId.current === rid) setLoading(false); }
  };

  useEffect(() => { void fetch(); }, [id]); // eslint-disable-line
  const { refreshing, onRefresh } = useRefresh(() => (id ? fetch() : Promise.resolve()));

  const send = async () => {
    const body = text.trim();
    if (!body || body.length > 2000 || working || sending.current || loading || loadError) return;
    if (!id || !profile?.userId) { setError('Sign in again to contact support.'); return; }
    sending.current = true; setWorking(true); setError(''); setNotice('');
    try {
      await sendSupportMessage(profile.userId, await accessToken(), body, id);
      setText(''); setNotice('Your reply was sent.');
      await fetch();
    } catch (e) { setError(supportSendError(e)); } finally { sending.current = false; setWorking(false); }
  };

  if (!id || notFound) {
    return (
      <Screen><ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12 }]} showsVerticalScrollIndicator={false}>
        <PageHeader title="Support" onBack={() => router.replace('/support')} />
        <Card><AppText style={shared.body}>This request is unavailable.</AppText><Button label="Back to Help" variant="soft" size="sm" onPress={() => router.replace('/support')} /></Card>
      </ScrollView></Screen>
    );
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12, flexGrow: 1 }]} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.green} />}>
        <PageHeader title={ticket ? `Request · ${ticket.category}` : 'Support'} sub={ticket ? ticket.status.replaceAll('_', ' ').toLowerCase() : 'Conversation'} onBack={() => router.canGoBack() ? router.back() : router.replace('/support')} />
        {!!notice && <AppText accessibilityLiveRegion="polite" style={shared.body}>{notice}</AppText>}
        {!!error && <AppText style={{ color: colors.danger }}>{error}</AppText>}
        {loading ? <CardListSkeleton count={2} label="Loading support conversation" /> : loadError ? <Button label="Try again" size="sm" variant="soft" onPress={() => void fetch()} /> : (
          <>
            {ticket && (
              <Card>
                <AppText style={shared.label}>Request progress</AppText>
                <AppText style={shared.body}>Submitted · {dateFn(ticket.created_at)}</AppText>
                {progress.map((e, i) => <AppText key={`${e.type}-${e.created_at}-${i}`} style={shared.body}>{e.type === 'ACKNOWLEDGED' ? 'Acknowledged by our team' : e.type === 'OPEN' ? 'Reopened' : e.type === 'IN_PROGRESS' ? 'In progress' : e.type === 'RESOLVED' ? 'Resolved' : 'Closed'} · {dateFn(e.created_at)}</AppText>)}
                {!progress.length && ticket.status !== 'OPEN' && <AppText style={shared.muted}>Current status: {ticket.status.replaceAll('_', ' ').toLowerCase()}</AppText>}
              </Card>
            )}
            {messages.map(m => <Card key={m.id}><AppText style={shared.body}>{m.body}</AppText><AppText style={shared.muted}>{dateFn(m.created_at)}</AppText></Card>)}
          </>
        )}
        <Card>
          <TextInput style={[shared.input, { minHeight: 90, textAlignVertical: 'top', paddingTop: 12 }]} multiline maxLength={2000} placeholder="Write a reply" value={text} onChangeText={setText} accessibilityLabel="Support message" />
          <Button label="Send reply" fullWidth onPress={() => void send()} loading={working} disabled={!text.trim() || loading || loadError} />
        </Card>
      </ScrollView>
    </Screen>
  );
}
