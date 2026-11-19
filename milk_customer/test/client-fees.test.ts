/// <reference types="jest" />
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { customerApi, customerDetailsApi, type QuoteResult } from '../src/api/customer';
import { useCustomer } from '../src/store/customer';
import { clearFeesCache, setCachedDeliverySettings } from '../src/store/fees-cache';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-crypto', () => ({randomUUID: jest.fn(() => 'checkout-key'), CryptoDigestAlgorithm:{SHA256:'SHA256'}, digestStringAsync:jest.fn(async (_algorithm:string, value:string) => `hash:${value}`)}));
jest.mock('../src/auth/session', () => ({accessToken: jest.fn(async () => 'token'), restoreSession: jest.fn(async () => true), signOut: jest.fn(async () => {})}));
jest.mock('../src/api/customer', () => ({
  customerApi: {profile:jest.fn(), addresses:jest.fn(), cart:jest.fn(), catalog:jest.fn(), favorites:jest.fn(), setFavorite:jest.fn(), putItem:jest.fn(), quote:jest.fn(), place:jest.fn(), serviceability:jest.fn(), deliverySettings:jest.fn(), createAddress:jest.fn(), createPendingAddress:jest.fn(), confirmAddressLocation:jest.fn(), selectDefaultAddress:jest.fn()},
  customerDetailsApi: {orders:jest.fn(), subscriptions:jest.fn(), ledger:jest.fn(), notifications:jest.fn(), createSubscription:jest.fn(), subscriptionAction:jest.fn()},
}));
jest.mock('../src/utils/location-policy', () => ({requireLocationServices: jest.fn(async () => {})}));
const api = jest.mocked(customerApi);
void customerDetailsApi;
const profile = {userId:'user-1', name:'Customer', email:'test@example.invalid', locale:null};
const cart = {cartId:'cart', userId:'user-1', storeId:'store', addressId:'address', version:2, couponCode:null, lines:[{variantId:'variant',productId:'product',productName:'Milk',variantName:'500 ml',image:null, quantity:'1', unitPricePaise:'1000',currentUnitPricePaise:'1000', mrpPaise:'1000', lineSubtotalPaise:'1000'}], issues:[]};
const quote: QuoteResult = {quote:{quoteId:'quote',status:'ACTIVE',referralClaimId:null,lines:[{variantId:'variant',unitPricePaise:'1000'}],subtotalPaise:'1000',discountPaise:'0',couponDiscountPaise:'0',feeTotalPaise:'0',taxTotalPaise:'0',tipPaise:'0',totalPaise:'1000',amountDuePaise:'1000',expiresAt:'2099-01-01T00:00:00Z',issues:[],fees:[],wallet:null},intentId:'intent',intentExpiresAt:'2099-01-01T00:00:00Z',codAvailable:true};
const feeSettings = {locationRequired:false, feeEstimate:{revision:'3', bands:[{upToSubtotalPaise:'50000',deliveryPaise:'1000',handlingPaise:'200',smallCartPaise:'0',surgePaise:'0'},{upToSubtotalPaise:null,deliveryPaise:'0',handlingPaise:'200',smallCartPaise:'0',surgePaise:'0'}]}};

beforeEach(async () => {
  await useCustomer.getState().logout(); await AsyncStorage.clear(); jest.clearAllMocks(); clearFeesCache();
  jest.mocked(Crypto.randomUUID).mockReset(); jest.mocked(Crypto.randomUUID).mockReturnValue('checkout-key');
  api.profile.mockResolvedValue(profile); api.addresses.mockResolvedValue([]); api.cart.mockResolvedValue(cart); api.catalog.mockResolvedValue({items:[],nextCursor:null});
  api.deliverySettings.mockResolvedValue({locationRequired:false});
  api.serviceability.mockResolvedValue({serviceable:true,storeId:'store',zone:{zoneId:'zone',zoneVersion:'1',cityZoneVersion:'1',storeId:'store'},etaRange:null,reasons:[]});
  api.favorites.mockResolvedValue({items:[],nextCursor:null});
  useCustomer.setState({status:'signedIn', profile, addresses:[], selectedAddress:'address', locationRequired:false, cart, quote:null, pendingPlacement:null, pendingSubscription:null, pendingSubscriptionAction:null, feeEstimate:null, feeLoading:false, feeError:null, reviewSlow:false, error:null, busy:false, checkoutError:null});
});

test('applies a fresh cached estimate without a network round trip', async () => {
  setCachedDeliverySettings('user-1', feeSettings);
  expect(await useCustomer.getState().refreshDeliverySettings()).toBe(false);
  expect(api.deliverySettings).not.toHaveBeenCalled();
  expect(useCustomer.getState().feeEstimate?.revision).toBe('3');
  expect(useCustomer.getState().feeLoading).toBe(false);
});

test('keeps the last estimate when a refresh fails', async () => {
  setCachedDeliverySettings('user-1', feeSettings, Date.now() - 61_000);
  useCustomer.setState({feeEstimate: feeSettings.feeEstimate});
  api.deliverySettings.mockRejectedValueOnce(new Error('offline'));
  expect(await useCustomer.getState().refreshDeliverySettings()).toBe(false);
  expect(useCustomer.getState().feeEstimate?.revision).toBe('3');
  expect(useCustomer.getState().feeError).toMatch(/Retry/);
  expect(useCustomer.getState().feeLoading).toBe(false);
});

test('reports a fee-scoped error when there is no estimate to keep', async () => {
  api.deliverySettings.mockRejectedValueOnce(new Error('offline'));
  await expect(useCustomer.getState().refreshDeliverySettings()).rejects.toThrow('offline');
  expect(useCustomer.getState().feeEstimate).toBeNull();
  expect(useCustomer.getState().feeError).toMatch(/Retry/);
  expect(useCustomer.getState().error).toBeNull();
});

test('shares one in-progress review between concurrent callers', async () => {
  let finish!: (value: typeof quote) => void;
  api.quote.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const first = useCustomer.getState().createQuote();
  const second = useCustomer.getState().createQuote();
  for (let n = 0; n < 50 && api.quote.mock.calls.length < 1; n++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(api.quote).toHaveBeenCalledTimes(1);
  finish(quote);
  await Promise.all([first, second]);
  expect(api.quote).toHaveBeenCalledTimes(1);
  expect(useCustomer.getState().quote?.quote.quoteId).toBe('quote');
});

test('shows inline feedback only when review passes 300ms', async () => {
  let finish!: (value: typeof quote) => void;
  api.quote.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = useCustomer.getState().createQuote();
  for (let n = 0; n < 50 && api.quote.mock.calls.length < 1; n++) await new Promise(resolve => setTimeout(resolve, 0));
  expect(useCustomer.getState().reviewSlow).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(useCustomer.getState().checkoutPhase).toBe('reviewing');
  expect(useCustomer.getState().reviewSlow).toBe(true);
  finish(quote);
  await pending;
  expect(useCustomer.getState().reviewSlow).toBe(false);
  expect(useCustomer.getState().checkoutPhase).toBe('idle');
});

test('consumes the additive quote cart without a follow-up GET', async () => {
  const refreshed = {...cart, version: 3};
  api.quote.mockResolvedValueOnce({...quote, cart: refreshed});
  await useCustomer.getState().createQuote();
  expect(api.cart).not.toHaveBeenCalled();
  expect(useCustomer.getState().cart?.version).toBe(3);
  expect(useCustomer.getState().quote?.quote.quoteId).toBe('quote');
});

test('falls back to GET /cart when the quote carries no cart', async () => {
  const refreshed = {...cart, version: 4};
  api.quote.mockResolvedValueOnce(quote);
  api.cart.mockResolvedValueOnce(refreshed);
  await useCustomer.getState().createQuote();
  expect(api.cart).toHaveBeenCalledTimes(1);
  expect(useCustomer.getState().cart?.version).toBe(4);
});

test('discards a review when the address changed mid-flight', async () => {
  let finish!: (value: typeof quote) => void;
  api.quote.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = useCustomer.getState().createQuote();
  for (let n = 0; n < 50 && api.quote.mock.calls.length < 1; n++) await new Promise(resolve => setTimeout(resolve, 0));
  useCustomer.setState({selectedAddress: 'another-address'});
  finish({...quote, cart});
  await pending;
  expect(useCustomer.getState().quote).toBeNull();
  expect(useCustomer.getState().checkoutError).toMatch(/cart changed/);
});
