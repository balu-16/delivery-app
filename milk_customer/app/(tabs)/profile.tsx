import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect, useLocalSearchParams, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, RefreshControl, ScrollView, Share, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { AddressPanel } from '@/components/connected/AddressPanel';
import { PushSettings } from '@/components/connected/PushNotifications';
import { CardListSkeleton } from '@/components/animations/Skeleton';
import { Card, ErrorBanner, formatPaise, Heading, shared } from '@/components/connected/Shared';
import { colors, fonts } from '@/constants/theme';
import { customerApi, customerDetailsApi, type ReferralView, type SupportMessage, type SupportProgress, type SupportTicket } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';
import { useRefresh } from '@/hooks/useRefresh';
import { agentClient } from '@/src/agent/client';
import { agentStrings } from '@/src/agent/strings';
import { assistantNotificationTarget } from '@/src/agent/notification-target';
import { sendSupportMessage, supportSendError } from '@/src/support/send-message';

type Panel = 'wallet' | 'notifications' | 'support' | 'edit' | 'referral' | 'ai_privacy' | null;
const date = (value: string) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat('en-IN', {day:'numeric', month:'short', year:'numeric', timeZone:'Asia/Kolkata'}).format(d); };
function Row({icon, label, detail, onPress}: {icon: React.ComponentProps<typeof Ionicons>['name']; label:string; detail:string; onPress:()=>void}) { return <Pressable onPress={onPress} accessibilityRole="button"><Card><View style={shared.row}><Ionicons name={icon} size={22} color={colors.green} /><View style={{flex:1}}><AppText style={shared.label}>{label}</AppText><AppText style={shared.muted}>{detail}</AppText></View><Ionicons name="chevron-forward" size={18} color={colors.muted} /></View></Card></Pressable>; }
export default function Profile() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{open?:string}>();
  const {profile, wallet, ledger, notifications, loadAccount, readNotifications, logout, accountLoad} = useCustomer();
  const assistantText = agentStrings(profile?.locale);
  const [assistantPrivacyAvailable, setAssistantPrivacyAvailable] = useState(false), [assistantConsent, setAssistantConsent] = useState(false);
  const [privacyNotice, setPrivacyNotice] = useState('');
  const [panel, setPanel] = useState<Panel>(null), [addresses, setAddresses] = useState(false), [name, setName] = useState('');
  const activePanel:Panel = params.open === 'notifications' ? 'notifications' : params.open === 'support' ? 'support' : panel;
  const [tickets, setTickets] = useState<SupportTicket[]>([]), [ticket, setTicket] = useState<SupportTicket | null>(null), [messages, setMessages] = useState<SupportMessage[]>([]), [text, setText] = useState('');
  const [progress, setProgress] = useState<SupportProgress[]>([]), [supportNotice, setSupportNotice] = useState('');
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const [referral, setReferral] = useState<ReferralView | null>(null), [loadingReferral,setLoadingReferral] = useState(false);
  const [ticketsState, setTicketsState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [ticketLoading, setTicketLoading] = useState(false), [ticketError, setTicketError] = useState(false);
  const ticketRequest = useRef(0), referralRequest = useRef(0), ticketsRequest = useRef(0);
  const sendingSupport = useRef(false);
  useFocusEffect(useCallback(() => {
    let active = true;
    void loadAccount();
    void agentClient.consentStatus().then(state => { if (active) { setAssistantConsent(state.accepted); setAssistantPrivacyAvailable(true); } }).catch(() => { if (active) setAssistantPrivacyAvailable(false); });
    return () => { active = false; };
  }, [loadAccount]));
  const { refreshing: profileRefreshing, onRefresh: onProfileRefresh } = useRefresh(() => loadAccount());
  const show = (next: Panel) => { setError(''); setPanel(next); if (next === 'edit') setName(profile?.name ?? ''); if (next === 'support') { ticketRequest.current++; setTicket(null); setTicketLoading(false); setTicketError(false); setText(''); void fetchTickets(); } if (next === 'referral') {const requestId=++referralRequest.current;setReferral(null);setLoadingReferral(true);void accessToken().then(token => customerDetailsApi.referral(token)).then(value => {if (requestId === referralRequest.current) setReferral(value);}).catch(() => {if (requestId === referralRequest.current) setError('Couldn’t load referral rewards.');}).finally(() => {if (requestId === referralRequest.current) setLoadingReferral(false);});} };
  const fetchTickets = useCallback(async () => { const requestId=++ticketsRequest.current; setTicketsState(state => state === 'success' ? state : 'loading'); try { const result = await customerDetailsApi.tickets(await accessToken()); if (requestId === ticketsRequest.current) {setTickets(result.items);setTicketsState('success');} } catch { if (requestId === ticketsRequest.current) {setTicketsState(state => state === 'success' ? state : 'error');setError('Couldn’t load support requests.');} } }, []);
  useEffect(() => { if (params.open === 'support') void fetchTickets(); }, [params.open, fetchTickets]);
  const refreshTicket = async (id: string, requestId: number) => {
    const result = await customerDetailsApi.ticket(await accessToken(), id);
    if (requestId === ticketRequest.current) {setTicket(result.ticket);setMessages(result.messages);setProgress(result.progress ?? []);setTicketError(false);}
  };
  const openTicket = async (value: SupportTicket) => { const requestId=++ticketRequest.current;setTicket(value);setMessages([]);setProgress([]);setTicketLoading(true);setTicketError(false);setError('');setSupportNotice('');try { await refreshTicket(value.id, requestId);setText(''); } catch { if (requestId === ticketRequest.current) {setTicketError(true);setError('Couldn’t load this request.');} } finally { if (requestId === ticketRequest.current) setTicketLoading(false); } };
  const send = async () => {
    const body = text.trim(); if (!body || body.length > 2000 || working || sendingSupport.current || ticketLoading || ticketError) return;
    const ticketId = ticket?.id ?? null;
    if (!profile?.userId) {setError('Sign in again to contact support.');return;}
    sendingSupport.current = true; setWorking(true); setError('');setSupportNotice('');
    try {
      await sendSupportMessage(profile.userId, await accessToken(), body, ticketId);
      setText(''); setSupportNotice(ticketId ? 'Your reply was sent.' : 'Your support request was submitted.');
      if (ticketId) {
        const requestId = ticketRequest.current;
        void refreshTicket(ticketId, requestId).catch(() => {if (requestId === ticketRequest.current) setError('Your reply was sent. Refresh this request to see it.');});
      } else void fetchTickets();
    } catch (failure) { setError(supportSendError(failure)); }
    finally { sendingSupport.current = false; setWorking(false); }
  };
  const saveName = async () => { if (!name.trim() || working) return; setWorking(true); setError(''); try { const token = await accessToken(); await customerDetailsApi.updateProfile(token, name.trim()); const updated = await customerApi.profile(token); useCustomer.setState({profile:updated}); setPanel(null); } catch { setError('Couldn’t update your profile.'); } finally { setWorking(false); } };
  const manageAssistantPrivacy = () => {
    if (working) return;
    const title = assistantText.withdraw;
    const message = assistantText.withdrawConfirm;
    Alert.alert(title, message, [
      { text: assistantText.keep, style: 'cancel' },
      { text: title, style: 'destructive', onPress: () => {
        setWorking(true); setError(''); setPrivacyNotice('');
        void agentClient.revokeConsent()
          .then(() => { setAssistantConsent(false); setPrivacyNotice(assistantText.consentWithdrawn); })
          .catch(() => setError(assistantText.privacyError))
          .finally(() => setWorking(false));
      } },
    ]);
  };
  const { refreshing: supportRefreshing, onRefresh: onSupportRefresh } = useRefresh(async () => { const current = ticket; if (current) await refreshTicket(current.id, ticketRequest.current).catch(() => { throw new Error('Couldn’t refresh progress.'); }); else await fetchTickets(); });
  return <Screen><ScrollView contentContainerStyle={[shared.scroll,{paddingTop:insets.top+12, flexGrow: 1}]} showsVerticalScrollIndicator={false}
    refreshControl={<RefreshControl refreshing={profileRefreshing} onRefresh={() => void onProfileRefresh()} tintColor={colors.green} />}>
    <Heading title="Your account" sub="Everything you need, in one place" /><ErrorBanner />
    <Card><View style={shared.row}><View style={styles.avatar}><Ionicons name="person" size={28} color={colors.green} /></View><View style={{flex:1}}><AppText style={styles.name}>{profile?.name || 'Customer'}</AppText><AppText style={shared.muted}>{profile?.email}</AppText></View><Button label="Edit" size="sm" variant="soft" onPress={() => show('edit')} /></View></Card>
    <Row icon="location-outline" label="Addresses" detail="Manage your delivery address" onPress={() => setAddresses(true)} />
    <Row icon="wallet-outline" label="Wallet" detail={wallet ? `${formatPaise(wallet.cashPaise)} cash · ${formatPaise(wallet.promoPaise)} promotional` : 'View balance and activity'} onPress={() => show('wallet')} />
    <Row icon="gift-outline" label="Refer a friend" detail="Share the freshness and earn a reward" onPress={() => show('referral')} />
    <Row icon="notifications-outline" label="Notifications" detail={accountLoad.notifications === 'success' ? `${notifications.filter(n => !n.readAt).length} unread` : accountLoad.notifications === 'error' ? 'Notifications unavailable' : 'Loading notifications…'} onPress={() => show('notifications')} />
    <Row icon="chatbubbles-outline" label="Help and support" detail="View and send support requests" onPress={() => show('support')} />
    {assistantPrivacyAvailable && <Row icon="shield-checkmark-outline" label={assistantText.privacy} detail={assistantText.privacyDetail} onPress={() => show('ai_privacy')} />}
    <Button label="Sign out" variant="outline" fullWidth onPress={() => void logout()} />
  </ScrollView><AddressPanel visible={addresses} onClose={() => setAddresses(false)} /><BottomSheet visible={!!activePanel} onClose={() => {ticketRequest.current++;referralRequest.current++;setTicketLoading(false);setLoadingReferral(false);setPanel(null);router.setParams({open:undefined});}} title={activePanel === 'wallet' ? 'Wallet' : activePanel === 'notifications' ? 'Notifications' : activePanel === 'support' ? 'Help and support' : activePanel === 'referral' ? 'Refer a friend' : activePanel === 'ai_privacy' ? assistantText.privacy : 'Edit profile'} keyboardAware={activePanel === 'edit' || activePanel === 'support'} refreshControl={activePanel === 'support' ? <RefreshControl refreshing={supportRefreshing} onRefresh={() => void onSupportRefresh()} tintColor={colors.green} /> : undefined}>
    <View style={{gap:12}}><ErrorBanner />{!!error && <AppText style={{color:colors.danger}}>{error}</AppText>}
      {activePanel === 'edit' && <><TextInput style={shared.input} value={name} onChangeText={setName} placeholder="Your name" maxLength={100} accessibilityLabel="Your name" /><Button label="Save" fullWidth onPress={() => void saveName()} loading={working} disabled={!name.trim()} /></>}
      {activePanel === 'ai_privacy' && <><AppText style={shared.body}>{assistantText.privacyBody}</AppText><AppText style={shared.muted}>{assistantConsent ? assistantText.consentOn : assistantText.consentOff}</AppText>{!!privacyNotice && <AppText accessibilityLiveRegion="polite" style={shared.body}>{privacyNotice}</AppText>}{assistantConsent && <Button label={assistantText.withdraw} fullWidth variant="outline" disabled={working} onPress={manageAssistantPrivacy} />}</>}
      {activePanel === 'wallet' && <>
        {accountLoad.wallet === 'idle' || accountLoad.wallet === 'loading' ? <CardListSkeleton label="Loading wallet balance" count={1} /> : accountLoad.wallet === 'error' ? <><AppText style={shared.muted}>Couldn’t load your wallet.</AppText><Button label="Try again" size="sm" variant="soft" onPress={() => void loadAccount()} /></> : <Card><AppText style={shared.label}>Cash balance {wallet ? formatPaise(wallet.cashPaise) : '—'}</AppText><AppText style={shared.label}>Promotional balance {wallet ? formatPaise(wallet.promoPaise) : '—'}</AppText></Card>}
        <AppText style={shared.label}>Recent activity</AppText>{accountLoad.ledger === 'idle' || accountLoad.ledger === 'loading' ? <CardListSkeleton label="Loading wallet activity" count={2} /> : accountLoad.ledger === 'error' ? <><AppText style={shared.muted}>Couldn’t load wallet activity.</AppText><Button label="Try again" size="sm" variant="soft" onPress={() => void loadAccount()} /></> : ledger.length ? ledger.map(item => <View key={item.id} style={styles.line}><View style={{flex:1}}><AppText style={shared.body}>{item.reason.replaceAll('_',' ').toLowerCase()}</AppText><AppText style={shared.muted}>{date(item.createdAt)} · {item.bucket}</AppText></View><AppText style={shared.label}>{formatPaise(item.deltaPaise)}</AppText></View>) : <AppText style={shared.muted}>No activity to show.</AppText>}
      </>}
      {activePanel === 'referral' && <>{loadingReferral ? <CardListSkeleton label="Loading referral details" count={1} /> : !referral ? <Button label="Try again" size="sm" variant="soft" onPress={() => show('referral')} /> : referral && <>{referral.freeDeliveryAvailable && <Card><AppText style={shared.label}>Free delivery is ready</AppText><AppText style={shared.body}>It will be applied automatically to your next order.</AppText></Card>}{!referral.enabled || !referral.code ? <AppText style={shared.body}>Referral rewards are temporarily unavailable.</AppText> : <><Card><AppText style={shared.label}>Your code</AppText><AppText style={styles.name} selectable>{referral.code}</AppText><AppText style={shared.muted}>{referral.successfulReferrals} verified {referral.successfulReferrals === 1 ? 'friend' : 'friends'} joined</AppText></Card><AppText style={shared.body}>When a new friend signs up with your code and verifies their email, you receive {formatPaise(referral.rewardPaise)} in promotional wallet credit. It expires one calendar month after it is granted. Your friend gets one free delivery on their next order.</AppText><Button label="Share referral code" fullWidth onPress={() => void Share.share({message:`Join DairyDirect with my referral code ${referral.code}. You'll get one free delivery on your next order after you sign up and verify your email.`})} /></>}</>}</>}
      {activePanel === 'notifications' && <>{accountLoad.notifications === 'idle' || accountLoad.notifications === 'loading' ? <CardListSkeleton label="Loading notifications" count={2} /> : accountLoad.notifications === 'error' ? <><AppText style={shared.muted}>Couldn’t load notifications.</AppText><Button label="Try again" size="sm" variant="soft" onPress={() => void loadAccount()} /></> : <>{notifications.length > 0 && <Button label="Mark all as read" size="sm" variant="soft" onPress={() => void readNotifications()} />}{notifications.length ? notifications.map(item => {
        const data = item.payload?.data && typeof item.payload.data === 'object' && !Array.isArray(item.payload.data) ? item.payload.data as Record<string, unknown> : {};
        const target = assistantNotificationTarget({ ...data, deepLink: item.payload?.deepLink });
        const content = <Card><AppText style={shared.label}>{item.title}</AppText><AppText style={shared.body}>{item.body}</AppText><AppText style={shared.muted}>{date(item.createdAt)}{item.readAt ? '' : ' · Unread'}</AppText></Card>;
        return target ? <Pressable key={item.id} accessibilityRole="button" onPress={() => {
          void accessToken().then(token => customerDetailsApi.readNotification(token, item.id)).then(() => loadAccount()).catch(() => undefined);
          router.push({ pathname: '/agent', params: target } as Href);
        }}>{content}</Pressable> : <View key={item.id}>{content}</View>;
      }) : <AppText style={shared.muted}>You have no notifications.</AppText>}</>}<PushSettings /></>}
      {activePanel === 'support' && <>{!!supportNotice && <AppText accessibilityLiveRegion="polite" style={shared.body}>{supportNotice}</AppText>}{ticket ? <><Button label="All requests" variant="ghost" size="sm" onPress={() => { ticketRequest.current++;setTicketLoading(false);setTicketError(false);setTicket(null);setMessages([]);setProgress([]);setText('');setSupportNotice('');void fetchTickets(); }} /><AppText style={shared.label}>{ticket.category} · {ticket.status.replaceAll('_',' ').toLowerCase()}</AppText>{!ticketLoading && !ticketError && <Card><AppText style={shared.label}>Request progress</AppText><AppText style={shared.body}>Submitted · {date(ticket.created_at)}</AppText>{progress.map((event,index) => <AppText key={`${event.type}-${event.created_at}-${index}`} style={shared.body}>{event.type === 'ACKNOWLEDGED' ? 'Acknowledged by our team' : event.type === 'OPEN' ? 'Reopened' : event.type === 'IN_PROGRESS' ? 'In progress' : event.type === 'RESOLVED' ? 'Resolved' : 'Closed'} · {date(event.created_at)}</AppText>)}{!progress.length && ticket.status !== 'OPEN' && <AppText style={shared.muted}>Current status: {ticket.status.replaceAll('_',' ').toLowerCase()}</AppText>}</Card>}{ticketLoading ? <CardListSkeleton label="Loading support conversation" count={2} /> : ticketError ? <Button label="Try again" size="sm" variant="soft" onPress={() => void openTicket(ticket)} /> : messages.map(message => <Card key={message.id}><AppText style={shared.body}>{message.body}</AppText><AppText style={shared.muted}>{date(message.created_at)}</AppText></Card>)}</> : <><AppText style={shared.label}>Your requests</AppText>{ticketsState === 'idle' || ticketsState === 'loading' ? <CardListSkeleton label="Loading support requests" count={2} /> : ticketsState === 'error' ? <Button label="Try again" size="sm" variant="soft" onPress={() => void fetchTickets()} /> : tickets.length ? tickets.map(item => <Pressable key={item.id} onPress={() => void openTicket(item)}><Card><AppText style={shared.label}>{item.category}</AppText><AppText style={shared.muted}>{item.status.replaceAll('_',' ').toLowerCase()} · {date(item.created_at)}</AppText></Card></Pressable>) : <AppText style={shared.muted}>No support requests yet.</AppText>}<AppText style={shared.label}>Start a request</AppText></>}
      <TextInput style={[shared.input,{minHeight:90,textAlignVertical:'top',paddingTop:12}]} multiline maxLength={2000} placeholder={ticket ? 'Write a reply' : 'How can we help?'} value={text} onChangeText={setText} accessibilityLabel="Support message" /><Button label={ticket ? 'Send reply' : 'Send request'} fullWidth onPress={() => void send()} loading={working} disabled={!text.trim() || ticketLoading || ticketError} /></>}
    </View>
  </BottomSheet></Screen>;
}
const styles = StyleSheet.create({avatar:{width:54,height:54,borderRadius:27,backgroundColor:colors.greenSoft,alignItems:'center',justifyContent:'center'},name:{fontFamily:fonts.semibold,fontSize:17,color:colors.brownDark},line:{flexDirection:'row',alignItems:'center',gap:12,paddingVertical:5}});
