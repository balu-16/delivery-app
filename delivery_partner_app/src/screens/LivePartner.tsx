import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { performAction } from '../actions';
import { ApiError, riderApi, type Application, type Earning, type HistoryTask, type Notice, type Offer, type RiderStatus, type Task } from '../api';
import { type PartnerIdentity } from '../auth/session';
import { Brand } from '../components/Brand';
import { Button, Card, IconBox, IconButton, PageTitle, Text, type IconName } from '../components/Ui';
import { enablePush, startPush, unregisterPush, usePush } from '../push';
import { startRiderRealtime } from '../realtime';
import { useDemo } from '../store';
import { colors, fonts } from '../theme';
import { endShift, reconcileTracking, startShift, stopTracking } from '../tracking';
import { formatMoney, shortTime } from './liveHelpers';
import { SupportScreen } from './SupportScreen';
import { TaskDetail } from './TaskDetail';

type Tab = 'home' | 'tasks' | 'route' | 'earnings' | 'profile';
type Page = { type: 'task'; id: string } | { type: 'notifications' | 'support' | 'language' } | null;
type Dashboard = { todayDeliveries: number; todayEarningsPaise: string };
type LiveData = { status: RiderStatus | null; offers: Offer[]; tasks: Task[]; history: HistoryTask[]; historyCursor: string | null;
  historyLoaded: boolean; dashboard: Dashboard | null; earnings: Earning[]; earningsCursor: string | null; earningsLoaded: boolean;
  cash: { cashInHandPaise: string; limitPaise: string | null } | null; notifications: Notice[]; notificationsLoaded: boolean };
const initial: LiveData = { status: null, offers: [], tasks: [], history: [], historyCursor: null, historyLoaded: false,
  dashboard: null, earnings: [], earningsCursor: null, earningsLoaded: false, cash: null, notifications: [], notificationsLoaded: false };
const tabs: { key: Tab; label: string; icon: IconName; active: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home-outline', active: 'home' },
  { key: 'tasks', label: 'Tasks', icon: 'clipboard-outline', active: 'clipboard' },
  { key: 'route', label: 'Routes', icon: 'location-outline', active: 'location' },
  { key: 'earnings', label: 'Earnings', icon: 'bar-chart-outline', active: 'bar-chart' },
  { key: 'profile', label: 'Profile', icon: 'person-outline', active: 'person' },
];

export function LivePartner({ identity, application, onSignOut, onAuthorizationChange }: { identity: PartnerIdentity; application: Application; onSignOut: () => Promise<void>; onAuthorizationChange: () => Promise<void> }) {
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<LiveData>(initial);
  const [tab, setTab] = useState<Tab>('home');
  const [page, setPage] = useState<Page>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const actionBusy = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const dataRef = useRef(data);
  useEffect(() => { dataRef.current = data; }, [data]);
  const push = usePush();
  const language = useDemo((state) => state.language);
  const setLanguage = useDemo((state) => state.setLanguage);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const work = (async () => {
      const results = await Promise.allSettled([
        riderApi.status(), riderApi.offers(), riderApi.activeTasks(), riderApi.history(),
        riderApi.dashboard(), riderApi.earnings(), riderApi.cash(), riderApi.notifications(),
      ] as const);
      const [status, offers, tasks, history, dashboard, earnings, cash, notifications] = results;
      const operational = status.status === 'fulfilled' && offers.status === 'fulfilled' && tasks.status === 'fulfilled';
      setConnected(operational);
      setData((previous) => ({
        status: status.status === 'fulfilled' ? status.value : previous.status,
        offers: offers.status === 'fulfilled' ? offers.value.items : previous.offers,
        tasks: tasks.status === 'fulfilled' ? tasks.value.items : previous.tasks,
        history: history.status === 'fulfilled' ? history.value.items : previous.history,
        historyCursor: history.status === 'fulfilled' ? history.value.nextCursor : previous.historyCursor,
        historyLoaded: history.status === 'fulfilled' || previous.historyLoaded,
        dashboard: dashboard.status === 'fulfilled' ? dashboard.value : previous.dashboard,
        earnings: earnings.status === 'fulfilled' ? earnings.value.items : previous.earnings,
        earningsCursor: earnings.status === 'fulfilled' ? earnings.value.nextCursor : previous.earningsCursor,
        earningsLoaded: earnings.status === 'fulfilled' || previous.earningsLoaded,
        cash: cash.status === 'fulfilled' ? cash.value : previous.cash,
        notifications: notifications.status === 'fulfilled' ? notifications.value.items : previous.notifications,
        notificationsLoaded: notifications.status === 'fulfilled' || previous.notificationsLoaded,
      }));
      if (status.status === 'fulfilled') setTracking(await reconcileTracking(identity.subject, status.value.status.online).catch(() => false));
      if (!operational) {
        const failure = [status, offers, tasks].find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected' && failure.reason instanceof ApiError && failure.reason.status === 403) {
          await stopTracking().catch(() => undefined);
          await onAuthorizationChange().catch(() => undefined);
        }
        setError('Could not refresh delivery data. Reconnect and try again.');
      } else if (results.some((result) => result.status === 'rejected')) {
        setError('Some account information could not be refreshed.');
      } else setError('');
      setLoading(false);
    })();
    inFlight.current = work.finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, [identity.subject, onAuthorizationChange]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') {
        if (dataRef.current.status?.status.online && tracking) void riderApi.heartbeat().catch(() => undefined);
        void refresh();
      }
    }, 20000);
    const app = AppState.addEventListener('change', (state) => { if (state === 'active') void refresh(); });
    return () => { clearInterval(timer); app.remove(); };
  }, [refresh, tracking]);

  useEffect(() => {
    const stop = startPush(identity.subject, () => void refresh(), () => { setPage({ type: 'notifications' }); void refresh(); });
    return stop;
  }, [identity.subject, refresh]);

  useEffect(() => {
    try { return startRiderRealtime(setSocketConnected, () => void refresh()); }
    catch { return undefined; }
  }, [refresh]);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (page) { setPage(null); return true; }
      if (tab !== 'home') { setTab('home'); return true; }
      return false;
    });
    return () => back.remove();
  }, [page, tab]);

  async function doWork(work: () => Promise<unknown>, sync = true) {
    if (actionBusy.current) return false;
    actionBusy.current = true; setBusy(true); setError('');
    try { await work(); if (sync) await refresh(); return true; }
    catch (failure) {
      if (failure instanceof ApiError && (failure.status === 0 || failure.status >= 500))
        setError(`${failure.message} The request may have gone through; refresh and retry the same action to confirm.`);
      else setError(failure instanceof Error ? failure.message : 'Could not complete the request.');
      await refresh().catch(() => undefined);
      // A successful refresh must not hide the action's error.
      setError(failure instanceof ApiError && (failure.status === 0 || failure.status >= 500)
        ? `${failure.message} The request may have gone through; refresh and retry the same action to confirm.`
        : failure instanceof Error ? failure.message : 'Could not complete the request.');
      return false;
    } finally { actionBusy.current = false; setBusy(false); }
  }
  const online = data.status?.status.online === true;
  async function toggleOnline(value: boolean) { await doWork(() => value ? startShift(identity.subject) : endShift()); }
  async function taskAction(task: Task, action: string, body: unknown) {
    return doWork(() => performAction(identity.subject, task.id, action, (key) => riderApi.taskAction(task.id, action, body, key)));
  }
  async function offerAction(offer: Offer, action: 'accept' | 'decline') {
    const done = await doWork(() => performAction(identity.subject, offer.offerId, action,
      (key) => action === 'accept' ? riderApi.accept(offer.offerId, key) : riderApi.decline(offer.offerId, key)));
    if (done && action === 'accept') setPage({ type: 'task', id: offer.taskId });
  }
  async function logout() {
    if (actionBusy.current) return;
    actionBusy.current = true; setBusy(true); setError('');
    try {
      const latest = await riderApi.status();
      if (latest.status.online) await endShift(); else await stopTracking();
      await unregisterPush(identity.subject);
      await onSignOut();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not sign out.'); }
    finally { actionBusy.current = false; setBusy(false); }
  }
  async function moreHistory() {
    if (!data.historyCursor) return;
    const result = await riderApi.history(data.historyCursor);
    setData((old) => ({ ...old, history: [...old.history, ...result.items], historyCursor: result.nextCursor }));
  }
  async function moreEarnings() {
    if (!data.earningsCursor) return;
    const result = await riderApi.earnings(data.earningsCursor);
    setData((old) => ({ ...old, earnings: [...old.earnings, ...result.items], earningsCursor: result.nextCursor }));
  }
  const selectedTask = page?.type === 'task' ? data.tasks.find((task) => task.id === page.id) : undefined;
  const unavailableTracking = online && !tracking;
  const showPage = (next: Page) => setPage(next);

  let body;
  if (page?.type === 'task') body = selectedTask ? <TaskDetail key={selectedTask.id} task={selectedTask} enabled={connected} busy={busy} run={(action, value) => taskAction(selectedTask, action, value)} />
    : <><PageTitle title="Delivery unavailable" subtitle="This order is no longer assigned to you. Check your history for its latest status." /><Button label="Back to tasks" onPress={() => { setPage(null); setTab('tasks'); }} /></>;
  else if (page?.type === 'support') body = <SupportScreen subject={identity.subject} />;
  else if (page?.type === 'notifications') body = <><PageTitle title="Notifications" subtitle="Updates about your deliveries and account." />
    {data.notifications.length ? <Button label="Mark all read" secondary compact onPress={() => void doWork(() => riderApi.readNotifications())} /> : <Empty text={!data.notificationsLoaded ? 'Connect to load notifications.' : 'No notifications yet.'} />}
    <View style={{ height: 12 }} />{data.notifications.map((notice) => <Card key={notice.id}><Text style={styles.strong}>{notice.title}</Text><Text style={styles.sub}>{notice.body}</Text><Text style={styles.small}>{shortTime(notice.createdAt)}</Text></Card>)}
  </>;
  else if (page?.type === 'language') body = <><PageTitle title="Language" subtitle="Choose the language shown on this device." />
    {([['en', 'English'], ['hi', 'हिन्दी'], ['te', 'తెలుగు'], ['kn', 'ಕನ್ನಡ']] as const).map(([code, label]) => <Pressable key={code} onPress={() => setLanguage(code)}><Card><Text style={styles.strong}>{label} {language === code ? '✓' : ''}</Text></Card></Pressable>)}
  </>;
  else if (tab === 'home') body = <>
    <View style={[styles.row, { marginBottom: 14 }]}><View style={styles.avatar}><Text style={styles.avatarText}>{identity.name.slice(0, 1).toUpperCase()}</Text></View><View style={{ flex: 1 }}>
      <Text style={styles.eyebrow}>HELLO, {identity.name.toUpperCase()}</Text><Text style={styles.welcome}>Ready for a fresh day?</Text><Text style={styles.sub}>Your delivery overview</Text></View></View>
    <Card style={styles.shiftCard}><View style={styles.row}><View style={{ flex: 1 }}><Text style={styles.strong}>{!data.status ? 'Checking your status' : online ? data.status.status.onBreak ? 'You are on a break' : 'You are online' : 'You are offline'}</Text>
      <Text style={styles.sub}>{!data.status ? 'Connect to load your shift.' : data.status.status.onBreak ? 'You will not receive new offers while on break.' : online ? 'Your shift is active.' : 'Go online to receive nearby delivery offers.'}</Text></View>
      <Switch accessibilityLabel="Go online" value={online} disabled={!connected || busy} onValueChange={(value) => void toggleOnline(value)} trackColor={{ true: colors.green, false: colors.lineStrong }} />
    </View>{online ? <Button label={data.status?.status.onBreak ? 'End break' : 'Take a break'} compact secondary disabled={!connected || busy} onPress={() => void doWork(() => riderApi.break(!data.status?.status.onBreak))} /> : null}</Card>
    {unavailableTracking ? <Text style={styles.warning}>Location sharing is interrupted. Go offline and start your shift again.</Text> : null}
    {data.status?.status.unreachableSince ? <Text style={styles.warning}>Your connection was interrupted; check your location and network.</Text> : null}
    <View style={styles.stats}><Card style={styles.stat}><Text style={styles.small}>TODAY&apos;S DELIVERIES</Text><Text style={styles.statValue}>{data.dashboard ? data.dashboard.todayDeliveries : '—'}</Text></Card>
      <Card style={styles.stat}><Text style={styles.small}>TODAY&apos;S EARNINGS</Text><Text style={styles.statValue}>{formatMoney(data.dashboard?.todayEarningsPaise)}</Text></Card></View>
    <Section title="New offers" action="See tasks" onPress={() => setTab('tasks')} />
    {data.offers.length ? data.offers.map((offer) => <OfferCard key={offer.offerId} offer={offer} disabled={!connected || busy} act={offerAction} />) : <Empty text={loading ? 'Loading offers…' : connected ? 'No new offers right now.' : 'Connect to load offers.'} />}
    <Section title="Active deliveries" action="View all" onPress={() => setTab('tasks')} />
    {data.tasks.length ? data.tasks.map((task) => <TaskCard key={task.id} task={task} onPress={() => showPage({ type: 'task', id: task.id })} />) : <Empty text={loading ? 'Loading deliveries…' : connected ? 'No active deliveries.' : 'Connect to load deliveries.'} />}
    <View style={styles.farmBanner}><Image source={require('../../assets/images/farm-scene-hd.png')} contentFit="cover" style={StyleSheet.absoluteFill} />
      <LinearGradient colors={['rgba(250,246,227,0.98)', 'rgba(250,246,227,0.05)']} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
      <Text style={styles.farmTitle}>Fresh from{'\n'}our farms</Text><Text style={styles.small}>Every delivery makes a difference</Text></View>
  </>;
  else if (tab === 'tasks') body = <><PageTitle title="Your tasks" subtitle="Offers, active deliveries and your recent history." />
    <Text style={styles.sectionTitle}>New offers</Text>{data.offers.length ? data.offers.map((offer) => <OfferCard key={offer.offerId} offer={offer} disabled={!connected || busy} act={offerAction} />) : <Empty text={connected ? 'No new offers.' : 'Connect to load offers.'} />}
    <Text style={styles.sectionTitle}>Active deliveries</Text>{data.tasks.length ? data.tasks.map((task) => <TaskCard key={task.id} task={task} onPress={() => showPage({ type: 'task', id: task.id })} />) : <Empty text={connected ? 'No active deliveries.' : 'Connect to load deliveries.'} />}
    <Text style={styles.sectionTitle}>History</Text>{data.history.length ? data.history.map((item) => <Card key={`${item.id}-${item.attemptNo}`}><View style={styles.row}><View style={{ flex: 1 }}><Text style={styles.strong}>{item.orderNumber}</Text><Text style={styles.sub}>{item.status.replaceAll('_', ' ')} · {shortTime(item.assignedAt)}</Text></View><Text>{formatMoney(item.totalPaise)}</Text></View></Card>) : <Empty text={data.historyLoaded ? 'No delivery history yet.' : 'Connect to load delivery history.'} />}
    {data.historyCursor ? <Button label="Load more history" secondary onPress={() => void doWork(moreHistory, false)} /> : null}
  </>;
  else if (tab === 'route') body = <><PageTitle title="Deliveries" subtitle="Open an active delivery for pickup and destination directions." />
    {data.tasks.length ? data.tasks.map((task) => <TaskCard key={task.id} task={task} onPress={() => showPage({ type: 'task', id: task.id })} />) : <Empty text="Your active deliveries will appear here." />}
    <Card><Text style={styles.sub}>Optimized multi-stop routes are not available yet.</Text></Card></>;
  else if (tab === 'earnings') body = <><PageTitle title="Earnings" subtitle="Confirmed earnings and cash held from deliveries." />
    <View style={styles.stats}><Card style={styles.stat}><Text style={styles.small}>TODAY</Text><Text style={styles.statValue}>{formatMoney(data.dashboard?.todayEarningsPaise)}</Text></Card>
      <Card style={styles.stat}><Text style={styles.small}>CASH IN HAND</Text><Text style={styles.statValue}>{formatMoney(data.cash?.cashInHandPaise)}</Text></Card></View>
    {data.cash?.limitPaise ? <Text style={styles.sub}>Cash limit: {formatMoney(data.cash.limitPaise)}</Text> : null}
    <Text style={styles.sectionTitle}>Earnings history</Text>{data.earnings.length ? data.earnings.map((earning) => <Card key={earning.taskId}><View style={styles.row}><View style={{ flex: 1 }}><Text style={styles.strong}>Delivery</Text><Text style={styles.sub}>{shortTime(earning.computedAt)}</Text></View><Text style={styles.strong}>{formatMoney(earning.totalPaise)}</Text></View></Card>) : <Empty text={data.earningsLoaded ? 'No earnings recorded yet.' : 'Connect to load earnings.'} />}
    {data.earningsCursor ? <Button label="Load more earnings" secondary onPress={() => void doWork(moreEarnings, false)} /> : null}
    <Card><Text style={styles.sub}>Payout requests and withdrawal details are not available yet.</Text></Card></>;
  else body = <><PageTitle title="Profile" subtitle="Your partner account and preferences." />
    <Card><View style={styles.row}><View style={styles.avatar}><Text style={styles.avatarText}>{identity.name.slice(0, 1).toUpperCase()}</Text></View><View style={{ flex: 1 }}><Text style={styles.strong}>{identity.name}</Text><Text style={styles.sub}>{identity.email}</Text><Text style={styles.small}>Approved partner</Text></View></View></Card>
    <Card><Text style={styles.strong}>Vehicle &amp; documents</Text><Text style={styles.sub}>{application.vehicleType || 'Vehicle'} · {application.vehicleNo || 'Number unavailable'}</Text>
      <Text style={styles.small}>{application.documents.filter((document) => document.status === 'APPROVED').length} approved documents</Text></Card>
    <Card><Menu icon="globe-outline" label="Language" detail={language.toUpperCase()} onPress={() => showPage({ type: 'language' })} />
      <Menu icon="headset-outline" label="Help & support" onPress={() => showPage({ type: 'support' })} />
      <Menu icon="notifications-outline" label="Notifications" onPress={() => showPage({ type: 'notifications' })} />
    </Card>
    <Card><Text style={styles.strong}>Delivery alerts</Text><Text style={styles.sub}>{push.status === 'enabled' ? 'Android push alerts are enabled.' : push.status === 'unsupported' ? 'Remote push is available in an Android development build. Your inbox remains available.' : push.message || 'Enable alerts for new delivery offers.'}</Text>
      {push.status !== 'unsupported' && push.status !== 'enabled' ? <><View style={styles.space} /><Button label="Enable alerts" secondary compact disabled={busy || push.status === 'busy'} onPress={() => void enablePush(identity.subject)} /></> : null}</Card>
    <Card><Text style={styles.sub}>Schedules, payout requests, and emergency assistance are not available yet.</Text></Card>
    <Button label="Sign out" secondary disabled={busy} onPress={() => void logout()} /></>;

  return <View style={[styles.root, { paddingTop: insets.top }]}>
    <View style={styles.header}>{page ? <IconButton name="arrow-back" label="Back" onPress={() => setPage(null)} /> : null}<View style={{ flex: 1 }}><Brand /></View>
      <IconButton name="notifications-outline" label="Notifications" onPress={() => showPage({ type: 'notifications' })} /></View>
    <View style={styles.connection}><Text style={styles.connectionText}>{connected ? socketConnected ? 'Live updates connected' : 'Connected · checking for updates' : 'Connection unavailable'}</Text></View>
    {error ? <Pressable onPress={() => void refresh()}><Text accessibilityRole="alert" style={styles.warning}>{error}</Text></Pressable> : null}
    <ScrollView key={page ? `${page.type}${page.type === 'task' ? page.id : ''}` : tab} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: page ? insets.bottom + 25 : 20 }]}>{body}</ScrollView>
    {!page ? <View style={[styles.nav, { paddingBottom: Math.max(8, insets.bottom) }]}>{tabs.map((item) => <Pressable key={item.key} accessibilityRole="tab" accessibilityState={{ selected: tab === item.key }} onPress={() => setTab(item.key)} style={[styles.navItem, tab === item.key && styles.navActive]}>
      <Ionicons name={tab === item.key ? item.active : item.icon} size={21} color={tab === item.key ? colors.inverse : colors.secondary} /><Text style={[styles.navText, tab === item.key && { color: colors.inverse }]}>{item.label}</Text>
    </Pressable>)}</View> : null}
  </View>;
}

function OfferCard({ offer, disabled, act }: { offer: Offer; disabled: boolean; act: (offer: Offer, action: 'accept' | 'decline') => Promise<void> }) {
  return <Card><View style={styles.row}><IconBox name="cube-outline" /><View style={{ flex: 1 }}><Text style={styles.strong}>{offer.orderNumber}</Text><Text style={styles.sub}>Pickup · {offer.storeName}</Text></View></View>
    <Text style={styles.small}>Offer expires {shortTime(offer.expiresAt)}{offer.codAmountPaise !== null ? ` · Cash ${formatMoney(offer.codAmountPaise)}` : ''}</Text>
    <View style={styles.buttons}><Button label="Decline" secondary compact disabled={disabled} style={{ flex: 1 }} onPress={() => void act(offer, 'decline')} /><Button label="Accept" compact disabled={disabled} style={{ flex: 1 }} onPress={() => void act(offer, 'accept')} /></View></Card>;
}
function TaskCard({ task, onPress }: { task: Task; onPress: () => void }) {
  return <Pressable onPress={onPress} accessibilityRole="button"><Card><View style={styles.row}><IconBox name="bicycle-outline" /><View style={{ flex: 1 }}><Text style={styles.strong}>{task.orderNumber}</Text><Text style={styles.sub}>{task.store.name} · {task.status.replaceAll('_', ' ')}</Text></View><Ionicons name="chevron-forward" size={20} color={colors.secondary} /></View></Card></Pressable>;
}
function Empty({ text }: { text: string }) { return <Card><Text style={styles.sub}>{text}</Text></Card>; }
function Section({ title, action, onPress }: { title: string; action: string; onPress: () => void }) { return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text><Pressable onPress={onPress}><Text style={styles.link}>{action}</Text></Pressable></View>; }
function Menu({ icon, label, detail, onPress }: { icon: IconName; label: string; detail?: string; onPress: () => void }) { return <Pressable onPress={onPress} style={styles.menu}><Ionicons name={icon} size={20} color={colors.green} /><Text style={{ flex: 1 }}>{label}</Text>{detail ? <Text style={styles.sub}>{detail}</Text> : null}<Ionicons name="chevron-forward" size={18} color={colors.secondary} /></Pressable>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background }, header: { minHeight: 58, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center' },
  connection: { backgroundColor: colors.greenSoft, alignItems: 'center', padding: 5 }, connectionText: { color: colors.greenDark, fontSize: 10 },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 16, paddingTop: 17 }, eyebrow: { fontSize: 10, color: colors.green, fontFamily: fonts.semibold, letterSpacing: 1 }, welcome: { fontFamily: fonts.bold, fontSize: 18, lineHeight: 25 },
  shiftCard: { backgroundColor: colors.greenSoft }, row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, strong: { fontFamily: fonts.semibold, fontSize: 14 },
  sub: { color: colors.secondary, fontSize: 12, lineHeight: 19, marginTop: 4 }, small: { color: colors.secondary, fontSize: 10, marginTop: 4 },
  stats: { flexDirection: 'row', gap: 10 }, stat: { flex: 1, padding: 13 }, statValue: { fontFamily: fonts.bold, color: colors.greenDark, fontSize: 21, marginTop: 4 },
  section: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }, sectionTitle: { fontFamily: fonts.semibold, fontSize: 16, marginVertical: 12 }, link: { color: colors.green, fontSize: 11 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 12 }, warning: { color: colors.danger, backgroundColor: '#FAE9D5', padding: 9, textAlign: 'center', fontSize: 11 },
  farmBanner: { height: 122, borderRadius: 17, overflow: 'hidden', justifyContent: 'center', padding: 16, marginBottom: 12 }, farmTitle: { fontFamily: fonts.bold, fontSize: 18, lineHeight: 24, color: colors.greenDeep },
  avatar: { width: 52, height: 52, backgroundColor: colors.greenTint, borderRadius: 26, alignItems: 'center', justifyContent: 'center' }, avatarText: { color: colors.green, fontSize: 22, fontFamily: fonts.bold },
  menu: { flexDirection: 'row', gap: 10, alignItems: 'center', minHeight: 48 }, space: { height: 10 }, nav: { backgroundColor: colors.raised, borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', paddingHorizontal: 8, paddingTop: 7 },
  navItem: { flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 51, borderRadius: 16, marginHorizontal: 2, gap: 2 }, navActive: { backgroundColor: colors.green }, navText: { color: colors.secondary, fontFamily: fonts.medium, fontSize: 9 },
});
