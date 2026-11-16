import { Ionicons } from '@expo/vector-icons';
import * as Crypto from 'expo-crypto';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, ScrollView, Share, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText } from '@/components/ui/AppText';
import { BottomSheet } from '@/components/ui/BottomSheet';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/ui/Screen';
import { AddressPanel } from '@/components/connected/AddressPanel';
import { PushSettings } from '@/components/connected/PushNotifications';
import { Card, ErrorBanner, formatPaise, Heading, shared } from '@/components/connected/Shared';
import { colors, fonts } from '@/constants/theme';
import { customerApi, customerDetailsApi, type ReferralView, type SupportMessage, type SupportTicket } from '@/src/api/customer';
import { accessToken } from '@/src/auth/session';
import { useCustomer } from '@/src/store/customer';

type Panel = 'wallet' | 'notifications' | 'support' | 'edit' | 'referral' | null;
const date = (value: string) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat('en-IN', {day:'numeric', month:'short', year:'numeric', timeZone:'Asia/Kolkata'}).format(d); };
function Row({icon, label, detail, onPress}: {icon: React.ComponentProps<typeof Ionicons>['name']; label:string; detail:string; onPress:()=>void}) { return <Pressable onPress={onPress} accessibilityRole="button"><Card><View style={shared.row}><Ionicons name={icon} size={22} color={colors.green} /><View style={{flex:1}}><AppText style={shared.label}>{label}</AppText><AppText style={shared.muted}>{detail}</AppText></View><Ionicons name="chevron-forward" size={18} color={colors.muted} /></View></Card></Pressable>; }
export default function Profile() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{open?:string}>();
  const {profile, wallet, ledger, notifications, loadAccount, readNotifications, logout} = useCustomer();
  const [panel, setPanel] = useState<Panel>(null), [addresses, setAddresses] = useState(false), [name, setName] = useState('');
  const activePanel:Panel = params.open === 'notifications' ? 'notifications' : panel;
  const [tickets, setTickets] = useState<SupportTicket[]>([]), [ticket, setTicket] = useState<SupportTicket | null>(null), [messages, setMessages] = useState<SupportMessage[]>([]), [text, setText] = useState('');
  const [working, setWorking] = useState(false), [error, setError] = useState('');
  const [referral, setReferral] = useState<ReferralView | null>(null), [loadingReferral,setLoadingReferral] = useState(false);
  const request = useRef<{text:string; ticketId:string | null; key:string} | null>(null);
  useFocusEffect(useCallback(() => { void loadAccount(); }, [loadAccount]));
  const show = (next: Panel) => { setError(''); setPanel(next); if (next === 'edit') setName(profile?.name ?? ''); if (next === 'support') { setTicket(null); setText(''); void fetchTickets(); } if (next === 'referral') {setReferral(null);setLoadingReferral(true);void accessToken().then(token => customerDetailsApi.referral(token)).then(setReferral).catch(() => setError('Could not load referral rewards. Please try again.')).finally(() => setLoadingReferral(false));} };
  const fetchTickets = async () => { try { const result = await customerDetailsApi.tickets(await accessToken()); setTickets(result.items); } catch { setError('Could not load support requests.'); } };
  const openTicket = async (value: SupportTicket) => { setWorking(true); setError(''); try { const result = await customerDetailsApi.ticket(await accessToken(), value.id); setTicket(result.ticket); setMessages(result.messages); setText(''); } catch { setError('Could not load this request.'); } finally { setWorking(false); } };
  const send = async () => {
    const body = text.trim(); if (!body || body.length > 2000 || working) return;
    const ticketId = ticket?.id ?? null;
    if (!request.current || request.current.text !== body || request.current.ticketId !== ticketId) request.current = {text:body, ticketId, key:Crypto.randomUUID()};
    setWorking(true); setError('');
    try {
      const token = await accessToken();
      if (ticketId) { await customerDetailsApi.ticketMessage(token, ticketId, body, request.current.key); const result = await customerDetailsApi.ticket(token, ticketId); setMessages(result.messages); }
      else { await customerDetailsApi.createTicket(token, body, request.current.key); await fetchTickets(); }
      request.current = null; setText('');
    } catch { setError('Could not send your message. Retry to use the same request.'); }
    finally { setWorking(false); }
  };
  const saveName = async () => { if (!name.trim() || working) return; setWorking(true); setError(''); try { const token = await accessToken(); await customerDetailsApi.updateProfile(token, name.trim()); const updated = await customerApi.profile(token); useCustomer.setState({profile:updated}); setPanel(null); } catch { setError('Could not update your profile. Please try again.'); } finally { setWorking(false); } };
  return <Screen><ScrollView contentContainerStyle={[shared.scroll,{paddingTop:insets.top+12}]} showsVerticalScrollIndicator={false}>
    <Heading title="Your account" sub="Everything you need, in one place" /><ErrorBanner />
    <Card><View style={shared.row}><View style={styles.avatar}><Ionicons name="person" size={28} color={colors.green} /></View><View style={{flex:1}}><AppText style={styles.name}>{profile?.name || 'Customer'}</AppText><AppText style={shared.muted}>{profile?.email}</AppText></View><Button label="Edit" size="sm" variant="soft" onPress={() => show('edit')} /></View></Card>
    <Row icon="location-outline" label="Addresses" detail="Manage your delivery address" onPress={() => setAddresses(true)} />
    <Row icon="wallet-outline" label="Wallet" detail={wallet ? `${formatPaise(wallet.cashPaise)} cash · ${formatPaise(wallet.promoPaise)} promotional` : 'View balance and activity'} onPress={() => show('wallet')} />
    <Row icon="gift-outline" label="Refer a friend" detail="Share the freshness and earn a reward" onPress={() => show('referral')} />
    <Row icon="notifications-outline" label="Notifications" detail={`${notifications.filter(n => !n.readAt).length} unread`} onPress={() => show('notifications')} />
    <Row icon="chatbubbles-outline" label="Help and support" detail="View and send support requests" onPress={() => show('support')} />
    <Button label="Sign out" variant="outline" fullWidth onPress={() => void logout()} />
  </ScrollView><AddressPanel visible={addresses} onClose={() => setAddresses(false)} /><BottomSheet visible={!!activePanel} onClose={() => {setPanel(null);router.setParams({open:undefined});}} title={activePanel === 'wallet' ? 'Wallet' : activePanel === 'notifications' ? 'Notifications' : activePanel === 'support' ? 'Help and support' : activePanel === 'referral' ? 'Refer a friend' : 'Edit profile'} keyboardAware={activePanel === 'edit' || activePanel === 'support'}>
    <View style={{gap:12}}><ErrorBanner />{!!error && <AppText style={{color:colors.danger}}>{error}</AppText>}
      {activePanel === 'edit' && <><TextInput style={shared.input} value={name} onChangeText={setName} placeholder="Your name" maxLength={100} accessibilityLabel="Your name" /><Button label="Save" fullWidth onPress={() => void saveName()} loading={working} disabled={!name.trim()} /></>}
      {activePanel === 'wallet' && <><Card><AppText style={shared.label}>Cash balance {wallet ? formatPaise(wallet.cashPaise) : '—'}</AppText><AppText style={shared.label}>Promotional balance {wallet ? formatPaise(wallet.promoPaise) : '—'}</AppText></Card><AppText style={shared.label}>Recent activity</AppText>{ledger.length ? ledger.map(item => <View key={item.id} style={styles.line}><View style={{flex:1}}><AppText style={shared.body}>{item.reason.replaceAll('_',' ').toLowerCase()}</AppText><AppText style={shared.muted}>{date(item.createdAt)} · {item.bucket}</AppText></View><AppText style={shared.label}>{formatPaise(item.deltaPaise)}</AppText></View>) : <AppText style={shared.muted}>No activity to show.</AppText>}</>}
      {activePanel === 'referral' && <>{loadingReferral ? <AppText style={shared.muted}>Loading your referral details…</AppText> : referral && <>{referral.freeDeliveryAvailable && <Card><AppText style={shared.label}>Free delivery is ready</AppText><AppText style={shared.body}>It will be applied automatically to your next order.</AppText></Card>}{!referral.enabled || !referral.code ? <AppText style={shared.body}>Referral rewards are temporarily unavailable.</AppText> : <><Card><AppText style={shared.label}>Your code</AppText><AppText style={styles.name} selectable>{referral.code}</AppText><AppText style={shared.muted}>{referral.successfulReferrals} verified {referral.successfulReferrals === 1 ? 'friend' : 'friends'} joined</AppText></Card><AppText style={shared.body}>When a new friend signs up with your code and verifies their email, you receive {formatPaise(referral.rewardPaise)} in promotional wallet credit. It expires one calendar month after it is granted. Your friend gets one free delivery on their next order.</AppText><Button label="Share referral code" fullWidth onPress={() => void Share.share({message:`Join DairyDirect with my referral code ${referral.code}. You'll get one free delivery on your next order after you sign up and verify your email.`})} /></>}</>}</>}
      {activePanel === 'notifications' && <>{notifications.length > 0 && <Button label="Mark all as read" size="sm" variant="soft" onPress={() => void readNotifications()} />}{notifications.length ? notifications.map(item => <Card key={item.id}><AppText style={shared.label}>{item.title}</AppText><AppText style={shared.body}>{item.body}</AppText><AppText style={shared.muted}>{date(item.createdAt)}{item.readAt ? '' : ' · Unread'}</AppText></Card>) : <AppText style={shared.muted}>You have no notifications.</AppText>}<PushSettings /></>}
      {activePanel === 'support' && <>{ticket ? <><Button label="All requests" variant="ghost" size="sm" onPress={() => { setTicket(null); setMessages([]); setText(''); void fetchTickets(); }} /><AppText style={shared.label}>{ticket.category} · {ticket.status.replaceAll('_',' ').toLowerCase()}</AppText>{messages.map(message => <Card key={message.id}><AppText style={shared.body}>{message.body}</AppText><AppText style={shared.muted}>{date(message.created_at)}</AppText></Card>)}</> : <><AppText style={shared.label}>Your requests</AppText>{tickets.length ? tickets.map(item => <Pressable key={item.id} onPress={() => void openTicket(item)}><Card><AppText style={shared.label}>{item.category}</AppText><AppText style={shared.muted}>{item.status.replaceAll('_',' ').toLowerCase()} · {date(item.created_at)}</AppText></Card></Pressable>) : <AppText style={shared.muted}>No support requests yet.</AppText>}<AppText style={shared.label}>Start a request</AppText></>}
      <TextInput style={[shared.input,{minHeight:90,textAlignVertical:'top',paddingTop:12}]} multiline maxLength={2000} placeholder={ticket ? 'Write a reply' : 'How can we help?'} value={text} onChangeText={setText} accessibilityLabel="Support message" /><Button label={ticket ? 'Send reply' : 'Send request'} fullWidth onPress={() => void send()} loading={working} disabled={!text.trim()} /></>}
    </View>
  </BottomSheet></Screen>;
}
const styles = StyleSheet.create({avatar:{width:54,height:54,borderRadius:27,backgroundColor:colors.greenSoft,alignItems:'center',justifyContent:'center'},name:{fontFamily:fonts.semibold,fontSize:17,color:colors.brownDark},line:{flexDirection:'row',alignItems:'center',gap:12,paddingVertical:5}});
