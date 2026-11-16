/// <reference types="jest" />
import { customerApi, customerDetailsApi } from '../src/api/customer';
import { useCustomer } from '../src/store/customer';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('../src/auth/session', () => ({ accessToken: jest.fn(async () => 'token'), restoreSession: jest.fn(), signOut: jest.fn() }));
jest.mock('../src/notifications/push', () => ({ unregisterPushBeforeSignOut: jest.fn() }));
jest.mock('../src/api/customer', () => ({
  customerApi: { catalog: jest.fn(), wallet: jest.fn() },
  customerDetailsApi: { orders: jest.fn(), subscriptions: jest.fn(), ledger: jest.fn(), notifications: jest.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  jest.clearAllMocks();
  useCustomer.setState({ selectedAddress:'first', products:[], cursor:null, error:null,
    catalogLoad:{addressId:null,state:'idle'}, activityLoad:{orders:'idle',subscriptions:'idle'},
    accountLoad:{wallet:'idle',ledger:'idle',notifications:'idle'}, orders:[], subscriptions:[], notifications:[], wallet:null, ledger:[] });
});

test('catalog loading resolves to empty or error, and a retry can succeed', async () => {
  const pending = deferred<Awaited<ReturnType<typeof customerApi.catalog>>>();
  jest.mocked(customerApi.catalog).mockReturnValueOnce(pending.promise).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({items:[],nextCursor:null});
  const first = useCustomer.getState().loadCatalog();
  expect(useCustomer.getState().catalogLoad).toEqual({addressId:'first',state:'loading'});
  pending.resolve({items:[],nextCursor:null}); await first;
  expect(useCustomer.getState().catalogLoad.state).toBe('success');

  useCustomer.setState({selectedAddress:'second'});
  await useCustomer.getState().loadCatalog();
  expect(useCustomer.getState().catalogLoad).toEqual({addressId:'second',state:'error'});
  await useCustomer.getState().loadCatalog();
  expect(useCustomer.getState().catalogLoad).toEqual({addressId:'second',state:'success'});
});

test('a late catalog response cannot replace the selected address', async () => {
  const first = deferred<Awaited<ReturnType<typeof customerApi.catalog>>>();
  const second = deferred<Awaited<ReturnType<typeof customerApi.catalog>>>();
  jest.mocked(customerApi.catalog).mockImplementation((_token, addressId) => addressId === 'first' ? first.promise : second.promise);
  const oldRequest = useCustomer.getState().loadCatalog(); await flush();
  useCustomer.setState({selectedAddress:'second',products:[],cursor:null});
  const newRequest = useCustomer.getState().loadCatalog(); await flush();
  second.resolve({items:[],nextCursor:'second-page'}); await newRequest;
  first.resolve({items:[],nextCursor:'wrong-page'}); await oldRequest;
  expect(useCustomer.getState().catalogLoad).toEqual({addressId:'second',state:'success'});
  expect(useCustomer.getState().cursor).toBe('second-page');
});

test('orders and subscriptions settle independently when one request fails', async () => {
  const subscriptions = deferred<Awaited<ReturnType<typeof customerDetailsApi.subscriptions>>>();
  jest.mocked(customerDetailsApi.orders).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(customerDetailsApi.subscriptions).mockReturnValue(subscriptions.promise);
  const work = useCustomer.getState().loadActivity();
  expect(useCustomer.getState().activityLoad).toEqual({orders:'loading',subscriptions:'loading'});
  await flush();
  expect(useCustomer.getState().activityLoad).toEqual({orders:'success',subscriptions:'loading'});
  subscriptions.reject(new Error('offline')); await work;
  expect(useCustomer.getState().activityLoad).toEqual({orders:'success',subscriptions:'error'});
});

test('a failed background refresh keeps previously loaded notifications', async () => {
  jest.mocked(customerApi.wallet).mockRejectedValue(new Error('offline'));
  jest.mocked(customerDetailsApi.ledger).mockResolvedValue({items:[],nextCursor:null});
  jest.mocked(customerDetailsApi.notifications).mockRejectedValue(new Error('offline'));
  useCustomer.setState({accountLoad:{wallet:'idle',ledger:'idle',notifications:'success'}});
  await useCustomer.getState().loadAccount();
  expect(useCustomer.getState().accountLoad).toEqual({wallet:'error',ledger:'success',notifications:'success'});
});
