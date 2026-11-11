/// <reference types="jest" />
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ApiError } from '../src/api/client';
import { customerApi, customerDetailsApi } from '../src/api/customer';
import { useCustomer } from '../src/store/customer';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-crypto', () => ({randomUUID: jest.fn(() => 'checkout-key')}));
jest.mock('../src/auth/session', () => ({accessToken: jest.fn(async () => 'token'), restoreSession: jest.fn(async () => true), signOut: jest.fn(async () => {})}));
jest.mock('../src/api/customer', () => ({
  customerApi: {profile:jest.fn(), addresses:jest.fn(), cart:jest.fn(), catalog:jest.fn(), favorites:jest.fn(), setFavorite:jest.fn(), putItem:jest.fn(), quote:jest.fn(), place:jest.fn()},
  customerDetailsApi: {orders:jest.fn(), subscriptions:jest.fn(), ledger:jest.fn(), notifications:jest.fn(), createSubscription:jest.fn(), subscriptionAction:jest.fn()},
}));
const api = jest.mocked(customerApi);
const profile = {userId:'user-1', name:'Customer', email:'test@example.invalid', locale:null};
const cart = {cartId:'cart', userId:'user-1', storeId:'store', addressId:'address', version:2, couponCode:null, lines:[{variantId:'variant', quantity:'1', unitPricePaise:'1000', mrpPaise:'1000', lineSubtotalPaise:'1000'}], issues:[]};
const quote = {quote:{quoteId:'quote',status:'ACTIVE',referralClaimId:null,lines:[{variantId:'variant',unitPricePaise:'1000'}],subtotalPaise:'1000',discountPaise:'0',couponDiscountPaise:'0',feeTotalPaise:'0',taxTotalPaise:'0',tipPaise:'0',totalPaise:'1000',amountDuePaise:'1000',expiresAt:'2099-01-01T00:00:00Z',issues:[],fees:[],wallet:null},intentId:'intent',intentExpiresAt:'2099-01-01T00:00:00Z',codAvailable:true};
beforeEach(async () => {
  await useCustomer.getState().logout(); await AsyncStorage.clear(); jest.clearAllMocks();
  api.profile.mockResolvedValue(profile); api.addresses.mockResolvedValue([]); api.cart.mockResolvedValue(cart); api.catalog.mockResolvedValue({items:[],nextCursor:null});
  api.favorites.mockResolvedValue({items:[],nextCursor:null});
  useCustomer.setState({status:'signedIn', profile, selectedAddress:'address', cart, quote, pendingPlacement:null, pendingSubscription:null, pendingSubscriptionAction:null, error:null, busy:false});
});
test('persists and reuses the same checkout request after an ambiguous failure', async () => {
  api.place.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce({order:{orderId:'order',status:'CONFIRMED',paymentStatus:'COD_PENDING'},confirmation:'CONFIRMED',payment:null});
  expect(await useCustomer.getState().placeOrder()).toBe(false);
  const saved = await AsyncStorage.getItem('@dairydirect/pending-checkout-v1:user-1');
  expect(saved).toBeTruthy();
  const first = api.place.mock.calls[0];
  await useCustomer.getState().load();
  expect(useCustomer.getState().pendingPlacement?.key).toBe('checkout-key');
  expect(await useCustomer.getState().placeOrder()).toBe(true);
  expect(api.place.mock.calls[1]).toEqual(first);
  expect(await AsyncStorage.getItem('@dairydirect/pending-checkout-v1:user-1')).toBeNull();
});
test('fails closed if the saved checkout is damaged', async () => {
  await AsyncStorage.setItem('@dairydirect/pending-checkout-v1:user-1', '{broken');
  await useCustomer.getState().load();
  expect(useCustomer.getState().status).toBe('unavailable');
  expect(useCustomer.getState().error).toMatch(/pending checkout/);
  expect(api.place).not.toHaveBeenCalled();
});
test('an expired quote can be replaced after the server definitively rejects it', async () => {
  api.place.mockRejectedValue(new ApiError(409, 'QUOTE_EXPIRED'));
  expect(await useCustomer.getState().placeOrder()).toBe(false);
  expect(useCustomer.getState().pendingPlacement).toBeNull();
  expect(await AsyncStorage.getItem('@dairydirect/pending-checkout-v1:user-1')).toBeNull();
});
test('a wallet balance change releases the rejected checkout for a fresh quote', async () => {
  api.place.mockRejectedValue(new ApiError(409, 'WALLET_INSUFFICIENT'));
  expect(await useCustomer.getState().placeOrder()).toBe(false);
  expect(useCustomer.getState().pendingPlacement).toBeNull();
  expect(useCustomer.getState().error).toMatch(/wallet availability changed/);
});
test('blocks editing a cart for a different address until it is reviewed', async () => {
  useCustomer.setState({selectedAddress:'another-address'});
  await useCustomer.getState().updateCart('variant', 1);
  expect(api.putItem).not.toHaveBeenCalled();
  expect(useCustomer.getState().error).toMatch(/new delivery address/);
});
test('blocks cart edits while an order outcome is uncertain', async () => {
  useCustomer.setState({pendingPlacement:{userId:'user-1',key:'same-key',body:{quoteId:'quote',intentId:'intent',method:'COD'}}});
  await useCustomer.getState().updateCart('variant', 1);
  expect(api.putItem).not.toHaveBeenCalled();
});
test('recovers a subscription creation with the original idempotency key', async () => {
  const create = jest.mocked(customerDetailsApi.createSubscription);
  create.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce({id:'subscription', nextDeliveryDate:'2099-01-02', effectiveFrom:'2099-01-01'});
  const body = {variantId:'variant',quantity:'1',frequencyRule:{type:'DAILY' as const},startDate:'2099-01-01',slotId:'slot',addressId:'address'};
  expect(await useCustomer.getState().createSubscription(body)).toBe(false);
  const first = create.mock.calls[0];
  await useCustomer.getState().load();
  expect(useCustomer.getState().pendingSubscription?.key).toBe('checkout-key');
  expect(await useCustomer.getState().createSubscription()).toBe(true);
  expect(create.mock.calls[1]).toEqual(first);
  expect(await AsyncStorage.getItem('@dairydirect/pending-subscription-v1:user-1')).toBeNull();
});
test('recovers a pending subscription change with the original request after restart', async () => {
  const change = jest.mocked(customerDetailsApi.subscriptionAction);
  change.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce({});
  expect(await useCustomer.getState().runSubscriptionAction({id:'subscription',action:'pause',body:{from:'2099-01-01',to:'2099-01-04'}})).toBe(false);
  const first = change.mock.calls[0];
  await useCustomer.getState().load();
  expect(useCustomer.getState().pendingSubscriptionAction?.key).toBe('checkout-key');
  expect(await useCustomer.getState().runSubscriptionAction()).toBe(true);
  expect(change.mock.calls[1]).toEqual(first);
  expect(await AsyncStorage.getItem('@dairydirect/pending-subscription-action-v1:user-1')).toBeNull();
});
test('a double tap cannot reverse an in-flight favorite update', async () => {
  let finish: (() => void) | undefined;
  api.setFavorite.mockImplementation(() => new Promise<void>(resolve => {finish = resolve;}));
  useCustomer.setState({favorites:[],favoritesLoaded:true,favoriteBusy:[]});
  const first = useCustomer.getState().toggleFavorite('product');
  await useCustomer.getState().toggleFavorite('product');
  await Promise.resolve();
  expect(api.setFavorite).toHaveBeenCalledTimes(1);
  finish?.(); await first;
  expect(useCustomer.getState().favorites).toEqual(['product']);
});
test('does not submit checkout when the backend reports cash is unavailable', async () => {
  useCustomer.setState({quote:{...quote,codAvailable:false}});
  expect(await useCustomer.getState().placeOrder()).toBe(false);
  expect(api.place).not.toHaveBeenCalled();
  expect(useCustomer.getState().error).toMatch(/not available/);
});
