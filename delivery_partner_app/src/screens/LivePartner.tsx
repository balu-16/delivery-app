import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { AppState, BackHandler, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { performAction } from '../actions';
import { ApiError, apiBase, riderApi, type AppContentItem, type Application, type Earning, type HistoryTask, type Offer, type RiderStatus, type Task } from '../api';
import { type PartnerIdentity } from '../auth/session';
import { Brand } from '../components/Brand';
import { CardListSkeleton, SkeletonBlock } from '../components/Skeleton';
import { Button, Card, IconBox, IconButton, PageTitle, Text, type IconName } from '../components/Ui';
import { enablePush, startPush, unregisterPush, usePush } from '../push';
import { startRiderRealtime } from '../realtime';
import { useRouter } from 'expo-router';
import { useDemo } from '../store';
import { useRefresh } from '../useRefresh';
import { colors, fonts } from '../theme';
import { endShift, reconcileTracking, startShift, stopTracking } from '../tracking';
import { dedupedRead, formatMoney, invalidateLiveRequests, liveRequestGeneration, shortTime } from './liveHelpers';
import { resolvePartnerNotification, partnerHref, shouldNavigate } from '../notification-routing';
import { setPartnerIdentity } from '../partner-session';

type Tab = 'home' | 'tasks' | 'route' | 'earnings' | 'profile';
type Page = { type: 'language' } | null;
type Dashboard = { todayDeliveries: number; todayEarningsPaise: string };
type LoadKey = 'status' | 'offers' | 'tasks' | 'history' | 'dashboard' | 'earnings' | 'cash' | 'notifications';
type LoadState = 'loading' | 'success' | 'error';
/** Operational state: rendered first, polled and refreshed on socket/push events. */
type OpsData = { status: RiderStatus | null; offers: Offer[]; tasks: Task[] };
/** Metrics state: loaded after operational state, refreshed per-view. */
type MetricsData = { dashboard: Dashboard | null; earnings: Earning[]; earningsCursor: string | null; earningsLoaded: boolean;
  cash: { cashInHandPaise: string; limitPaise: string | null } | null; history: HistoryTask[]; historyCursor: string | null; historyLoaded: boolean };
const initialOps: OpsData = { status: null, offers: [], tasks: [] };
const initialMetrics: MetricsData = { dashboard: null, earnings: [], earningsCursor: null, earningsLoaded: false,
  cash: null, history: [], historyCursor: null, historyLoaded: false };
const initialLoads: Record<LoadKey, LoadState> = { status:'loading', offers:'loading', tasks:'loading', history:'loading', dashboard:'loading', earnings:'loading', cash:'loading', notifications:'loading' };
const tabs: { key: Tab; label: string; icon: IconName; active: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home-outline', active: 'home' },
  { key: 'tasks', label: 'Tasks', icon: 'clipboard-outline', active: 'clipboard' },
  { key: 'route', label: 'Routes', icon: 'location-outline', active: 'location' },
  { key: 'earnings', label: 'Earnings', icon: 'bar-chart-outline', active: 'bar-chart' },
  { key: 'profile', label: 'Profile', icon: 'person-outline', active: 'person' },
];

export function LivePartner({ identity, application, onSignOut, onAuthorizationChange }: { identity: PartnerIdentity; application: Application; onSignOut: () => Promise<void>; onAuthorizationChange: () => Promise<void> }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const subject = identity.subject;
  // Split state: operational / metrics / notifications update independently,
  // so a heartbeat or notification never rerenders the whole screen and
  // memoized sections below bail out on unchanged references.
  const [ops, setOps] = useState<OpsData>(initialOps);
  const [metrics, setMetrics] = useState<MetricsData>(initialMetrics);
  const [tab, setTab] = useState<Tab>('home');
  const [page, setPage] = useState<Page>(null);
  const [error, setError] = useState('');
  const [loads, setLoads] = useState(initialLoads);
  const [busy, setBusy] = useState(false);
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState<AppContentItem[] | null>(null);
  const [connected, setConnected] = useState(false);
  const [tracking, setTracking] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const actionBusy = useRef(false);
  const busyIdsRef = useRef<ReadonlySet<string>>(new Set());
  const inFlight = useRef<Promise<void> | null>(null);
  const latestLoad = useRef<Partial<Record<LoadKey, number>>>({});
  const opsRef = useRef(ops);
  useEffect(() => { opsRef.current = ops; }, [ops]);
  const trackingRef = useRef(tracking);
  useEffect(() => { trackingRef.current = tracking; }, [tracking]);
  const pageRef = useRef(page);
  const navigationVersion = useRef(0);
  const pageType = page?.type;
  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => { navigationVersion.current += 1; }, [tab, pageType]);
  // Superseded reads are ignored after navigation away or sign-out.
  useEffect(() => () => { invalidateLiveRequests(); }, []);
  const push = usePush();
  const language = useDemo((state) => state.language);
  const setLanguage = useDemo((state) => state.setLanguage);
  const isBusy = (id: string) => busy || busyIds.has(id);

  // App content (customize2 §3E): home announcement follows entry /
  // foreground / pull-to-refresh; prior view kept during refresh.
  const refreshAnnouncement = useCallback(async () => {
    try {
      setAnnouncement(await riderApi.appContent(language));
    } catch { /* keep prior view / bundled banner */ }
  }, [language]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (tab === 'home') void refreshAnnouncement();
  }, [tab, refreshAnnouncement]);

  // Registry key -> single shared fetch for this account. The resource is
  // the text before the first ':'; the remainder (record ID / cursor) is
  // passed through untouched because cursors are opaque.
  const keyFor = useCallback((key: string) => dedupedRead(subject, key, (async (signal) => {
    const separator = key.indexOf(':');
    const resource = separator === -1 ? key : key.slice(0, separator);
    const record = separator === -1 ? '' : key.slice(separator + 1);
    switch (resource) {
      case 'status': return riderApi.status({ signal });
      case 'offers': return riderApi.offers({ signal });
      case 'tasks': return riderApi.activeTasks({ signal });
      case 'dashboard': return riderApi.dashboard({ signal });
      case 'cash': return riderApi.cash({ signal });
      case 'notifications': return riderApi.notifications({ signal });
      case 'history': return riderApi.history(record || undefined, { signal });
      case 'earnings': return riderApi.earnings(record || undefined, { signal });
      case 'task': return riderApi.task(record, { signal });
      default: throw new Error(`Unknown live read: ${key}`);
    }
  })), [subject]);

  const load = useCallback(<T,>(key: LoadKey, registryKey: string, update: (value: T) => void): Promise<T> => {
    const request = (latestLoad.current[key] ?? 0) + 1;
    latestLoad.current[key] = request;
    const generation = liveRequestGeneration();
    return keyFor(registryKey).then(value => {
      if (generation === liveRequestGeneration() && latestLoad.current[key] === request) {
        update(value as T);
        setLoads(previous => ({ ...previous, [key]: 'success' }));
      }
      return value as T;
    }, failure => {
      if (generation === liveRequestGeneration() && latestLoad.current[key] === request)
        setLoads(previous => ({ ...previous, [key]: previous[key] === 'success' ? 'success' : 'error' }));
      throw failure;
    });
  }, [keyFor]);

  // Per-resource reads. Each applies only to its own state slice.
  const refreshStatusEntry = useCallback(async () => {
    const generation = liveRequestGeneration();
    try {
      return await load<RiderStatus>('status', 'status', (status) => {
        setOps(previous => ({ ...previous, status }));
        setConnected(true);
      });
    } catch (failure) {
      if (generation === liveRequestGeneration()) setConnected(false);
      throw failure;
    }
  }, [load]);
  const refreshOffers = useCallback(() => load<{ items: Offer[] }>('offers', 'offers', (value) => setOps((p) => ({ ...p, offers: value.items }))), [load]);
  const refreshTasks = useCallback(() => load<{ items: Task[]; nextCursor: string | null }>('tasks', 'tasks', (value) => setOps((p) => ({ ...p, tasks: value.items }))), [load]);
  const refreshHistoryEntry = useCallback(() => load<{ items: HistoryTask[]; nextCursor: string | null }>('history', 'history:', (value) => setMetrics((p) => ({ ...p, history: value.items, historyCursor: value.nextCursor, historyLoaded: true }))), [load]);
  const refreshDashboard = useCallback(() => load<Dashboard>('dashboard', 'dashboard', (value) => setMetrics((p) => ({ ...p, dashboard: value }))), [load]);
  const refreshEarningsEntry = useCallback(() => load<{ items: Earning[]; nextCursor: string | null }>('earnings', 'earnings:', (value) => setMetrics((p) => ({ ...p, earnings: value.items, earningsCursor: value.nextCursor, earningsLoaded: true }))), [load]);
  const refreshCash = useCallback(() => load<{ cashInHandPaise: string; limitPaise: string | null }>('cash', 'cash', (value) => setMetrics((p) => ({ ...p, cash: value }))), [load]);
  // Inbox lives in the /notifications route; this only warms the shared registry on push arrival.
  const refreshNotifications = useCallback(() => load('notifications', 'notifications', () => {}), [load]);
  const retryLoad = (key: LoadKey, refreshResource: () => Promise<unknown>) => {
    setLoads(previous => ({ ...previous, [key]: 'loading' }));
    void refreshResource().catch(() => undefined);
  };
  const refreshOperational = useCallback(async () => {
    const generation = liveRequestGeneration();
    const results = await Promise.allSettled([refreshStatusEntry(), refreshOffers(), refreshTasks()]);
    if (generation !== liveRequestGeneration()) return;
    const [status] = results;
    if (status.status === 'fulfilled') {
      void reconcileTracking(subject, status.value.status.online).then(value => {
        if (generation === liveRequestGeneration()) setTracking(value);
      }).catch(() => {
        if (generation === liveRequestGeneration()) setTracking(false);
      });
    }
    const forbidden = results.some(result => result.status === 'rejected'
      && result.reason instanceof ApiError && result.reason.status === 403);
    if (forbidden) {
      await stopTracking().catch(() => undefined);
      if (generation === liveRequestGeneration()) await onAuthorizationChange().catch(() => undefined);
    }
  }, [refreshStatusEntry, refreshOffers, refreshTasks, subject, onAuthorizationChange]);
  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const generation = liveRequestGeneration();
    inFlight.current = (async () => {
      await refreshOperational();
      if (generation === liveRequestGeneration()) await refreshDashboard().catch(() => undefined);
    })().finally(() => { inFlight.current = null; });
    return inFlight.current;
  }, [refreshOperational, refreshDashboard]);
  // Task detail lives in the expo-router route `/tasks/[taskId]` (plan3 section 5);
  // the list hydrates behind that route and the route loads its own detail.
  const openTask = useCallback((id: string) => {
    const href = { pathname: '/tasks/[taskId]', params: { taskId: id } };
    if (shouldNavigate(href)) {
      router.push(href as never);
    }
  }, [router]);
  const openOffer = useCallback((offerId: string) => {
    router.push(`/offers/[offerId]` as never, { offerId } as never);
  }, [router]);
  const openHistory = useCallback((taskId: string, attemptNo?: number) => {
    const params: Record<string, string> = { taskId };
    if (attemptNo !== undefined) params.attemptNo = String(attemptNo);
    router.push(`/history/[taskId]` as never, params as never);
  }, [router]);
  const openNotifications = useCallback(() => {
    router.push(`/notifications` as never);
  }, [router]);
  const openSupport = useCallback(() => {
    router.push(`/support` as never);
  }, [router]);
  // Pull-to-refresh: revalidate only what the current view shows.
  const refreshView = useCallback(async () => {
    if (page?.type === 'language') return;
    if (tab === 'tasks') { await Promise.allSettled([refreshOffers(), refreshTasks(), refreshHistoryEntry()]); return; }
    if (tab === 'route') { await refreshTasks(); return; }
    if (tab === 'earnings') { await Promise.allSettled([refreshDashboard(), refreshEarningsEntry(), refreshCash()]); return; }
    if (tab === 'profile') { await Promise.allSettled([refreshStatusEntry(), onAuthorizationChange()]); return; }
    await refresh();
    await refreshAnnouncement();
  }, [page, tab, refresh, refreshOffers, refreshTasks, refreshHistoryEntry, refreshDashboard, refreshEarningsEntry, refreshCash, refreshStatusEntry, onAuthorizationChange, refreshAnnouncement]);
  const pull = useRefresh(() => refreshView());

  useEffect(() => {
    if (pageType) return;
    if (tab === 'tasks') void refreshHistoryEntry().catch(() => undefined);
    if (tab === 'earnings') void Promise.allSettled([refreshDashboard(), refreshEarningsEntry(), refreshCash()]);
    if (tab === 'profile') void onAuthorizationChange().catch(() => undefined);
  }, [tab, pageType, refreshHistoryEntry, refreshDashboard, refreshEarningsEntry, refreshCash, refreshNotifications, onAuthorizationChange]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') {
        if (opsRef.current.status?.status.online && trackingRef.current) void riderApi.heartbeat().catch(() => undefined);
        void refreshOperational();
      }
    }, 20000);
    return () => { clearInterval(timer); };
  }, [refresh, refreshOperational]);

  useEffect(() => {
    // Foreground return refreshes the visible view plus operational state.
    const app = AppState.addEventListener('change', (state) => {
      if (state === 'active') { void refreshOperational(); void refreshAnnouncement(); void refreshView().catch(() => undefined); }
    });
    return () => { app?.remove(); };
  }, [refreshOperational, refreshView, refreshAnnouncement]);

  useEffect(() => {
    // Keep the shift, location tracking, push registration and live request
    // registry mounted for the same signed-in account across route changes.
    setPartnerIdentity(identity);
    const stop = startPush(
      subject,
      () => void refreshNotifications().catch(() => undefined),
      (data?: unknown) => {
        void refreshNotifications().catch(() => undefined);
        const resolved = resolvePartnerNotification(data ?? {});
        const href = partnerHref(resolved);
        if (shouldNavigate(href)) {
          if (href.params) router.push(href.pathname as never, href.params as never);
          else router.push(href.pathname as never);
        }
      },
    );
    return stop;
  }, [subject, router, refreshNotifications, identity]);

  useEffect(() => {
    try {
      return startRiderRealtime(setSocketConnected, (event) => {
        // Split refresh by resource: offer events refetch offers, task
        // events refetch tasks; the periodic poll covers anything missed.
        if (event === 'offer.created' || event === 'offer.revoked') void refreshOffers().catch(() => undefined);
        else if (event === 'task.updated' || event === 'task.cancelled') {
          void refreshTasks().catch(() => undefined);
        }
        else if (event === 'snapshot') void refresh();
        else void refreshOperational();
      });
    }
    catch { return undefined; }
  }, [refresh, refreshOffers, refreshTasks, refreshOperational]);

  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      if (page) { setPage(null); return true; }
      if (tab !== 'home') { setTab('home'); return true; }
      return false;
    });
    return () => back.remove();
  }, [page, tab]);

  // Action locks are scoped: task/offer actions lock only their own card
  // (busyIdsRef), while account-level actions keep the global lock.
  const doWork = useCallback(async (work: () => Promise<unknown>, scopeId?: string, after?: () => void) => {
    if (scopeId) {
      if (busyIdsRef.current.has(scopeId)) return false;
      busyIdsRef.current = new Set(busyIdsRef.current).add(scopeId);
      setBusyIds(busyIdsRef.current);
    } else {
      if (actionBusy.current) return false;
      actionBusy.current = true; setBusy(true);
    }
    const generation = liveRequestGeneration();
    setError('');
    try {
      await work();
      if (generation !== liveRequestGeneration()) return false;
      if (after) after();
      else if (!scopeId) void refreshOperational();
      return true;
    }
    catch (failure) {
      if (generation !== liveRequestGeneration()) return false;
      const ambiguous = failure instanceof ApiError && (failure.status === 0 || failure.status >= 500);
      setError(ambiguous ? 'Couldn’t confirm the update. Retry the same action.'
        : failure instanceof Error ? failure.message : 'Could not complete the request.');
      if (ambiguous) void refreshOperational();
      return false;
    } finally {
      if (scopeId) {
        const next = new Set(busyIdsRef.current);
        next.delete(scopeId);
        busyIdsRef.current = next;
        if (generation === liveRequestGeneration()) setBusyIds(next);
      }
      else { actionBusy.current = false; setBusy(false); }
    }
  }, [refreshOperational]);
  const online = ops.status?.status.online === true;
  const toggleOnline = useCallback(async (value: boolean) => { await doWork(() => value ? startShift(subject) : endShift()); }, [subject, doWork]);
  const offerAction = useCallback(async (offer: Offer, action: 'accept' | 'decline') => {
    const version = navigationVersion.current;
    await doWork(() => performAction(subject, offer.offerId, action,
      (key) => action === 'accept' ? riderApi.accept(offer.offerId, key) : riderApi.decline(offer.offerId, key)),
      `offer:${offer.offerId}`, () => {
        setOps(previous => ({ ...previous, offers: previous.offers.filter(item => item.offerId !== offer.offerId) }));
        if (action === 'accept' && version === navigationVersion.current) {
          // Navigate to the assigned task if still in that flow; otherwise
          // refresh in the background and preserve the current screen.
          openTask(offer.taskId);
        }
        void refreshTasks().catch(() => undefined);
        void refreshOffers().catch(() => undefined);
      });
  }, [subject, doWork, refreshOffers, refreshTasks, openTask]);
  const logout = useCallback(async () => {
    if (actionBusy.current) return;
    actionBusy.current = true; setBusy(true); setError('');
    try {
      const latest = await riderApi.status();
      if (latest.status.online) await endShift(); else await stopTracking();
      await unregisterPush(subject);
      await onSignOut();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not sign out.'); }
    finally { actionBusy.current = false; setBusy(false); }
  }, [subject, onSignOut]);
  async function moreHistory() {
    if (!metrics.historyCursor) return;
    const result = await keyFor(`history:${metrics.historyCursor}`) as { items: HistoryTask[]; nextCursor: string | null };
    setMetrics((old) => ({ ...old, history: [...old.history, ...result.items], historyCursor: result.nextCursor }));
  }
  async function moreEarnings() {
    if (!metrics.earningsCursor) return;
    const result = await keyFor(`earnings:${metrics.earningsCursor}`) as { items: Earning[]; nextCursor: string | null };
    setMetrics((old) => ({ ...old, earnings: [...old.earnings, ...result.items], earningsCursor: result.nextCursor }));
  }
  const unavailableTracking = online && !tracking;

  const connectionText = loads.status === 'loading' && !ops.status ? 'Checking connection…' : connected ? socketConnected ? 'Live updates connected' : 'Connected · checking for updates' : 'Connection unavailable';
  const scrollProps = {
    testID: 'rider-scroll' as const,
    keyboardShouldPersistTaps: 'handled' as const,
    refreshControl: <RefreshControl testID="rider-pull-refresh" refreshing={pull.refreshing} onRefresh={() => { void pull.onRefresh(); }} tintColor={colors.greenDark} />,
  };
  const scrollStyle = [styles.content, { flexGrow: 1, paddingBottom: page ? insets.bottom + 25 : 20 }];

  let view;
  if (page?.type === 'language') view = <ScrollView {...scrollProps} key="language" contentContainerStyle={scrollStyle}><PageTitle title="Language" subtitle="Choose the language shown on this device." />
    {([['en', 'English'], ['hi', 'हिन्दी'], ['te', 'తెలుగు'], ['kn', 'ಕನ್ನಡ']] as const).map(([code, label]) => <Pressable key={code} onPress={() => setLanguage(code)}><Card><Text style={styles.strong}>{label} {language === code ? '✓' : ''}</Text></Card></Pressable>)}
  </ScrollView>;
  else if (tab === 'home') view = <ScrollView {...scrollProps} key="home" contentContainerStyle={scrollStyle}>
    <View style={[styles.row, { marginBottom: 14 }]}><View style={styles.avatar}><Text style={styles.avatarText}>{identity.name.slice(0, 1).toUpperCase()}</Text></View><View style={{ flex: 1 }}>
      <Text style={styles.eyebrow}>HELLO, {identity.name.toUpperCase()}</Text><Text style={styles.welcome}>Ready for a fresh day?</Text><Text style={styles.sub}>Application approved</Text></View></View>
    {loads.status === 'loading' && !ops.status ? <CardListSkeleton label="Loading shift status" count={1} /> : loads.status === 'error' && !ops.status ? <ResourceEmpty state={loads.status} label="shift status" empty="" onRetry={() => retryLoad('status', refreshOperational)} /> : <Card style={styles.shiftCard}><View style={styles.row}><View style={{ flex: 1 }}><Text style={styles.strong}>{!ops.status ? 'Checking your status' : online ? ops.status.status.onBreak ? 'You are on a break' : 'You are online' : 'You are offline'}</Text>
      <Text style={styles.sub}>{!ops.status ? 'Connect to load your shift.' : ops.status.status.onBreak ? 'You will not receive new offers while on break.' : online ? 'Your shift is active.' : 'Go online to receive nearby delivery offers.'}</Text></View>
      <Switch accessibilityLabel="Go online" value={online} disabled={!connected || busy} onValueChange={(value) => void toggleOnline(value)} trackColor={{ true: colors.green, false: colors.lineStrong }} />
    </View>{online ? <Button label={ops.status?.status.onBreak ? 'End break' : 'Take a break'} compact secondary disabled={!connected || busy} onPress={() => void doWork(() => riderApi.break(!ops.status?.status.onBreak))} /> : null}</Card>}
    {unavailableTracking ? <Text style={styles.warning}>Location sharing is interrupted. Go offline and start your shift again.</Text> : null}
    {ops.status?.status.unreachableSince ? <Text style={styles.warning}>Your connection was interrupted; check your location and network.</Text> : null}
    <View style={styles.stats}><Card style={styles.stat}><Text style={styles.small}>TODAY&apos;S DELIVERIES</Text><MetricValue state={loads.dashboard} label="today's deliveries" value={metrics.dashboard?.todayDeliveries ?? '—'} /></Card>
      <Card style={styles.stat}><Text style={styles.small}>TODAY&apos;S EARNINGS</Text><MetricValue state={loads.dashboard} label="today’s earnings" value={formatMoney(metrics.dashboard?.todayEarningsPaise)} /></Card></View>
    <Section title="New offers" action="See tasks" onPress={() => setTab('tasks')} />
    {ops.offers.length ? ops.offers.map((offer) => <OfferCard key={offer.offerId} offer={offer} disabled={!connected || isBusy(`offer:${offer.offerId}`)} act={offerAction} onOpen={() => openOffer(offer.offerId)} />) : <ResourceEmpty state={loads.offers} label="offers" empty="No new offers right now." onRetry={() => retryLoad('offers', refreshOffers)} />}
    <Section title="Active deliveries" action="View all" onPress={() => setTab('tasks')} />
    {ops.tasks.length ? ops.tasks.map((task) => <TaskCard key={task.id} task={task} onPressId={openTask} />) : <ResourceEmpty state={loads.tasks} label="deliveries" empty="No active deliveries." onRetry={() => retryLoad('tasks', refreshTasks)} />}
    {announcement?.find(item => item.slot === 'RIDER_HOME_ANNOUNCEMENT')?.state === 'VISIBLE'
      ? (() => {
          const item = announcement!.find(entry => entry.slot === 'RIDER_HOME_ANNOUNCEMENT')!;
          return <Pressable onPress={() => { if (item.destination?.startsWith('/support')) openSupport(); else if (item.destination?.startsWith('/notifications')) openNotifications(); }} accessibilityRole="button" accessibilityLabel={item.title ?? 'Announcement'}><View style={styles.farmBanner}>{item.imageUrl ? <Image source={{ uri: `${apiBase()}${item.imageUrl}` }} contentFit="cover" style={StyleSheet.absoluteFill} /> : <Image source={require('../../assets/images/farm-scene-hd.png')} contentFit="cover" style={StyleSheet.absoluteFill} />}
            <LinearGradient colors={['rgba(250,246,227,0.98)', 'rgba(250,246,227,0.05)']} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
            {item.title ? <Text style={styles.farmTitle}>{item.title}</Text> : null}{item.body ? <Text style={styles.small}>{item.body}</Text> : null}</View></Pressable>;
        })()
      : announcement?.find(item => item.slot === 'RIDER_HOME_ANNOUNCEMENT')?.state === 'DISABLED'
        || announcement?.find(item => item.slot === 'RIDER_HOME_ANNOUNCEMENT')?.state === 'INACTIVE' ? null
      : <View style={styles.farmBanner}><Image source={require('../../assets/images/farm-scene-hd.png')} contentFit="cover" style={StyleSheet.absoluteFill} />
      <LinearGradient colors={['rgba(250,246,227,0.98)', 'rgba(250,246,227,0.05)']} start={{ x: 0, y: 0.5 }} end={{ x: 1, y: 0.5 }} style={StyleSheet.absoluteFill} />
      <Text style={styles.farmTitle}>Fresh from{'\n'}our farms</Text><Text style={styles.small}>Every delivery makes a difference</Text></View>}
  </ScrollView>;
  else if (tab === 'tasks') view = <FlatList {...scrollProps} key="tasks" data={metrics.history} removeClippedSubviews
    keyExtractor={(item) => `${item.id}-${item.attemptNo}`}
    renderItem={({ item }) => <HistoryRow item={item} onOpen={() => openHistory(item.id, item.attemptNo)} />}
    contentContainerStyle={scrollStyle}
    ListHeaderComponent={<><PageTitle title="Your tasks" subtitle="Offers, active deliveries and your recent history." />
      <Text style={styles.sectionTitle}>New offers</Text>{ops.offers.length ? ops.offers.map((offer) => <OfferCard key={offer.offerId} offer={offer} disabled={!connected || isBusy(`offer:${offer.offerId}`)} act={offerAction} onOpen={() => openOffer(offer.offerId)} />) : <ResourceEmpty state={loads.offers} label="offers" empty="No new offers." onRetry={() => retryLoad('offers', refreshOffers)} />}
      <Text style={styles.sectionTitle}>Active deliveries</Text>{ops.tasks.length ? ops.tasks.map((task) => <TaskCard key={task.id} task={task} onPressId={openTask} />) : <ResourceEmpty state={loads.tasks} label="deliveries" empty="No active deliveries." onRetry={() => retryLoad('tasks', refreshTasks)} />}
      <Text style={styles.sectionTitle}>History</Text></>}
    ListEmptyComponent={<ResourceEmpty state={loads.history} label="delivery history" empty="No delivery history yet." onRetry={() => retryLoad('history', refreshHistoryEntry)} />}
    ListFooterComponent={metrics.historyCursor ? <Button label="Load more history" secondary onPress={() => void doWork(moreHistory, 'history')} /> : undefined} />;
  else if (tab === 'route') view = <ScrollView {...scrollProps} key="route" contentContainerStyle={scrollStyle}><PageTitle title="Deliveries" subtitle="Open an active delivery for pickup and destination directions." />
    {ops.tasks.length ? ops.tasks.map((task) => <TaskCard key={task.id} task={task} onPressId={openTask} />) : <ResourceEmpty state={loads.tasks} label="deliveries" empty="Your active deliveries will appear here." onRetry={() => retryLoad('tasks', refreshTasks)} />}
    <Card><Text style={styles.sub}>Optimized multi-stop routes are not available yet.</Text></Card></ScrollView>;
  else if (tab === 'earnings') view = <FlatList {...scrollProps} key="earnings" data={metrics.earnings} removeClippedSubviews
    keyExtractor={(earning) => earning.taskId}
    renderItem={({ item }) => <EarningRow earning={item} onOpen={() => openHistory(item.taskId)} />}
    contentContainerStyle={scrollStyle}
    ListHeaderComponent={<><PageTitle title="Earnings" subtitle="Confirmed earnings and cash held from deliveries." />
      <View style={styles.stats}><Card style={styles.stat}><Text style={styles.small}>TODAY</Text><MetricValue state={loads.dashboard} label="today’s earnings" value={formatMoney(metrics.dashboard?.todayEarningsPaise)} /></Card>
        <Card style={styles.stat}><Text style={styles.small}>CASH IN HAND</Text><MetricValue state={loads.cash} label="cash in hand" value={formatMoney(metrics.cash?.cashInHandPaise)} /></Card></View>
      {metrics.cash?.limitPaise ? <Text style={styles.sub}>Cash limit: {formatMoney(metrics.cash.limitPaise)}</Text> : null}
      <Text style={styles.sectionTitle}>Earnings history</Text></>}
    ListEmptyComponent={<ResourceEmpty state={loads.earnings} label="earnings" empty="No earnings recorded yet." onRetry={() => retryLoad('earnings', refreshEarningsEntry)} />}
    ListFooterComponent={<>{metrics.earningsCursor ? <Button label="Load more earnings" secondary onPress={() => void doWork(moreEarnings, 'earnings')} /> : null}
      <Card><Text style={styles.sub}>Payout requests and withdrawal details are not available yet.</Text></Card></>} />;
  else view = <ScrollView {...scrollProps} key="profile" contentContainerStyle={scrollStyle}><PageTitle title="Profile" subtitle="Your partner account and preferences." />
    <Card><View style={styles.row}><View style={styles.avatar}><Text style={styles.avatarText}>{identity.name.slice(0, 1).toUpperCase()}</Text></View><View style={{ flex: 1 }}><Text style={styles.strong}>{identity.name}</Text><Text style={styles.sub}>{identity.email}</Text><Text style={styles.small}>Approved partner</Text></View></View></Card>
    <Card><Text style={styles.strong}>Vehicle &amp; documents</Text><Text style={styles.sub}>{application.vehicleType || 'Vehicle'} · {application.vehicleNo || 'Number unavailable'}</Text>
      <Text style={styles.small}>{application.documents.filter((document) => document.status === 'APPROVED').length} approved documents</Text></Card>
    <Card><Menu icon="globe-outline" label="Language" detail={language.toUpperCase()} onPress={() => setPage({ type: 'language' })} />
      <Menu icon="headset-outline" label="Help & support" onPress={openSupport} />
      <Menu icon="notifications-outline" label="Notifications" onPress={openNotifications} />
    </Card>
    <Card><Text style={styles.strong}>Delivery alerts</Text><Text style={styles.sub}>{push.status === 'enabled' ? 'Android push alerts are enabled.' : push.status === 'unsupported' ? 'Remote push is available in an Android development build. Your inbox remains available.' : push.message || 'Enable alerts for new delivery offers.'}</Text>
      {push.status !== 'unsupported' && push.status !== 'enabled' ? <><View style={styles.space} /><Button label="Enable alerts" secondary compact disabled={busy || push.status === 'busy'} onPress={() => void enablePush(subject)} /></> : null}</Card>
    <Card><Text style={styles.sub}>Schedules, payout requests, and emergency assistance are not available yet.</Text></Card>
    <Button label="Sign out" secondary disabled={busy} onPress={() => void logout()} /></ScrollView>;

  return <View style={[styles.root, { paddingTop: insets.top }]}>
    <View style={styles.header}>{page ? <IconButton name="arrow-back" label="Back" onPress={() => setPage(null)} /> : null}<View style={{ flex: 1 }}><Brand /></View>
      <IconButton name="notifications-outline" label="Notifications" onPress={openNotifications} /></View>
    <View style={styles.connection}><Text style={styles.connectionText}>{connectionText}</Text></View>
    {error ? <Pressable onPress={() => void refresh()}><Text accessibilityRole="alert" style={styles.warning}>{error}</Text></Pressable> : null}
    <View style={{ flex: 1 }}>{view}</View>
    {!page ? <View style={[styles.nav, { paddingBottom: Math.max(8, insets.bottom) }]}>{tabs.map((item) => <Pressable key={item.key} accessibilityRole="tab" accessibilityState={{ selected: tab === item.key }} onPress={() => setTab(item.key)} style={[styles.navItem, tab === item.key && styles.navActive]}>
      <Ionicons name={tab === item.key ? item.active : item.icon} size={21} color={tab === item.key ? colors.inverse : colors.secondary} /><Text style={[styles.navText, tab === item.key && { color: colors.inverse }]}>{item.label}</Text>
    </Pressable>)}</View> : null}
  </View>;
}

const OfferCard = memo(function OfferCard({ offer, disabled, act, onOpen }: { offer: Offer; disabled: boolean; act: (offer: Offer, action: 'accept' | 'decline') => Promise<void>; onOpen?: () => void }) {
  return <Card><View style={styles.row}><IconBox name="cube-outline" /><View style={{ flex: 1 }}><Text style={styles.strong}>{offer.orderNumber}</Text><Text style={styles.sub}>Pickup · {offer.storeName}</Text></View></View>
    <Text style={styles.small}>Offer expires {shortTime(offer.expiresAt)}{offer.codAmountPaise !== null ? ` · Cash ${formatMoney(offer.codAmountPaise)}` : ''}</Text>
    <View style={styles.buttons}><Button label="Decline" secondary compact disabled={disabled} style={{ flex: 1 }} onPress={() => void act(offer, 'decline')} /><Button label="Accept" compact disabled={disabled} style={{ flex: 1 }} onPress={() => void act(offer, 'accept')} /></View>
    {onOpen ? <View style={{ marginTop: 8 }}><Button label="View offer" secondary compact onPress={onOpen} /></View> : null}
  </Card>;
});

const TaskCard = memo(function TaskCard({ task, onPressId }: { task: Task; onPressId: (id: string) => void }) {
  return <Pressable onPress={() => onPressId(task.id)} accessibilityRole="button"><Card><View style={styles.row}><IconBox name="bicycle-outline" /><View style={{ flex: 1 }}><Text style={styles.strong}>{task.orderNumber}</Text><Text style={styles.sub}>{task.store.name} · {task.status.replaceAll('_', ' ')}</Text></View><Ionicons name="chevron-forward" size={20} color={colors.secondary} /></View></Card></Pressable>;
});

const HistoryRow = memo(function HistoryRow({ item, onOpen }: { item: HistoryTask; onOpen?: () => void }) {
  const inner = <Card><View style={styles.row}><View style={{ flex: 1 }}><Text style={styles.strong}>{item.orderNumber}</Text><Text style={styles.sub}>{item.status.replaceAll('_', ' ')} · {shortTime(item.assignedAt)}</Text></View><Text>{formatMoney(item.totalPaise)}</Text></View></Card>;
  return onOpen ? <Pressable accessibilityRole="button" onPress={onOpen}>{inner}</Pressable> : inner;
});

const EarningRow = memo(function EarningRow({ earning, onOpen }: { earning: Earning; onOpen?: () => void }) {
  const inner = <Card><View style={styles.row}><View style={{ flex: 1 }}><Text style={styles.strong}>Delivery</Text><Text style={styles.sub}>{shortTime(earning.computedAt)}</Text>{earning.distancePending && <Text style={styles.sub}>Distance pay is awaiting review.</Text>}</View><Text style={styles.strong}>{formatMoney(earning.totalPaise)}</Text></View></Card>;
  return onOpen ? <Pressable accessibilityRole="button" onPress={onOpen}>{inner}</Pressable> : inner;
});

function Empty({ text }: { text: string }) { return <Card><Text style={styles.sub}>{text}</Text></Card>; }
function ResourceEmpty({ state, label, empty, onRetry }: { state: LoadState; label: string; empty: string; onRetry: () => void }) {
  if (state === 'loading') return <CardListSkeleton label={`Loading ${label}`} count={2} />;
  if (state === 'error') return <Card><Text accessibilityRole="alert" style={styles.sub}>Could not load {label}.</Text><Button label="Try again" secondary compact onPress={onRetry} /></Card>;
  return <Empty text={empty} />;
}
function MetricValue({ state, label, value }: { state: LoadState; label: string; value: string | number }) {
  if (state === 'loading') return <View accessible accessibilityLabel={`Loading ${label}`} accessibilityState={{busy:true}}><SkeletonBlock width={76} height={22} style={{marginTop:5}} /></View>;
  return <Text style={styles.statValue}>{state === 'error' ? 'Unavailable' : value}</Text>;
}
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
