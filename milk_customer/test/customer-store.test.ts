/// <reference types="jest" />
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { ApiError } from '../src/api/client';
import { customerApi, customerDetailsApi } from '../src/api/customer';
import { appendCartOperation } from '../src/store/cart-sync';
import { useCustomer } from '../src/store/customer';

jest.mock('@react-native-async-storage/async-storage', () => require('@react-native-async-storage/async-storage/jest/async-storage-mock'));
jest.mock('expo-crypto', () => ({randomUUID: jest.fn(() => 'checkout-key'), CryptoDigestAlgorithm:{SHA256:'SHA256'}, digestStringAsync:jest.fn(async (_algorithm:string, value:string) => `hash:${value}`)}));
jest.mock('../src/auth/session', () => ({accessToken: jest.fn(async () => 'token'), restoreSession: jest.fn(async () => true), signOut: jest.fn(async () => {})}));
jest.mock('../src/api/customer', () => ({
  customerApi: {profile:jest.fn(), addresses:jest.fn(), cart:jest.fn(), catalog:jest.fn(), favorites:jest.fn(), setFavorite:jest.fn(), putItem:jest.fn(), quote:jest.fn(), place:jest.fn(), serviceability:jest.fn(), deliverySettings:jest.fn(), createAddress:jest.fn(), createPendingAddress:jest.fn(), confirmAddressLocation:jest.fn(), selectDefaultAddress:jest.fn()},
  customerDetailsApi: {orders:jest.fn(), subscriptions:jest.fn(), ledger:jest.fn(), notifications:jest.fn(), createSubscription:jest.fn(), subscriptionAction:jest.fn()},
}));
const api = jest.mocked(customerApi);
const profile = {userId:'user-1', name:'Customer', email:'test@example.invalid', locale:null};
const cart = {cartId:'cart', userId:'user-1', storeId:'store', addressId:'address', version:2, couponCode:null, lines:[{variantId:'variant',productId:'product',productName:'Milk',variantName:'500 ml',image:null, quantity:'1', unitPricePaise:'1000',currentUnitPricePaise:'1000', mrpPaise:'1000', lineSubtotalPaise:'1000'}], issues:[]};
const quote = {quote:{quoteId:'quote',status:'ACTIVE',referralClaimId:null,lines:[{variantId:'variant',unitPricePaise:'1000'}],subtotalPaise:'1000',discountPaise:'0',couponDiscountPaise:'0',feeTotalPaise:'0',taxTotalPaise:'0',tipPaise:'0',totalPaise:'1000',amountDuePaise:'1000',expiresAt:'2099-01-01T00:00:00Z',issues:[],fees:[],wallet:null},intentId:'intent',intentExpiresAt:'2099-01-01T00:00:00Z',codAvailable:true};
beforeEach(async () => {
  await useCustomer.getState().logout(); await AsyncStorage.clear(); jest.clearAllMocks();
  jest.mocked(Crypto.randomUUID).mockReset(); jest.mocked(Crypto.randomUUID).mockReturnValue('checkout-key');
  api.profile.mockResolvedValue(profile); api.addresses.mockResolvedValue([]); api.cart.mockResolvedValue(cart); api.catalog.mockResolvedValue({items:[],nextCursor:null});
  api.deliverySettings.mockResolvedValue({locationRequired:false});
  api.serviceability.mockResolvedValue({serviceable:true,storeId:'store',zone:{zoneId:'zone',zoneVersion:'1',cityZoneVersion:'1',storeId:'store'},etaRange:null,reasons:[]});
  api.favorites.mockResolvedValue({items:[],nextCursor:null});
  useCustomer.setState({status:'signedIn', profile, selectedAddress:'address', locationRequired:false, cart, quote, pendingPlacement:null, pendingSubscription:null, pendingSubscriptionAction:null, error:null, busy:false});
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
test('keeps the original checkout request when its idempotency lease is lost', async () => {
  api.place.mockRejectedValueOnce(new ApiError(409, 'IDEMPOTENCY_LEASE_LOST')).mockResolvedValueOnce({order:{orderId:'order',status:'CONFIRMED',paymentStatus:'COD_PENDING'},confirmation:'CONFIRMED',payment:null});
  expect(await useCustomer.getState().placeOrder()).toBe(false);
  expect(useCustomer.getState().pendingPlacement?.key).toBe('checkout-key');
  expect(await AsyncStorage.getItem('@dairydirect/pending-checkout-v1:user-1')).toBeTruthy();
  const first = api.place.mock.calls[0];
  expect(await useCustomer.getState().placeOrder()).toBe(true);
  expect(api.place.mock.calls[1]).toEqual(first);
});
test('a definitive checkout failure shows once beside checkout, not in the banner too', async () => {
  api.place.mockRejectedValue(new ApiError(409, 'PRICE_CHANGED'));
  expect(await useCustomer.getState().placeOrder()).toBe(false);
  expect(useCustomer.getState().checkoutError).toBe('Price changed. Review your cart.');
  expect(useCustomer.getState().error).toBeNull();
});

test('a wallet balance change releases the rejected checkout for a fresh quote', async () => {
  api.place.mockRejectedValue(new ApiError(409, 'WALLET_INSUFFICIENT'));
  expect(await useCustomer.getState().placeOrder()).toBe(false);
  expect(useCustomer.getState().pendingPlacement).toBeNull();
  expect(useCustomer.getState().checkoutError).toMatch(/wallet availability changed/);
});
test('allows editing a cart even when the selected address has changed', async () => {
  await useCustomer.getState().load();
  useCustomer.setState({selectedAddress:'another-address'});
  api.putItem.mockResolvedValueOnce({cart:{...cart,version:3,lines:[{...cart.lines[0],quantity:'2',lineSubtotalPaise:'2000'}]},clamped:false});
  await useCustomer.getState().updateCart('variant', 1);
  expect(api.putItem).toHaveBeenCalledWith('token','variant',{quantity:'2',version:2},'checkout-key');
  expect(useCustomer.getState().cart?.lines[0].quantity).toBe('2');
});
test('asks for the new price to be accepted before adding more of an existing item', async () => {
  await useCustomer.getState().load();
  const item={variantId:'variant',productId:'product',name:'Milk',variantName:'500 ml',sellingPaise:'1100',mrpPaise:'1100',images:[]};
  await useCustomer.getState().updateCart('variant',1,item);
  expect(api.putItem).not.toHaveBeenCalled();
  expect(useCustomer.getState().cart?.lines[0].quantity).toBe('1');
  expect(useCustomer.getState().error).toMatch(/accept the new price/);
});
test('updates the quantity immediately while the server request is still pending', async () => {
  await useCustomer.getState().load();
  let finish!: (value:{cart:typeof cart;clamped:boolean}) => void;
  api.putItem.mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
  const pending=useCustomer.getState().updateCart('variant',1);
  expect(useCustomer.getState().cart?.lines[0].quantity).toBe('2');
  for (let n=0;n<30 && !finish;n++) await new Promise(resolve => setTimeout(resolve,0));
  expect(finish).toBeDefined();
  finish({cart:{...cart,version:3,lines:[{...cart.lines[0],quantity:'2',lineSubtotalPaise:'2000'}]},clamped:false});
  await pending;
  expect(useCustomer.getState().cartBusy).toBe(false);
  expect(useCustomer.getState().cart?.lines[0].quantity).toBe('2');
});
test('rapid taps stay visible and are serialized with the current server version', async () => {
  const now = jest.spyOn(Date,'now').mockReturnValue(1000);
  try {
  await useCustomer.getState().load();
  let finish!: (value:{cart:typeof cart;clamped:boolean}) => void;
  const third={...cart,version:3,lines:[{...cart.lines[0],quantity:'3',lineSubtotalPaise:'3000'}]};
  jest.mocked(Crypto.randomUUID).mockReturnValueOnce('first-tap');
  api.putItem.mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
  const first=useCustomer.getState().updateCart('variant',1);
  const next=useCustomer.getState().updateCart('variant',1);
  expect(useCustomer.getState().cart?.lines[0].quantity).toBe('3');
  for (let n=0;n<30 && !finish;n++) await new Promise(resolve => setTimeout(resolve,0));
  // Plan2: compatible unsent taps coalesce into one write.
  expect(api.putItem.mock.calls[0]).toEqual(['token','variant',{quantity:'3',version:2},'first-tap']);
  finish({cart:third,clamped:false});
  await Promise.all([first,next]);
  expect(api.putItem).toHaveBeenCalledTimes(1);
  expect(useCustomer.getState().cart?.lines[0].quantity).toBe('3');
  } finally {now.mockRestore();}
});
test('keeps a cart change available to retry if saving the queue fails', async () => {
  await useCustomer.getState().load();
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('storage unavailable'));
  await useCustomer.getState().updateCart('variant',1);
  expect(useCustomer.getState().cart?.lines[0].quantity).toBe('2');
  expect(useCustomer.getState().cartSyncFailed).toBe(true);
  expect(api.putItem).not.toHaveBeenCalled();
  api.putItem.mockResolvedValueOnce({cart:{...cart,version:3,lines:[{...cart.lines[0],quantity:'2',lineSubtotalPaise:'2000'}]},clamped:false});
  await useCustomer.getState().retryCart();
  expect(useCustomer.getState().cartSyncFailed).toBe(false);
  expect(useCustomer.getState().cart?.lines[0].quantity).toBe('2');
});
test('retries an interrupted cart request with the exact same key and body after restart', async () => {
  await useCustomer.getState().load();
  api.putItem.mockRejectedValueOnce(new TypeError('connection lost'));
  await useCustomer.getState().updateCart('variant',1);
  expect(useCustomer.getState().cartSyncFailed).toBe(true);
  const original=api.putItem.mock.calls[0];
  await useCustomer.getState().logout();
  const committed={...cart,version:3,lines:[{...cart.lines[0],quantity:'2',lineSubtotalPaise:'2000'}]};
  api.cart.mockResolvedValue(committed);
  let finishReplay!: (value:{cart:typeof cart;clamped:boolean}) => void;
  api.putItem.mockImplementationOnce(() => new Promise(resolve => {finishReplay=resolve;}));
  await useCustomer.getState().initialize();
  for (let n=0;n<30 && api.putItem.mock.calls.length<2;n++) await new Promise(resolve => setTimeout(resolve,0));
  expect(api.putItem.mock.calls[1]).toEqual(original);
  expect(useCustomer.getState().cart?.lines[0].quantity).toBe('2');
  finishReplay({cart:committed,clamped:false});
  for (let n=0;n<30 && useCustomer.getState().cartBusy;n++) await new Promise(resolve => setTimeout(resolve,0));
  expect(useCustomer.getState().cart?.lines[0].quantity).toBe('2');
  expect(useCustomer.getState().cartBusy).toBe(false);
});
test('keeps a replay pending if the follow-up cart refresh fails', async () => {
  await useCustomer.getState().load();
  const committed={...cart,version:3,lines:[{...cart.lines[0],quantity:'2',lineSubtotalPaise:'2000'}]};
  api.putItem.mockRejectedValueOnce(new TypeError('connection lost'))
    .mockResolvedValueOnce({cart:committed,clamped:false})
    .mockResolvedValueOnce({cart:committed,clamped:false});
  await useCustomer.getState().updateCart('variant',1);
  api.cart.mockRejectedValueOnce(new ApiError(401,'UNAUTHORIZED')).mockResolvedValueOnce(committed);
  await useCustomer.getState().retryCart();
  expect(useCustomer.getState().cartSyncFailed).toBe(true);
  expect(useCustomer.getState().cartBusy).toBe(true);
  await useCustomer.getState().retryCart();
  expect(api.putItem.mock.calls[2]).toEqual(api.putItem.mock.calls[0]);
  expect(useCustomer.getState().cartBusy).toBe(false);
  expect(useCustomer.getState().cart?.lines[0].quantity).toBe('2');
});
test('rebases a tap on the latest cart after a concurrent change', async () => {
  await useCustomer.getState().load();
  jest.mocked(Crypto.randomUUID).mockReturnValueOnce('operation-1').mockReturnValueOnce('operation-2');
  const changed={...cart,version:3,lines:[{...cart.lines[0],quantity:'4',lineSubtotalPaise:'4000'}]};
  api.cart.mockResolvedValueOnce(changed);
  api.putItem.mockRejectedValueOnce(new ApiError(409,'CONCURRENT_MODIFICATION')).mockResolvedValueOnce({cart:{...changed,version:4,lines:[{...changed.lines[0],quantity:'5',lineSubtotalPaise:'5000'}]},clamped:false});
  await useCustomer.getState().updateCart('variant',1);
  expect(api.putItem.mock.calls[1]).toEqual(['token','variant',{quantity:'5',version:3},'operation-2']);
  expect(useCustomer.getState().cart?.lines[0].quantity).toBe('5');
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
test('fills the heart immediately and merges rapid taps into the latest intent', async () => {
  const finishes: (() => void)[] = [];
  api.setFavorite.mockImplementation(() => new Promise<void>(resolve => {finishes.push(resolve);}));
  useCustomer.setState({favorites:[],favoritesLoaded:true,favoriteBusy:[]});
  await useCustomer.getState().toggleFavorite('product');
  expect(useCustomer.getState().favorites).toEqual(['product']);
  for (let n=0;n<50 && api.setFavorite.mock.calls.length<1;n++) await new Promise(resolve => setTimeout(resolve,0));
  expect(api.setFavorite).toHaveBeenCalledTimes(1);
  expect(api.setFavorite.mock.calls[0]).toEqual(['token','product',true]);
  await useCustomer.getState().toggleFavorite('product');
  expect(useCustomer.getState().favorites).toEqual([]);
  finishes[0]();
  for (let n=0;n<50 && api.setFavorite.mock.calls.length<2;n++) await new Promise(resolve => setTimeout(resolve,0));
  expect(api.setFavorite).toHaveBeenCalledTimes(2);
  expect(api.setFavorite.mock.calls[1]).toEqual(['token','product',false]);
  finishes[1]();
  for (let n=0;n<50 && useCustomer.getState().favoriteBusy.length;n++) await new Promise(resolve => setTimeout(resolve,0));
  expect(useCustomer.getState().favorites).toEqual([]);
  expect(useCustomer.getState().favoriteError).toBeNull();
});
test('quantity taps combine only inside the 100ms window', () => {
  const base = {id:'first',variantId:'variant',delta:1,createdAt:1000};
  const merged = appendCartOperation(null,[base],'user-1',{id:'second',variantId:'variant',delta:1,createdAt:1100});
  expect(merged).toHaveLength(1);
  expect(merged[0]).toMatchObject({id:'first',delta:2});
  const separate = appendCartOperation(null,[base],'user-1',{id:'third',variantId:'variant',delta:1,createdAt:1101});
  expect(separate).toHaveLength(2);
});
test('gates cart mutations until the persisted cart is restored', async () => {
  useCustomer.setState({cartReady:false});
  await useCustomer.getState().updateCart('variant', 1);
  expect(api.putItem).not.toHaveBeenCalled();
  expect(useCustomer.getState().error).toMatch(/Restoring your cart/);
});
test('opens the shell while addresses and cart settle independently', async () => {
  let rejectAddresses!: (error: Error) => void;
  let resolveCart!: (value: typeof cart) => void;
  api.addresses.mockReturnValueOnce(new Promise<never[]>((_resolve,reject) => {rejectAddresses=reject;}));
  api.cart.mockReturnValueOnce(new Promise<typeof cart>(resolve => {resolveCart=resolve;}));
  useCustomer.setState({status:'loading'});
  const work = useCustomer.getState().load();
  for (let n=0;n<50 && useCustomer.getState().status!=='signedIn';n++) await new Promise(resolve => setTimeout(resolve,0));
  expect(useCustomer.getState().status).toBe('signedIn');
  expect(useCustomer.getState().cart).toBeNull();
  resolveCart(cart);
  rejectAddresses(new Error('offline'));
  await work;
  expect(useCustomer.getState().status).toBe('signedIn');
  expect(useCustomer.getState().cart?.cartId).toBe('cart');
  expect(useCustomer.getState().error).toBeTruthy();
});
test('does not submit checkout when the backend reports cash is unavailable', async () => {
  useCustomer.setState({quote:{...quote,codAvailable:false}});
  expect(await useCustomer.getState().placeOrder()).toBe(false);
  expect(api.place).not.toHaveBeenCalled();
  expect(useCustomer.getState().checkoutError).toMatch(/not available/);
});

test('explains a coverage lookup failure before attempting to save an address', async () => {
  api.serviceability.mockRejectedValueOnce(new TypeError('network unavailable'));
  await expect(useCustomer.getState().addAddress({line1:'12 Main Street',pincode:'520001',contactName:'Customer',contactPhone:'+919876543210',lat:16.50547,lng:80.64823}))
    .rejects.toThrow('Couldn’t check delivery coverage.');
  expect(api.createAddress).not.toHaveBeenCalled();
});

test('retries an unconfirmed address with the original request ID and blocks checkout', async () => {
  useCustomer.setState({locationRequired:true});
  api.deliverySettings.mockResolvedValue({locationRequired:true});
  const written = {line1:'12 Main Street',pincode:'520001',contactName:'Customer',contactPhone:'+919876543210'};
  const address = {id:'address',...written,point:null,isDefault:true,version:'1'};
  api.createPendingAddress.mockRejectedValueOnce(new TypeError('network')).mockResolvedValueOnce({address,needsConfirmation:false,degraded:false});
  await expect(useCustomer.getState().addAddress(written)).rejects.toThrow('network');
  const result = await useCustomer.getState().addAddress(written);
  expect(result).toMatchObject({id:'address',locationNeeded:true});
  expect(api.createPendingAddress.mock.calls.map(call => call[2])).toEqual(['checkout-key','checkout-key']);
  await useCustomer.getState().createQuote();
  expect(api.quote).not.toHaveBeenCalled();
  expect(useCustomer.getState().checkoutError).toMatch(/Confirm the location/);
});

test('allows a saved address without GPS when the admin uses PIN-only delivery', async () => {
  const written = {line1:'12 Main Street',pincode:'520001',contactName:'Customer',contactPhone:'+919876543210'};
  const address = {id:'address',...written,point:null,isDefault:true,version:'1'};
  api.createPendingAddress.mockResolvedValueOnce({address,needsConfirmation:false,degraded:false});
  api.quote.mockResolvedValueOnce(quote);
  const result = await useCustomer.getState().addAddress(written);
  expect(result.locationNeeded).toBe(false);
  expect(api.serviceability).toHaveBeenCalledWith('token','520001');
  await useCustomer.getState().createQuote();
  expect(api.quote).toHaveBeenCalledWith('token',{addressId:'address'});
});

test('refreshes the version after confirming and selecting a saved address', async () => {
  const point = {lat:16.50547,lng:80.64823};
  const address = {id:'other',line1:'12 Main Street',pincode:'520001',contactName:'Customer',contactPhone:'+919876543210',point:null,isDefault:false,version:'1'};
  useCustomer.setState({addresses:[address]});
  api.serviceability.mockResolvedValue({serviceable:true,storeId:'store',zone:{zoneId:'zone',zoneVersion:'1',cityZoneVersion:'1',storeId:'store'},etaRange:null,reasons:[]});
  api.confirmAddressLocation.mockResolvedValue({address:{...address,point,version:'2'},needsConfirmation:false,degraded:false});
  api.selectDefaultAddress.mockResolvedValue(undefined);
  api.addresses.mockResolvedValue([{...address,point,isDefault:true,version:'3'}]);
  await useCustomer.getState().confirmAddressLocation('other',point);
  expect(useCustomer.getState().addresses[0]?.version).toBe('3');
  expect(useCustomer.getState().selectedAddress).toBe('other');
});
