/// <reference types="jest" />
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { refreshControlProp } from './pull-refresh-helpers';
import { LivePartner } from '../src/screens/LivePartner';
import { ApplicationScreen } from '../src/screens/ApplicationScreen';
import { performAction } from '../src/actions';
import { riderApi, type Application, type RiderStatus } from '../src/api';

jest.mock('../src/api', () => ({
  ApiError: class ApiError extends Error {}, UploadError: class UploadError extends Error {},
  riderApi:{onboardingStores:jest.fn(),status:jest.fn(),offers:jest.fn(),activeTasks:jest.fn(),history:jest.fn(),dashboard:jest.fn(),earnings:jest.fn(),cash:jest.fn(),notifications:jest.fn(),accept:jest.fn(),decline:jest.fn()},
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
jest.mock('../src/push', () => ({usePush:() => ({status:'unsupported',message:''}),startPush:() => () => {},enablePush:jest.fn(),unregisterPush:jest.fn()}));
const realtimeCallbacks: { onChange?: (event?: string) => void } = {};
jest.mock('../src/realtime', () => ({startRiderRealtime:(_onConnection:unknown, onChange:(event?:string)=>void) => { realtimeCallbacks.onChange = onChange; return () => {}; }}));
jest.mock('../src/store', () => ({useDemo:(selector:(value:unknown)=>unknown) => selector({language:'en',setLanguage:jest.fn()})}));
jest.mock('../src/tracking', () => ({reconcileTracking:async () => false,stopTracking:jest.fn(),startShift:jest.fn(),endShift:jest.fn()}));
jest.mock('../src/screens/TaskDetail', () => ({TaskDetail:() => null}));
jest.mock('../src/screens/SupportScreen', () => ({SupportScreen:() => null}));
jest.mock('@expo/vector-icons', () => ({Ionicons:() => null}));
jest.mock('expo-image', () => ({Image:() => null}));
jest.mock('expo-linear-gradient', () => { const React=require('react'), {View}=require('react-native'); return {LinearGradient:({children}:{children:React.ReactNode}) => React.createElement(View,null,children)}; });
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets:() => ({top:0,bottom:0})}));
jest.mock('react-native/Libraries/Components/Switch/Switch', () => ({__esModule:true,default:'Switch'}));

const application = {userId:'rider',status:'APPROVED',vehicleType:null,vehicleNo:null,homeStoreId:null,requiredDocuments:[],documents:[]} as Application;
const offline: RiderStatus = {status:{online:false,onBreak:false}} as RiderStatus;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(riderApi.status).mockResolvedValue(offline);
  jest.mocked(riderApi.offers).mockResolvedValue({items:[]});
  jest.mocked(riderApi.activeTasks).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(riderApi.history).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(riderApi.dashboard).mockResolvedValue({todayDeliveries:0,todayEarningsPaise:'0'});
  jest.mocked(riderApi.earnings).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(riderApi.cash).mockResolvedValue({cashInHandPaise:'0',limitPaise:null});
  jest.mocked(riderApi.notifications).mockResolvedValue({items:[],nextCursor:null});
});

test('an offer event refetches offers only, leaving other resources untouched', async () => {
  await render(<LivePartner identity={{subject:'rider',name:'Rider',email:'rider@example.invalid'}} application={application} onSignOut={async () => {}} onAuthorizationChange={async () => {}} />);
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(1);
  await act(async () => { realtimeCallbacks.onChange?.('offer.revoked'); });
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.dashboard)).toHaveBeenCalledTimes(1);
});

test('a task event refetches tasks only', async () => {
  await render(<LivePartner identity={{subject:'rider',name:'Rider',email:'rider@example.invalid'}} application={application} onSignOut={async () => {}} onAuthorizationChange={async () => {}} />);
  await act(async () => { realtimeCallbacks.onChange?.('task.updated'); });
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(1);
});

test('pulling on the routes tab revalidates tasks without refetching earnings', async () => {
  await render(<LivePartner identity={{subject:'rider',name:'Rider',email:'rider@example.invalid'}} application={application} onSignOut={async () => {}} onAuthorizationChange={async () => {}} />);
  await fireEvent.press(screen.getByText('Routes'));
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(1);
  await act(async () => { await refreshControlProp().onRefresh?.(); });
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.earnings)).toHaveBeenCalledTimes(1);
  expect(refreshControlProp().refreshing).toBe(false);
});

test('a snapshot event refetches every resource', async () => {
  await render(<LivePartner identity={{subject:'rider',name:'Rider',email:'rider@example.invalid'}} application={application} onSignOut={async () => {}} onAuthorizationChange={async () => {}} />);
  await act(async () => { realtimeCallbacks.onChange?.('snapshot'); });
  expect(jest.mocked(riderApi.status)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.history)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.dashboard)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.earnings)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.cash)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.notifications)).toHaveBeenCalledTimes(2);
});

function offer(offerId: string, taskId: string) {
  return { offerId, taskId, orderId: `order-${offerId}`, storeId: 'store-1', attemptNo: 1, orderNumber: `ORD-${offerId}`, storeName: 'Fresh Store', expiresAt: new Date(Date.now() + 60000).toISOString(), codAmountPaise: null };
}

test('accepting an offer hydrates tasks only and opens the task page', async () => {
  jest.mocked(riderApi.offers).mockResolvedValue({ items: [offer('off-1', 'task-1')] });
  jest.mocked(performAction).mockImplementation(async (_subject: string, _id: string, _action: string, run: (key: string) => Promise<unknown>) => run('key-1'));
  jest.mocked(riderApi.accept).mockResolvedValue(undefined);
  await render(<LivePartner identity={{subject:'rider',name:'Rider',email:'rider@example.invalid'}} application={application} onSignOut={async () => {}} onAuthorizationChange={async () => {}} />);
  let hydrate!: (page: Awaited<ReturnType<typeof riderApi.activeTasks>>) => void;
  jest.mocked(riderApi.activeTasks).mockImplementationOnce(() => new Promise(resolve => { hydrate = resolve; }));
  await act(async () => { await fireEvent.press(screen.getByText('Accept')); });
  expect(jest.mocked(riderApi.accept)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.offers)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.activeTasks)).toHaveBeenCalledTimes(2);
  expect(jest.mocked(riderApi.earnings)).toHaveBeenCalledTimes(1);
  expect(jest.mocked(riderApi.dashboard)).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText('Loading delivery details')).toBeTruthy();
  expect(screen.queryByText('Delivery unavailable')).toBeNull();
  await act(async () => { hydrate({ items: [], nextCursor: null }); });
  expect(screen.getByText('Delivery unavailable')).toBeTruthy();
});

test('offer locks are scoped per offer: another offer still proceeds, the same one waits', async () => {
  jest.mocked(riderApi.offers).mockResolvedValue({ items: [offer('off-1', 'task-1'), offer('off-2', 'task-2')] });
  jest.mocked(performAction).mockImplementation(async (_subject: string, _id: string, _action: string, run: (key: string) => Promise<unknown>) => run('key-1'));
  const gates = [1, 2, 3].map(() => { let go!: (value: unknown) => void; const promise = new Promise<unknown>((yes) => { go = yes; }); return { promise: promise as Promise<never>, go: go! }; });
  jest.mocked(riderApi.accept).mockReturnValueOnce(gates[0].promise).mockReturnValueOnce(gates[1].promise).mockReturnValueOnce(gates[2].promise);
  await render(<LivePartner identity={{subject:'rider',name:'Rider',email:'rider@example.invalid'}} application={application} onSignOut={async () => {}} onAuthorizationChange={async () => {}} />);
  const [first, second] = screen.getAllByText('Accept');
  await act(async () => {
    fireEvent.press(first);
    fireEvent.press(first);
    fireEvent.press(second);
  });
  expect(jest.mocked(riderApi.accept)).toHaveBeenCalledTimes(2);
  await act(async () => { gates[0].go(undefined); gates[1].go(undefined); });
});

test('application status pulls to reload without a Refresh status button', async () => {
  jest.mocked(riderApi.onboardingStores).mockResolvedValue([]);
  const reload = jest.fn().mockResolvedValue(undefined);
  await render(<ApplicationScreen application={{...application, status: 'PENDING', requiredDocuments: [], documents: []}} reload={reload} signOut={async () => {}} />);
  expect(screen.queryByText('Refresh status')).toBeNull();
  type Node = { props?: Record<string, unknown>; children?: Node[] };
  let element: Record<string, unknown> | undefined;
  const stack: Node[] = [screen.toJSON() as Node];
  while (stack.length && !element) {
    const node = stack.pop()!;
    element = node.props?.refreshControl as Record<string, unknown> | undefined;
    if (!element && node.children) stack.push(...node.children);
  }
  const control = (element?.props ?? {}) as Record<string, unknown>;
  expect(control.refreshing).toBe(false);
  await act(async () => { await (control.onRefresh as () => unknown)(); });
  expect(reload).toHaveBeenCalledTimes(1);
});
