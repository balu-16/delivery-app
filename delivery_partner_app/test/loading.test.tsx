/// <reference types="jest" />
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ApplicationScreen } from '../src/screens/ApplicationScreen';
import { LivePartner } from '../src/screens/LivePartner';
import { riderApi, type Application, type RiderStatus } from '../src/api';

jest.mock('../src/api', () => ({
  ApiError: class ApiError extends Error {}, UploadError: class UploadError extends Error {},
  riderApi:{onboardingStores:jest.fn(),status:jest.fn(),offers:jest.fn(),activeTasks:jest.fn(),history:jest.fn(),dashboard:jest.fn(),earnings:jest.fn(),cash:jest.fn(),notifications:jest.fn()},
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
jest.mock('../src/files', () => ({uploadDocument:jest.fn(),restoreDocumentUploads:jest.fn().mockResolvedValue([])}));
jest.mock('../src/push', () => ({usePush:() => ({status:'unsupported',message:''}),startPush:() => () => {},enablePush:jest.fn(),unregisterPush:jest.fn()}));
jest.mock('../src/realtime', () => ({startRiderRealtime:() => () => {}}));
jest.mock('../src/store', () => ({useDemo:(selector:(value:unknown)=>unknown) => selector({language:'en',setLanguage:jest.fn()})}));
jest.mock('../src/tracking', () => ({reconcileTracking:async () => false,stopTracking:jest.fn(),startShift:jest.fn(),endShift:jest.fn()}));
jest.mock('../src/screens/TaskDetail', () => ({TaskDetail:() => null}));
jest.mock('../src/screens/SupportScreen', () => ({SupportScreen:() => null}));
jest.mock('@expo/vector-icons', () => ({Ionicons:() => null}));
jest.mock('expo-image', () => ({Image:() => null}));
jest.mock('expo-linear-gradient', () => { const React=require('react'), {View}=require('react-native'); return {LinearGradient:({children}:{children:React.ReactNode}) => React.createElement(View,null,children)}; });
jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets:() => ({top:0,bottom:0})}));
jest.mock('react-native/Libraries/Components/Switch/Switch', () => ({__esModule:true,default:'Switch'}));

function deferred<T>() {
  let resolve!: (value:T) => void;
  const promise = new Promise<T>(yes => {resolve=yes;});
  return {promise,resolve};
}
const application = {userId:'rider',status:'PENDING',vehicleType:null,vehicleNo:null,homeStoreId:null,homeStore:null,requiredDocuments:[],documents:[]} as Application;
beforeEach(() => {
  jest.clearAllMocks();
  Object.values(riderApi).forEach(value => { if (jest.isMockFunction(value)) value.mockReset(); });
});

test('store picker fetches on open, stops loading after an empty response and retries failures', async () => {
  const retry = deferred<Awaited<ReturnType<typeof riderApi.onboardingStores>>>();
  jest.mocked(riderApi.onboardingStores).mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(retry.promise);
  await render(<ApplicationScreen application={application} signOut={async () => {}} />);
  // Lazy: no fetch until the picker opens; main scroll never holds the rows.
  expect(jest.mocked(riderApi.onboardingStores)).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByText('Choose store'));
  await act(async () => {});
  expect(await screen.findByText('Could not load stores. Please try again.')).toBeTruthy();
  await fireEvent.press(screen.getByText('Try again'));
  expect(screen.getByLabelText('Loading stores')).toBeTruthy();
  await act(async () => {retry.resolve([]);});
  expect(await screen.findByText('No stores are available right now.')).toBeTruthy();
  expect(screen.queryByLabelText('Loading stores')).toBeNull();
});

test('delivery sections resolve independently while other requests are pending', async () => {
  const status = deferred<RiderStatus>();
  const offers = deferred<Awaited<ReturnType<typeof riderApi.offers>>>();
  jest.mocked(riderApi.status).mockReturnValue(status.promise);
  jest.mocked(riderApi.offers).mockReturnValue(offers.promise);
  jest.mocked(riderApi.activeTasks).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(riderApi.history).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(riderApi.dashboard).mockResolvedValue({todayDeliveries:0,todayEarningsPaise:'0'});
  jest.mocked(riderApi.earnings).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(riderApi.cash).mockResolvedValue({cashInHandPaise:'0',limitPaise:null});
  jest.mocked(riderApi.notifications).mockResolvedValue({items:[],nextCursor:null});
  await render(<LivePartner identity={{subject:'rider',name:'Rider',email:'rider@example.invalid'}} application={{...application,status:'APPROVED'}} onSignOut={async () => {}} onAuthorizationChange={async () => {}} />);
  expect(screen.getByLabelText('Loading offers')).toBeTruthy();
  expect(await screen.findByText('No active deliveries.')).toBeTruthy();
  expect(screen.queryByText('No new offers right now.')).toBeNull();
  await act(async () => {offers.resolve({items:[]});status.resolve({status:{online:false,onBreak:false}} as RiderStatus);});
  expect(await screen.findByText('No new offers right now.')).toBeTruthy();
  expect(screen.queryByLabelText('Loading offers')).toBeNull();
});

test('a failed offers request shows a retry instead of an empty result', async () => {
  const retry = deferred<Awaited<ReturnType<typeof riderApi.offers>>>();
  jest.mocked(riderApi.status).mockResolvedValue({status:{online:false,onBreak:false}} as RiderStatus);
  jest.mocked(riderApi.offers).mockRejectedValueOnce(new Error('offline')).mockReturnValueOnce(retry.promise);
  jest.mocked(riderApi.activeTasks).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(riderApi.history).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(riderApi.dashboard).mockResolvedValue({todayDeliveries:0,todayEarningsPaise:'0'});
  jest.mocked(riderApi.earnings).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(riderApi.cash).mockResolvedValue({cashInHandPaise:'0',limitPaise:null});
  jest.mocked(riderApi.notifications).mockResolvedValue({items:[],nextCursor:null});
  await render(<LivePartner identity={{subject:'rider',name:'Rider',email:'rider@example.invalid'}} application={{...application,status:'APPROVED'}} onSignOut={async () => {}} onAuthorizationChange={async () => {}} />);
  expect(await screen.findByText('Could not load offers.')).toBeTruthy();
  expect(screen.queryByText('No new offers right now.')).toBeNull();
  await fireEvent.press(screen.getByText('Try again'));
  expect(screen.getByLabelText('Loading offers')).toBeTruthy();
  await act(async () => {retry.resolve({items:[]});});
  expect(await screen.findByText('No new offers right now.')).toBeTruthy();
});
