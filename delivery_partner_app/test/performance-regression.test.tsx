/// <reference types="jest" />
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, BackHandler } from 'react-native';
import { refreshControlProp } from './pull-refresh-helpers';
import { LivePartner } from '../src/screens/LivePartner';
import { SupportScreen } from '../src/screens/SupportScreen';
import { reconcileTracking } from '../src/tracking';
import { performAction } from '../src/actions';
import { riderApi, type Application, type RiderStatus } from '../src/api';
import { dedupedRead, invalidateLiveRequests, liveRequestGeneration } from '../src/screens/liveHelpers';
import { clearPartnerTapCache } from '../src/notification-routing';

jest.mock('../src/api', () => ({
  ApiError: class ApiError extends Error {}, UploadError: class UploadError extends Error {},
  riderApi:{onboardingStores:jest.fn(),status:jest.fn(),offers:jest.fn(),activeTasks:jest.fn(),task:jest.fn(),history:jest.fn(),dashboard:jest.fn(),earnings:jest.fn(),cash:jest.fn(),notifications:jest.fn(),readNotifications:jest.fn(),accept:jest.fn(),decline:jest.fn(),taskAction:jest.fn(),heartbeat:jest.fn(),break:jest.fn(),tickets:jest.fn(),ticket:jest.fn(),createTicket:jest.fn(),ticketMessage:jest.fn(),appContent:jest.fn(async () => [])},
}));
jest.mock('../src/components/Brand', () => ({ Brand:() => null }));
jest.mock('../src/actions', () => ({performAction:jest.fn()}));
jest.mock('../src/components/Ui', () => {
  const React=require('react'), native=require('react-native');
  return {
    Text:native.Text, Card:({children}:{children:React.ReactNode}) => React.createElement(native.View,null,children),
    Button:({label,onPress,disabled}:{label:string;onPress:()=>void;disabled?:boolean}) => React.createElement(native.Pressable,{onPress,disabled,accessibilityRole:'button'},React.createElement(native.Text,null,label)),
    PageTitle:({title}:{title:string}) => React.createElement(native.Text,null,title), IconBox:() => null, IconButton:() => null,
  };
});
jest.mock('../src/files', () => ({uploadDocument:jest.fn()}));
jest.mock('../src/push', () => ({usePush:() => ({status:'unsupported',message:''}),startPush:(_userId:unknown, onUpdate:()=>void, onOpen:(data?:unknown)=>void) => { pushCallbacks.onUpdate = onUpdate; pushCallbacks.onOpen = onOpen; return () => {}; },enablePush:jest.fn(),unregisterPush:jest.fn()}));
const pushCallbacks: { onUpdate?: () => void; onOpen?: (data?: unknown) => void } = {};
const realtimeCallbacks: { onChange?: (event?: string) => void } = {};
jest.mock('../src/realtime', () => ({startRiderRealtime:(_onConnection:unknown, onChange:(event?:string)=>void) => { realtimeCallbacks.onChange = onChange; return () => {}; }}));
jest.mock('../src/store', () => ({useDemo:(selector:(value:unknown)=>unknown) => selector({language:'en',setLanguage:jest.fn()})}));
jest.mock('../src/tracking', () => ({reconcileTracking:jest.fn(async () => false),stopTracking:jest.fn(),startShift:jest.fn(),endShift:jest.fn()}));
jest.mock('../src/screens/TaskDetail', () => ({TaskDetail:({task}:{task:{id:string}}) => require('react').createElement(require('react-native').Text,null,`TaskDetail:${task.id}`)}));
jest.mock('../src/components/Skeleton', () => ({ CardListSkeleton: ({label}:{label:string}) => require('react').createElement(require('react-native').Text,null,label), SkeletonBlock:() => null }));
jest.mock('@expo/vector-icons', () => ({Ionicons:() => null}));
jest.mock('expo-image', () => ({Image:() => null}));
jest.mock('expo-linear-gradient', () => { const React=require('react'), {View}=require('react-native'); return {LinearGradient:({children}:{children:React.ReactNode}) => React.createElement(View,null,children)}; });
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets:() => ({top:0,bottom:0})}));
jest.mock('react-native/Libraries/Components/Switch/Switch', () => ({__esModule:true,default:'Switch'}));

const application = {userId:'rider',status:'APPROVED',vehicleType:null,vehicleNo:null,homeStoreId:null,homeStore:null,requiredDocuments:[],documents:[]} as Application;
const offline: RiderStatus = {status:{online:false,onBreak:false}} as RiderStatus;
const online: RiderStatus = {status:{online:true,onBreak:false}} as RiderStatus;

function offer(offerId: string, taskId: string) {
  return { offerId, taskId, orderId: `order-${offerId}`, storeId: 'store-1', attemptNo: 1, orderNumber: `ORD-${offerId}`, storeName: 'Fresh Store', expiresAt: new Date(Date.now() + 60000).toISOString(), codAmountPaise: null };
}
function task(id: string) {
  return { id, orderId: `order-${id}`, orderNumber: `ORD-${id}`, store: { name: 'Fresh Store', lat: null, lng: null }, destination: { name: null, line1: '', line2: '', landmark: '', pincode: '', lat: null, lng: null }, status: 'ASSIGNED', codAmountPaise: null, codCollectedPaise: null, handoverCode: null, items: [] };
}
function deferred<T>() {
  let resolve!: (value:T) => void;
  const promise = new Promise<T>(yes => {resolve=yes;});
  return {promise,resolve};
}

beforeEach(() => {
  jest.clearAllMocks();
  clearPartnerTapCache();
  jest.mocked(riderApi.status).mockResolvedValue(offline);
  jest.mocked(riderApi.offers).mockResolvedValue({items:[]});
  jest.mocked(riderApi.activeTasks).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(riderApi.history).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(riderApi.dashboard).mockResolvedValue({todayDeliveries:0,todayEarningsPaise:'0'});
  jest.mocked(riderApi.earnings).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(riderApi.cash).mockResolvedValue({cashInHandPaise:'0',limitPaise:null});
  jest.mocked(riderApi.notifications).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(performAction).mockImplementation(async (_subject: string, _id: string, _action: string, run: (key: string) => Promise<unknown>) => run('key-1'));
});
afterEach(() => {
  invalidateLiveRequests();
  jest.useRealTimers();
  if (Object.getOwnPropertyDescriptor(AppState, 'currentState')) delete (AppState as unknown as Record<string, unknown>).currentState;
});

test('foreground return refreshes the visible view plus operational state once each', async () => {
  let appCb!: (state: string) => void;
  const spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event: unknown, cb: unknown) => { appCb = cb as (state: string) => void; return { remove: () => undefined }; }) as never);
  const view = await renderPartner();
  await fireEvent.press(screen.getByText('Tasks'));
  await act(async () => { appCb('active'); });
  // Visible Tasks view (offers/tasks/history) + operational (status/offers/tasks),
  // with overlapping reads shared through the registry.
  expect(jest.mocked(riderApi.status)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.history)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.dashboard)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.earnings)).not.toHaveBeenCalled();
  view.unmount();
  spy.mockRestore();
});

async function renderPartner() {
  return render(<LivePartner identity={{subject:'rider',name:'Rider',email:'rider@example.invalid'}} application={application} onSignOut={async () => {}} onAuthorizationChange={async () => {}} />);
}

test('startup reads only the three operational resources and then the dashboard', async () => {
  const status = deferred<RiderStatus>();
  const offers = deferred<Awaited<ReturnType<typeof riderApi.offers>>>();
  jest.mocked(riderApi.status).mockReturnValue(status.promise);
  jest.mocked(riderApi.offers).mockReturnValue(offers.promise);
  await renderPartner();
  // Operational set is requested first; metrics wait for it to settle.
  expect(jest.mocked(riderApi.status)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.dashboard)).not.toHaveBeenCalled();
  await act(async () => { status.resolve(offline); offers.resolve({items:[]}); });
  expect(jest.mocked(riderApi.dashboard)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.earnings)).not.toHaveBeenCalled();
  expect(jest.mocked(riderApi.cash)).not.toHaveBeenCalled();
  expect(jest.mocked(riderApi.history)).not.toHaveBeenCalled();
  expect(jest.mocked(riderApi.notifications)).not.toHaveBeenCalled();
});

test('a slow or failed offers request leaves the loaded shift controls usable', async () => {
  const pendingOffers = deferred<Awaited<ReturnType<typeof riderApi.offers>>>();
  jest.mocked(riderApi.offers).mockReturnValueOnce(pendingOffers.promise);
  const switchControl = () => screen.getByLabelText('Go online');
  await renderPartner();
  expect(switchControl().props.disabled).toBe(false);
  await act(async () => { pendingOffers.resolve({ items: [] }); });
  jest.mocked(riderApi.offers).mockRejectedValueOnce(new Error('offline'));
  await act(async () => { await refreshControlProp().onRefresh?.(); });
  expect(switchControl().props.disabled).toBe(false);
});

test('per-view pulls refresh only what the view shows', async () => {
  await renderPartner();
  await fireEvent.press(screen.getByText('Tasks'));
  await act(async () => {});
  await act(async () => { await refreshControlProp().onRefresh?.(); });
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.history)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.dashboard)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.earnings)).not.toHaveBeenCalled();
  expect(jest.mocked(riderApi.notifications)).not.toHaveBeenCalled();

  await fireEvent.press(screen.getByText('Routes'));
  await act(async () => { await refreshControlProp().onRefresh?.(); });
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(3);
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(2);

  await fireEvent.press(screen.getByText('Earnings'));
  await act(async () => {});
  await act(async () => { await refreshControlProp().onRefresh?.(); });
  expect(jest.mocked(riderApi.dashboard)).toHaveBeenCalledTimes(3);
  expect(jest.mocked(riderApi.earnings)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.cash)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(3);

  await fireEvent.press(screen.getByText('Profile'));
  await act(async () => { await refreshControlProp().onRefresh?.(); });
  expect(jest.mocked(riderApi.status)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.dashboard)).toHaveBeenCalledTimes(3);
  expect(jest.mocked(riderApi.earnings)).toHaveBeenCalledTimes(2);
});

test('concurrent same-key reads share one request', async () => {
  await renderPartner();
  const gate = deferred<Awaited<ReturnType<typeof riderApi.offers>>>();
  jest.mocked(riderApi.offers).mockReturnValueOnce(gate.promise);
  await act(async () => { realtimeCallbacks.onChange?.('offer.created'); });
  await fireEvent.press(screen.getByText('Tasks'));
  await act(async () => { await refreshControlProp().onRefresh?.(); });
  // Both the offer event and the Tasks pull asked for offers: one fetch.
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(2);
  await act(async () => { gate.resolve({items:[]}); });
});

test('a push arrival refreshes notifications only', async () => {
  await renderPartner();
  await act(async () => { pushCallbacks.onUpdate?.(); });
  expect(jest.mocked(riderApi.notifications)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.status)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(1);
});

test('a push open navigates to the notifications route without extra reads', async () => {
  const { router } = require('expo-router');
  jest.mocked(router.push).mockClear();
  await renderPartner();
  await act(async () => { pushCallbacks.onOpen?.({}); });
  expect(jest.mocked(router.push)).toHaveBeenCalledWith('/notifications');
  expect(riderApi.status).toHaveBeenCalledTimes(1);
  expect(riderApi.dashboard).toHaveBeenCalledTimes(1);
});

test('the 20s poll refreshes operational resources only and heartbeats active shifts', async () => {
  jest.useFakeTimers();
  // The RN preset leaves AppState.currentState as a mock; pin it to active.
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.mocked(riderApi.status).mockResolvedValue(online);
  jest.mocked(reconcileTracking).mockResolvedValue(true);
  jest.mocked(riderApi.heartbeat).mockResolvedValue(undefined);
  await renderPartner();
  await act(async () => { await jest.advanceTimersByTimeAsync(20000); });
  expect(jest.mocked(riderApi.status)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.dashboard)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.earnings)).not.toHaveBeenCalled();
  expect(jest.mocked(riderApi.cash)).not.toHaveBeenCalled();
  expect(jest.mocked(riderApi.history)).not.toHaveBeenCalled();
  expect(jest.mocked(riderApi.notifications)).not.toHaveBeenCalled();
  expect(jest.mocked(riderApi.heartbeat)).toHaveBeenCalledTimes(1);
});

test('accepted offer navigates to the task route and refreshes tasks', async () => {
  const { router } = require('expo-router');
  jest.mocked(router.push).mockClear();
  jest.mocked(riderApi.offers).mockResolvedValue({ items: [offer('off-1', 'task-1')] });
  jest.mocked(riderApi.accept).mockResolvedValue(undefined);
  jest.mocked(riderApi.activeTasks).mockResolvedValue({ items: [task('task-1') as never], nextCursor: null });
  await renderPartner();
  await act(async () => { await fireEvent.press(screen.getByText('Accept')); });
  expect(jest.mocked(router.push)).toHaveBeenCalledWith(
    expect.objectContaining({ pathname: '/tasks/[taskId]', params: { taskId: 'task-1' } }),
  );
  expect(jest.mocked(riderApi.activeTasks).mock.calls.length).toBeGreaterThanOrEqual(2);
});

test('a delayed acceptance preserves the tab the rider opened while waiting', async () => {
  jest.mocked(riderApi.offers).mockResolvedValueOnce({ items: [offer('off-1', 'task-1')] });
  const accepting = deferred<void>();
  jest.mocked(riderApi.accept).mockReturnValueOnce(accepting.promise);
  jest.mocked(riderApi.task).mockResolvedValueOnce(task('task-1') as never);
  const { router } = require('expo-router');
  jest.mocked(router.push).mockClear();
  await renderPartner();
  await fireEvent.press(screen.getByText('Accept'));
  await fireEvent.press(screen.getByText('Earnings'));
  jest.mocked(riderApi.activeTasks).mockResolvedValue({ items: [task('task-1') as never], nextCursor: null });
  await act(async () => { accepting.resolve(); });
  expect(jest.mocked(router.push)).not.toHaveBeenCalled();
  expect(screen.queryByText('Ready for a fresh day?')).toBeNull();
  await fireEvent.press(screen.getByText('Tasks'));
  expect(screen.getByText('ORD-task-1')).toBeTruthy();
});

test('tapping a task card opens the task route', async () => {
  const { router } = require('expo-router');
  jest.mocked(router.push).mockClear();
  jest.mocked(riderApi.activeTasks).mockResolvedValue({ items: [task('task-1') as never], nextCursor: null });
  await renderPartner();
  await fireEvent.press(screen.getByText('ORD-task-1'));
  expect(jest.mocked(router.push)).toHaveBeenCalledWith(
    expect.objectContaining({ pathname: '/tasks/[taskId]', params: { taskId: 'task-1' } }),
  );
});

test('loaded offers stay visible while a background refresh is in flight', async () => {
  jest.mocked(riderApi.offers).mockResolvedValue({ items: [offer('off-1', 'task-1')] });
  await renderPartner();
  expect(screen.getByText('ORD-off-1')).toBeTruthy();
  const gate = deferred<Awaited<ReturnType<typeof riderApi.offers>>>();
  jest.mocked(riderApi.offers).mockReturnValueOnce(gate.promise);
  await act(async () => { realtimeCallbacks.onChange?.('offer.created'); });
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(2);
  expect(screen.getByText('ORD-off-1')).toBeTruthy();
  await act(async () => { gate.resolve({items:[]}); });
  expect(screen.queryByText('ORD-off-1')).toBeNull();
});

test('support draft survives a failed send and pull refreshes the conversation', async () => {
  jest.mocked(riderApi.tickets).mockResolvedValue({ items: [{ id: 'ticket-1', category: 'DELIVERY', status: 'OPEN', created_at: new Date(0).toISOString() }], nextCursor: null });
  jest.mocked(riderApi.ticket).mockResolvedValue({ messages: [] });
  jest.mocked(riderApi.ticketMessage).mockRejectedValueOnce(new Error('Could not send your message.'));
  const { rerender } = await render(<SupportScreen subject="rider" refreshSignal={0} />);
  await fireEvent.press(screen.getByText('DELIVERY'));
  // Wait until the conversation finished loading before typing and sending.
  expect(await screen.findByText('All conversations')).toBeTruthy();
  const input = screen.getByPlaceholderText('How can we help?');
  fireEvent.changeText(input, 'Still need help');
  // The draft value commits asynchronously inside the list footer.
  expect(await screen.findByDisplayValue('Still need help')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
  expect(await screen.findByText('Could not send your message.')).toBeTruthy();
  expect(screen.getByDisplayValue('Still need help')).toBeTruthy();
  expect(jest.mocked(riderApi.ticket)).toHaveBeenCalledTimes(1);
  await rerender(<SupportScreen subject="rider" refreshSignal={1} />);
  expect(await screen.findByText('Could not send your message.')).toBeTruthy();
  expect(jest.mocked(riderApi.ticket)).toHaveBeenCalledTimes(2);
  expect(screen.getByDisplayValue('Still need help')).toBeTruthy();
});

describe('live request registry', () => {
  test('concurrent same-key reads share one fetch; other keys and accounts fetch separately', async () => {
    const first = jest.fn().mockResolvedValue('one');
    const [a, b] = await Promise.all([dedupedRead('acct-a', 'offers', first), dedupedRead('acct-a', 'offers', first)]);
    expect(a).toBe('one');
    expect(b).toBe('one');
    expect(first).toHaveBeenCalledTimes(1);
    await dedupedRead('acct-a', 'tasks', first);
    await dedupedRead('acct-b', 'offers', first);
    expect(first).toHaveBeenCalledTimes(3);
  });
  test('settled and rejected reads are not cached; invalidation retires generations', async () => {
    const fetcher = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('ok');
    await expect(dedupedRead('acct-c', 'offers', fetcher)).rejects.toThrow('boom');
    await expect(dedupedRead('acct-c', 'offers', fetcher)).resolves.toBe('ok');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const before = liveRequestGeneration();
    invalidateLiveRequests();
    expect(liveRequestGeneration()).toBe(before + 1);
    await dedupedRead('acct-c', 'offers', fetcher);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test('invalidation aborts an in-flight read', async () => {
    const request = dedupedRead('acct-d', 'status', signal => new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
    }));
    invalidateLiveRequests();
    await expect(request).rejects.toThrow('cancelled');
  });
});
