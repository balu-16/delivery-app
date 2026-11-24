import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { PageHeader } from '@/components/connected/PageHeader';
import { Card, shared } from '@/components/connected/Shared';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { colors } from '@/constants/theme';
import { customerDetailsApi, type AppContentItem, type SupportTicket } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { useRefresh } from '@/hooks/useRefresh';
import { sendSupportMessage, supportSendError } from '@/src/support/send-message';
import { UUID_RE } from '@/src/utils/order-groups';

const dateFn = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(d);
};

export default function SupportListPage() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ orderId?: string }>();
  const profile = useCustomer(s => s.profile);
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [text, setText] = useState(() => {
    const oid = typeof params.orderId === 'string' && UUID_RE.test(params.orderId) ? params.orderId : null;
    return oid ? `I need help with order ${oid}. ` : '';
  });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [content, setContent] = useState<AppContentItem[] | null>(null);
  const requestId = useRef(0);
  const sending = useRef(false);

  const contentLocale = profile?.locale === 'hi' || profile?.locale === 'te' ? profile.locale : 'en';
  const fetchContent = useCallback(async () => {
    try {
      const token = await accessToken();
      setContent(await customerDetailsApi.appContent(token, contentLocale));
    } catch { /* keep bundled help copy */ }
  }, [contentLocale]);

  useEffect(() => { void fetchContent(); }, [fetchContent]); // eslint-disable-line
  const helpItem = content?.find(item => item.slot === 'CUSTOMER_HELP');

  const fetch = useCallback(async () => {
    const id = ++requestId.current;
    setState(s => (s === 'success' ? s : 'loading'));
    try {
      const result = await customerDetailsApi.tickets(await accessToken());
      if (requestId.current === id) { setTickets(result.items); setState('success'); }
    } catch {
      if (requestId.current === id) { setState(s => (s === 'success' ? s : 'error')); setError('Couldn’t load support requests.'); }
    }
  }, []);

  useFocusEffect(useCallback(() => { void fetch(); }, [fetch]));
  const { refreshing, onRefresh } = useRefresh(() => { void fetchContent(); return fetch(); });

  const send = async () => {
    const body = text.trim();
    if (!body || body.length > 2000 || working || sending.current) return;
    if (!profile?.userId) { setError('Sign in again to contact support.'); return; }
    sending.current = true; setWorking(true); setError(''); setNotice('');
    try {
      await sendSupportMessage(profile.userId, await accessToken(), body, null);
      setText(''); setNotice('Your support request was submitted.');
      void fetch();
    } catch (e) { setError(supportSendError(e)); } finally { sending.current = false; setWorking(false); }
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={[shared.scroll, { paddingTop: insets.top + 12, flexGrow: 1 }]} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={colors.green} />}>
        <PageHeader title="Help and support" sub="Your requests" onBack={() => router.canGoBack() ? router.back() : router.replace('/profile')} />
        {helpItem?.state === 'VISIBLE' ? <Card>{helpItem.title ? <AppText style={shared.label}>{helpItem.title}</AppText> : null}{helpItem.body ? <AppText style={shared.body}>{helpItem.body}</AppText> : null}</Card>
        : helpItem?.state === 'DISABLED' || helpItem?.state === 'INACTIVE' ? null
        : <Card><AppText style={shared.label}>Need help?</AppText><AppText style={shared.muted}>Send a message below and the support team will reply here.</AppText></Card>}
        {!!notice && <AppText accessibilityLiveRegion="polite" style={shared.body}>{notice}</AppText>}
        {!!error && <AppText style={{ color: colors.danger }}>{error}</AppText>}
        {state === 'idle' || state === 'loading' ? <CardListSkeleton count={2} label="Loading support requests" /> : state === 'error' ? <Button label="Try again" variant="soft" size="sm" onPress={() => void fetch()} /> : tickets.length ? tickets.map(t => (
          <Pressable key={t.id} onPress={() => router.push({ pathname: '/support/[ticketId]', params: { ticketId: t.id } })} accessibilityRole="button">
            <Card><AppText style={shared.label}>{t.category}</AppText><AppText style={shared.muted}>{t.status.replaceAll('_', ' ').toLowerCase()} · {dateFn(t.created_at)}</AppText></Card>
          </Pressable>
        )) : <AppText style={shared.muted}>No support requests yet.</AppText>}
        <Card>
          <AppText style={shared.label}>Start a request</AppText>
          <TextInput style={[shared.input, { minHeight: 90, textAlignVertical: 'top', paddingTop: 12 }]} multiline maxLength={2000} placeholder="How can we help?" value={text} onChangeText={setText} accessibilityLabel="Support message" />
          <Button label="Send request" fullWidth onPress={() => void send()} loading={working} disabled={!text.trim()} />
        </Card>
      </ScrollView>
    </Screen>
  );
}
