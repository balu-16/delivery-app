import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { create } from 'zustand';
import { ApiError } from '../api/client';
import { requestMessage } from '../api/messages';
import { customerApi, customerDetailsApi, type CatalogItem, type CustomerAddress, type CustomerProfile, type NewCustomerAddress, type PendingCustomerAddress, type ServerCart, type QuoteResult, type PlaceRequest, type CustomerOrder, type CustomerSubscription, type SubscriptionCreateRequest, type Notification, type WalletBalances, type WalletEntry } from '../api/customer';
import { accessToken, restoreSession, signOut } from '../auth/session';
import { unregisterPushBeforeSignOut } from '../notifications/push';
import { requireLocationServices } from '../utils/location-policy';

const pendingKey = (userId: string) => `@dairydirect/pending-checkout-v1:${userId}`;
const subscriptionKey = (userId: string) => `@dairydirect/pending-subscription-v1:${userId}`;
const subscriptionActionKey = (userId: string) => `@dairydirect/pending-subscription-action-v1:${userId}`;
type PendingPlacement = { userId: string; key: string; body: PlaceRequest };
type PendingSubscription = { userId: string; key: string; body: SubscriptionCreateRequest };
export type SubscriptionActionRequest = {id:string; action:'cancel' | 'resume' | 'skip' | 'pause'; body:Record<string,string>};
type PendingSubscriptionAction = SubscriptionActionRequest & {userId:string; key:string};
let cartQueue: Promise<unknown> = Promise.resolve();
let epoch = 0;
let catalogRequest = 0, activityRequest = 0, accountRequest = 0;

export type LoadState = 'idle' | 'loading' | 'success' | 'error';
const beginLoad = (state: LoadState): LoadState => state === 'success' ? 'success' : 'loading';
const failedLoad = (state: LoadState): LoadState => state === 'success' ? 'success' : 'error';
const localMessages = new Set([
  'Your pending checkout could not be read. Please contact support before placing another order.',
  'Your pending subscription could not be read. Please contact support before starting another.',
  'Your pending subscription change could not be read. Please contact support before changing it again.',
  'Sign in to order.', 'Sign in to continue.', 'Select a subscription first.', 'Select a subscription change first.',
  'Review a current checkout quote before ordering.', 'Cash on delivery is not available for this order.',
  'This checkout belongs to a different account.', 'This subscription belongs to a different account.',
  'This subscription change belongs to a different account.', 'Check your pending subscription change before making another.',
  'Your order is awaiting payment. Check order history before retrying.',
  'Turn on your phone location to place this order.', 'Allow location access in your phone settings to place this order.',
  'Confirm the location at your delivery address before reviewing your order.',
]);

function readable(error: unknown) {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'CONCURRENT_MODIFICATION': return 'Your cart changed on another device. We refreshed it; please review it.';
      case 'IDEMPOTENCY_LEASE_LOST': case 'REQUEST_IN_PROGRESS': return 'Your request is still being checked. Retry the same request shortly.';
      case 'CART_NOT_FOUND': return 'Your cart is empty.';
      case 'INVENTORY_INSUFFICIENT': case 'ITEM_UNAVAILABLE': return 'This item is no longer available in the requested quantity.';
      case 'PRICE_CHANGED': return 'Prices changed. Review a new quote before ordering.';
      case 'QUOTE_EXPIRED': return 'Your order summary expired. Review it again before ordering.';
      case 'ADDRESS_NOT_SERVICEABLE': return 'We cannot deliver to this address right now. Try another address or contact support.';
      case 'ADDRESS_LOCATION_REQUIRED': return 'Confirm the location at your delivery address to see available products.';
      case 'COD_NOT_ELIGIBLE': case 'COD_LIMIT_EXCEEDED': return 'Cash on delivery is not available for this order.';
      case 'WALLET_INSUFFICIENT': case 'WALLET_DISABLED': return 'Your wallet availability changed. Review your order again.';
      case 'CUTOFF_PASSED': return 'This delivery is past the change cutoff.';
      case 'SUBSCRIPTION_STATE_INVALID': return 'This subscription can no longer be changed in that way.';
      default: return requestMessage(error);
    }
  }
  if (error instanceof TypeError) return 'Unable to reach the server. Check your connection and try again.';
  if (error instanceof Error && localMessages.has(error.message)) return error.message;
  return requestMessage(error);
}
async function safeCart(token: string) {
  try { return await customerApi.cart(token); }
  catch (error) { if (error instanceof ApiError && error.code === 'CART_NOT_FOUND') return null; throw error; }
}
type Status = 'loading' | 'signedOut' | 'signedIn' | 'unavailable';
type CustomerState = {
  status: Status; error: string | null; busy: boolean; cartBusy: boolean;
  profile: CustomerProfile | null; addresses: CustomerAddress[]; selectedAddress: string | null; locationRequired: boolean;
  products: CatalogItem[]; cursor: string | null; cart: ServerCart | null; quote: QuoteResult | null;
  pendingPlacement: PendingPlacement | null; orders: CustomerOrder[]; subscriptions: CustomerSubscription[];
  pendingSubscription: PendingSubscription | null;
  pendingSubscriptionAction: PendingSubscriptionAction | null;
  favorites: string[]; favoritesLoaded: boolean; favoriteBusy: string[];
  notifications: Notification[]; wallet: WalletBalances | null; ledger: WalletEntry[];
  catalogLoad: { addressId: string | null; state: LoadState };
  activityLoad: { orders: LoadState; subscriptions: LoadState };
  accountLoad: { wallet: LoadState; ledger: LoadState; notifications: LoadState };
  initialize: () => Promise<void>; load: () => Promise<void>; logout: () => Promise<void>;
  chooseAddress: (id: string) => Promise<void>; addAddress: (value: PendingCustomerAddress & Partial<Pick<NewCustomerAddress, 'lat' | 'lng'>>) => Promise<{id:string; locationNeeded:boolean; needsConfirmation:boolean; degraded:boolean; temporarilyUnavailable:boolean}>;
  confirmAddressLocation: (id: string, point: {lat:number; lng:number}) => Promise<{temporarilyUnavailable:boolean; needsConfirmation:boolean; degraded:boolean}>; refreshAddresses: () => Promise<void>; refreshDeliverySettings: () => Promise<boolean>;
  loadCatalog: (cursor?: string) => Promise<void>; updateCart: (id: string, delta: number) => Promise<void>;
  refreshCart: () => Promise<void>; createQuote: () => Promise<void>; placeOrder: () => Promise<boolean>;
  changeCoupon: (code:string | null) => Promise<void>;
  loadActivity: () => Promise<void>; loadAccount: () => Promise<void>; readNotifications: () => Promise<void>;
  cancelOrder: (id: string) => Promise<void>; reorder: (id: string) => Promise<void>; clearError: () => void;
  createSubscription: (body?: SubscriptionCreateRequest) => Promise<boolean>;
  runSubscriptionAction: (request?:SubscriptionActionRequest) => Promise<boolean>;
  loadFavorites: () => Promise<void>; toggleFavorite: (id:string) => Promise<void>;
};

const blank = { profile: null, addresses: [], selectedAddress: null, locationRequired: true, products: [], cursor: null, cart: null, quote: null, pendingPlacement: null, pendingSubscription: null, pendingSubscriptionAction:null, favorites: [], favoritesLoaded:false, favoriteBusy:[], orders: [], subscriptions: [], notifications: [], wallet: null, ledger: [],
  catalogLoad: { addressId: null, state: 'idle' as LoadState }, activityLoad: { orders: 'idle' as LoadState, subscriptions: 'idle' as LoadState },
  accountLoad: { wallet: 'idle' as LoadState, ledger: 'idle' as LoadState, notifications: 'idle' as LoadState } };
export const useCustomer = create<CustomerState>((set, get) => ({
  ...blank, status: 'loading', error: null, busy: false, cartBusy: false,
  clearError: () => set({ error: null }),
  initialize: async () => {
    const generation = ++epoch;
    try {
      const signedIn = await restoreSession();
      if (generation !== epoch) return;
      if (!signedIn) { set({ status: 'signedOut' }); return; }
      await get().load();
    } catch (error) { if (generation === epoch) set({ status: 'unavailable', error: readable(error) }); }
  },
  load: async () => {
    const generation = epoch;
    set({ busy: true, error: null });
    try {
      const token = await accessToken();
      const [profile, addresses, cart, deliverySettings] = await Promise.all([customerApi.profile(token), customerApi.addresses(token), safeCart(token), customerApi.deliverySettings(token).catch(() => ({locationRequired:true}))]);
      const chosen = addresses.find(x => x.isDefault)?.id ?? addresses.find(x => x.id === cart?.addressId)?.id ?? addresses[0]?.id ?? null;
      let pending: PendingPlacement | null = null;
      const raw = await AsyncStorage.getItem(pendingKey(profile.userId));
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as PendingPlacement;
          if (parsed.userId !== profile.userId || typeof parsed.key !== 'string' || !parsed.key || typeof parsed.body?.quoteId !== 'string' || typeof parsed.body?.intentId !== 'string' || parsed.body.method !== 'COD') throw new Error('Invalid recovery record');
          pending = parsed;
        } catch { throw new Error('Your pending checkout could not be read. Please contact support before placing another order.'); }
      }
      let pendingSubscription: PendingSubscription | null = null;
      const subscriptionRaw = await AsyncStorage.getItem(subscriptionKey(profile.userId));
      if (subscriptionRaw) {
        try {
          const parsed = JSON.parse(subscriptionRaw) as PendingSubscription;
          if (parsed.userId !== profile.userId || typeof parsed.key !== 'string' || !parsed.key || !parsed.body || typeof parsed.body.variantId !== 'string' || typeof parsed.body.addressId !== 'string' || typeof parsed.body.slotId !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.body.startDate) || !/^[1-9]\d*$/.test(parsed.body.quantity) || !['DAILY','ALTERNATE_DAYS'].includes(parsed.body.frequencyRule?.type)) throw new Error('Invalid recovery record');
          pendingSubscription = parsed;
        } catch { throw new Error('Your pending subscription could not be read. Please contact support before starting another.'); }
      }
      let pendingSubscriptionAction: PendingSubscriptionAction | null = null;
      const actionRaw = await AsyncStorage.getItem(subscriptionActionKey(profile.userId));
      if (actionRaw) {
        try {
          const parsed = JSON.parse(actionRaw) as PendingSubscriptionAction;
          if (parsed.userId !== profile.userId || typeof parsed.key !== 'string' || !parsed.key || typeof parsed.id !== 'string' || !parsed.id || !['cancel','resume','skip','pause'].includes(parsed.action) || !parsed.body || typeof parsed.body !== 'object' || Array.isArray(parsed.body) || Object.values(parsed.body).some(value => typeof value !== 'string')) throw new Error('Invalid recovery record');
          if ((parsed.action === 'skip' && !/^\d{4}-\d{2}-\d{2}$/.test(parsed.body.date ?? '')) || (parsed.action === 'pause' && (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.body.from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(parsed.body.to ?? '')))) throw new Error('Invalid recovery record');
          pendingSubscriptionAction = parsed;
        } catch { throw new Error('Your pending subscription change could not be read. Please contact support before changing it again.'); }
      }
      if (generation !== epoch) return;
      set({ profile, addresses, selectedAddress: chosen, locationRequired:deliverySettings.locationRequired, cart, quote: null, pendingPlacement: pending, pendingSubscription, pendingSubscriptionAction, status: 'signedIn', busy: false });
      void get().loadFavorites();
      if (chosen) await get().loadCatalog();
    } catch (error) { if (generation === epoch) set({ status: 'unavailable', busy: false, error: readable(error) }); }
  },
  logout: async () => {
    const generation = ++epoch;
    const userId = get().profile?.userId;
    set({busy:true,error:null});
    try {await unregisterPushBeforeSignOut(userId);}
    catch (error) {if (generation === epoch) set({busy:false,error:readable(error)});return;}
    set({ ...blank, status: 'loading', error: null, busy: false, cartBusy: false });
    try { await signOut(); if (generation === epoch) set({ status: 'signedOut' }); }
    catch (error) { if (generation === epoch) set({status:'unavailable',error:readable(error)}); }
  },
  chooseAddress: async id => {
    const generation = epoch;
    set({ busy: true, error: null });
    try { const token = await accessToken(); await customerApi.selectDefaultAddress(token, id); if (generation !== epoch) return; set({ selectedAddress: id, products: [], cursor: null, quote: null }); await get().loadCatalog(); }
    catch (error) { if (generation === epoch) set({ error: readable(error) }); throw error; } finally { if (generation === epoch) set({ busy: false }); }
  },
  addAddress: async value => {
    const generation = epoch;
    set({ busy: true, error: null });
    try {
      const token = await accessToken();
      const hasPoint = typeof value.lat === 'number' && typeof value.lng === 'number';
      const service = await customerApi.serviceability(token, value.pincode).catch(error => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403))
          throw new Error('Could not check delivery coverage. Sign in again and try again.');
        if (error instanceof TypeError)
          throw new Error('Could not check delivery coverage. Check your connection and try again.');
        throw new Error('Could not check delivery coverage. Please try again shortly.');
      });
      const {lat, lng, ...written} = value;
      const requestBody = {...written, makeDefault:true};
      const userId = get().profile?.userId;
      if (!userId) throw new Error('Sign in again to save this address.');
      const fingerprint = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify(requestBody));
      const storageKey = `@dairydirect/pending-address:${userId}:${fingerprint}`;
      let key = await AsyncStorage.getItem(storageKey);
      if (!key) { key = Crypto.randomUUID(); await AsyncStorage.setItem(storageKey, key); }
      let result = await customerApi.createPendingAddress(token, requestBody, key);
      if (hasPoint && lat !== undefined && lng !== undefined) {
        result = await customerApi.confirmAddressLocation(token, result.address.id, {lat, lng, version:result.address.version});
      }
      const address = result.address;
      await AsyncStorage.removeItem(storageKey).catch(() => undefined);
      if (generation !== epoch) throw new Error('Session changed.');
      const addresses = [...get().addresses.filter(item => item.id !== address.id).map(item => ({...item,isDefault:false})), address];
      set({ addresses, selectedAddress: address.id, quote: null, products: [] });
      await get().loadCatalog();
      return {id:address.id, locationNeeded:get().locationRequired && !address.point, needsConfirmation:result.needsConfirmation, degraded:result.degraded, temporarilyUnavailable:!service.serviceable};
    } finally { if (generation === epoch) set({ busy: false }); }
  },
  refreshAddresses: async () => {
    const generation = epoch;
    const addresses = await customerApi.addresses(await accessToken());
    if (generation === epoch) set({addresses, selectedAddress:addresses.find(item => item.isDefault)?.id ?? get().selectedAddress});
  },
  refreshDeliverySettings: async () => {
    const generation = epoch;
    const { locationRequired } = await customerApi.deliverySettings(await accessToken());
    if (generation === epoch) set({ locationRequired });
    return locationRequired;
  },
  confirmAddressLocation: async (id, point) => {
    const generation = epoch;
    set({busy:true,error:null});
    try {
      const address = get().addresses.find(item => item.id === id);
      if (!address) throw new Error('Address not found. Reopen your saved addresses and try again.');
      const token = await accessToken();
      const service = await customerApi.serviceability(token, address.pincode);
      const result = await customerApi.confirmAddressLocation(token, id, {...point, version:address.version});
      await customerApi.selectDefaultAddress(token, id);
      const addresses = await customerApi.addresses(token);
      if (generation !== epoch) throw new Error('Your session changed. Sign in and try again.');
      if (!addresses.some(item => item.id === result.address.id && item.point)) throw new Error('Could not refresh the confirmed address.');
      set({addresses, selectedAddress:id, products:[], quote:null});
      await get().loadCatalog();
      return {temporarilyUnavailable:!service.serviceable,needsConfirmation:result.needsConfirmation,degraded:result.degraded};
    } finally {if (generation === epoch) set({busy:false});}
  },
  loadCatalog: async cursor => {
    const addressId = get().selectedAddress; const generation = epoch;
    if (!addressId || !get().addresses.some(item => item.id === addressId)) {set({products:[], cursor:null, catalogLoad:{addressId:null,state:'idle'}});return;}
    const request = ++catalogRequest;
    const previous = get().catalogLoad;
    set({ catalogLoad: { addressId, state: previous.addressId === addressId ? beginLoad(previous.state) : 'loading' } });
    const current = () => generation === epoch && request === catalogRequest && addressId === get().selectedAddress;
    try {
      const page = await customerApi.catalog(await accessToken(), addressId, cursor);
      if (current()) set({ products: cursor ? [...get().products, ...page.items.filter(x => !get().products.some(y => y.variantId === x.variantId))] : page.items, cursor: page.nextCursor, catalogLoad: { addressId, state: 'success' } });
    } catch (error) {
      if (current()) set({ error: readable(error), catalogLoad: { addressId, state: failedLoad(get().catalogLoad.state) } });
    }
  },
  refreshCart: async () => { const generation = epoch; try { const cart = await safeCart(await accessToken()); if (generation === epoch) set({ cart, quote: null }); } catch (error) { if (generation === epoch) set({ error: readable(error) }); } },
  updateCart: async (id, delta) => {
    const generation = epoch;
    const operation = cartQueue.catch(() => {}).then(async () => {
      if (generation !== epoch) return;
      const state = get(); const addressId = state.selectedAddress;
      if (state.pendingPlacement) { set({ error: 'Check or retry your pending order before changing the cart.' }); return; }
      if (!addressId) { set({ error: 'Add a delivery address first.' }); return; }
      if (state.cart && state.cart.addressId !== addressId) { set({ error: 'Review your cart for the new delivery address before changing items.' }); return; }
      set({ cartBusy: true, error: null, quote: null });
      try {
        const token = await accessToken();
        const cart = get().cart;
        const old = Number(cart?.lines.find(line => line.variantId === id)?.quantity ?? 0);
        const quantity = Math.max(0, old + delta);
        if (quantity === old && (delta !== 0 || old === 0)) return;
        const result = await customerApi.putItem(token, id, { quantity: String(quantity), version: cart?.version ?? 1, addressId }, Crypto.randomUUID());
        if (generation === epoch) set({ cart: result.cart, error: result.clamped ? 'The quantity was adjusted to available stock.' : null });
      } catch (error) {
        if (generation === epoch) {
          if (error instanceof ApiError && error.code === 'CONCURRENT_MODIFICATION') await get().refreshCart();
          set({ error: readable(error) });
        }
      } finally { if (generation === epoch) set({ cartBusy: false }); }
    });
    cartQueue = operation;
    await operation;
  },
  changeCoupon: async code => {
    const generation = epoch;
    const operation = cartQueue.catch(() => {}).then(async () => {
      if (generation !== epoch) return;
      const state = get();
      if (state.pendingPlacement || !state.cart || state.cart.addressId !== state.selectedAddress) {set({error:'Review your cart and any pending order first.'});return;}
      set({cartBusy:true,error:null,quote:null});
      try {
        const token = await accessToken();
        const updated = code ? await customerApi.applyCoupon(token,code.trim(),state.cart.version,Crypto.randomUUID()) : await customerApi.removeCoupon(token,state.cart.version,Crypto.randomUUID());
        if (generation === epoch) set({cart:updated});
      } catch (error) {if (generation === epoch) {if (error instanceof ApiError && error.code === 'CONCURRENT_MODIFICATION') await get().refreshCart();set({error:readable(error)});}}
      finally {if (generation === epoch) set({cartBusy:false});}
    });
    cartQueue = operation; await operation;
  },
  createQuote: async () => {
    await cartQueue.catch(() => {});
    const addressId = get().selectedAddress;
    const generation = epoch;
    if (get().pendingPlacement) { set({ error: 'Check or retry your pending order first.' }); return; }
    if (!addressId || !get().cart?.lines.length) { set({ error: 'Add items and select a delivery address first.' }); return; }
    set({ busy: true, error: null, quote: null });
    try { const required = await get().refreshDeliverySettings(); if (required) {if (!get().addresses.find(item => item.id === addressId)?.point) throw new Error('Confirm the location at your delivery address before reviewing your order.'); await requireLocationServices();} const token = await accessToken(); const quote = await customerApi.quote(token, { addressId }); const cart = await safeCart(token); if (generation === epoch && addressId === get().selectedAddress) set({ quote, cart }); }
    catch (error) { if (generation === epoch) set({ error: readable(error) }); } finally { if (generation === epoch) set({ busy: false }); }
  },
  placeOrder: async () => {
    if (get().busy) return false;
    const generation = epoch;
    set({ busy: true, error: null });
    try {
      const profile = get().profile; if (!profile) throw new Error('Sign in to order.');
      let pending = get().pendingPlacement;
      if (!pending) {
        if (await get().refreshDeliverySettings()) {
          if (!get().addresses.find(item => item.id === get().selectedAddress)?.point) throw new Error('Confirm the location at your delivery address before reviewing your order.');
          await requireLocationServices();
        }
        const quote = get().quote;
        if (!quote || quote.quote.issues.length || Date.parse(quote.intentExpiresAt) <= Date.now()) throw new Error('Review a current checkout quote before ordering.');
        if (!quote.codAvailable) throw new Error('Cash on delivery is not available for this order.');
        pending = { userId: profile.userId, key: Crypto.randomUUID(), body: { quoteId: quote.quote.quoteId, intentId: quote.intentId, method: 'COD' } };
        await AsyncStorage.setItem(pendingKey(profile.userId), JSON.stringify(pending));
        if (generation !== epoch) return false;
        set({ pendingPlacement: pending });
      }
      if (pending.userId !== profile.userId) throw new Error('This checkout belongs to a different account.');
      const result = await customerApi.place(await accessToken(), pending.body, pending.key);
      if (result.confirmation !== 'CONFIRMED') throw new Error('Your order is awaiting payment. Check order history before retrying.');
      await AsyncStorage.removeItem(pendingKey(profile.userId));
      if (generation !== epoch) return true;
      set({ pendingPlacement: null, quote: null });
      await get().refreshCart();
      await get().loadActivity();
      return true;
    } catch (error) {
      // Keep the exact request and key across ambiguous network failures; never create a duplicate.
      if (generation === epoch && error instanceof ApiError && ['COD_NOT_ELIGIBLE', 'COD_LIMIT_EXCEEDED', 'PRICE_CHANGED', 'QUOTE_EXPIRED', 'CONCURRENT_MODIFICATION', 'INVENTORY_INSUFFICIENT', 'ITEM_UNAVAILABLE', 'ADDRESS_NOT_SERVICEABLE', 'ADDRESS_LOCATION_REQUIRED', 'CART_NOT_FOUND', 'WALLET_INSUFFICIENT', 'WALLET_DISABLED', 'COUPON_INVALID', 'MIN_ORDER_NOT_MET', 'MAX_ORDER_EXCEEDED'].includes(error.code)) {
        const profile = get().profile;
        if (profile) { try { await AsyncStorage.removeItem(pendingKey(profile.userId)); set({ pendingPlacement: null, quote: null }); } catch { /* Retain the pending request until it can be safely removed. */ } }
      }
      if (generation === epoch) set({ error: readable(error) }); return false;
    } finally { if (generation === epoch) set({ busy: false }); }
  },
  createSubscription: async body => {
    if (get().busy) return false;
    const generation = epoch;
    set({busy:true, error:null});
    try {
      const profile = get().profile;
      if (!profile) throw new Error('Sign in to continue.');
      let pending = get().pendingSubscription;
      if (!pending) {
        if (!body) throw new Error('Select a subscription first.');
        pending = {userId:profile.userId, key:Crypto.randomUUID(), body};
        await AsyncStorage.setItem(subscriptionKey(profile.userId), JSON.stringify(pending));
        if (generation !== epoch) return false;
        set({pendingSubscription:pending});
      }
      if (pending.userId !== profile.userId) throw new Error('This subscription belongs to a different account.');
      await customerDetailsApi.createSubscription(await accessToken(), pending.body, pending.key);
      await AsyncStorage.removeItem(subscriptionKey(profile.userId));
      if (generation !== epoch) return true;
      set({pendingSubscription:null});
      await get().loadActivity();
      return true;
    } catch (error) {
      if (generation === epoch && error instanceof ApiError && ['SUBSCRIPTIONS_DISABLED','ADDRESS_NOT_SERVICEABLE','INVALID_SLOT_TIMING','NO_ELIGIBLE_DELIVERY','INVALID_DATE','INVALID_INPUT'].includes(error.code)) {
        const profile = get().profile;
        if (profile) { try { await AsyncStorage.removeItem(subscriptionKey(profile.userId)); set({pendingSubscription:null}); } catch { /* Keep the request for recovery. */ } }
      }
      if (generation === epoch) set({error:readable(error)});
      return false;
    } finally { if (generation === epoch) set({busy:false}); }
  },
  runSubscriptionAction: async request => {
    if (get().busy) return false;
    const generation = epoch;
    set({busy:true,error:null});
    try {
      const profile = get().profile;
      if (!profile) throw new Error('Sign in to continue.');
      let pending = get().pendingSubscriptionAction;
      if (pending && request && (pending.id !== request.id || pending.action !== request.action || JSON.stringify(pending.body) !== JSON.stringify(request.body))) throw new Error('Check your pending subscription change before making another.');
      if (!pending) {
        if (!request) throw new Error('Select a subscription change first.');
        pending = {...request,userId:profile.userId,key:Crypto.randomUUID()};
        await AsyncStorage.setItem(subscriptionActionKey(profile.userId),JSON.stringify(pending));
        if (generation !== epoch) return false;
        set({pendingSubscriptionAction:pending});
      }
      if (pending.userId !== profile.userId) throw new Error('This subscription change belongs to a different account.');
      await customerDetailsApi.subscriptionAction(await accessToken(),pending.id,pending.action,pending.body,pending.key);
      await AsyncStorage.removeItem(subscriptionActionKey(profile.userId));
      if (generation !== epoch) return true;
      set({pendingSubscriptionAction:null});
      await get().loadActivity();
      return true;
    } catch (error) {
      if (generation === epoch && error instanceof ApiError && ['SUBSCRIPTIONS_DISABLED','SUBSCRIPTION_STATE_INVALID','ADDRESS_NOT_SERVICEABLE','CUTOFF_PASSED','INVALID_PAUSE','INVALID_DELIVERY_DATE','NO_ELIGIBLE_DELIVERY','INVALID_DATE','INVALID_INPUT'].includes(error.code)) {
        const profile = get().profile;
        if (profile) { try {await AsyncStorage.removeItem(subscriptionActionKey(profile.userId));set({pendingSubscriptionAction:null});} catch { /* Keep the request for recovery. */} }
      }
      if (generation === epoch) set({error:readable(error)});
      return false;
    } finally {if (generation === epoch) set({busy:false});}
  },
  loadFavorites: async () => {
    const generation = epoch;
    try {
      const token = await accessToken();
      const favorites:string[] = []; let cursor:string | undefined; const seen = new Set<string>();
      do {
        const page = await customerApi.favorites(token,cursor);
        favorites.push(...page.items);
        if (page.nextCursor && seen.has(page.nextCursor)) throw new Error('Invalid favorites page.');
        if (page.nextCursor) seen.add(page.nextCursor);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (generation === epoch) set({favorites,favoritesLoaded:true});
    } catch (error) { if (generation === epoch) set({favoritesLoaded:false,error:readable(error)}); }
  },
  toggleFavorite: async id => {
    const generation = epoch;
    if (!get().favoritesLoaded || get().favoriteBusy.includes(id)) return;
    const active = !get().favorites.includes(id);
    set({favoriteBusy:[...get().favoriteBusy,id]});
    try {
      await customerApi.setFavorite(await accessToken(),id,active);
      if (generation === epoch) set({favorites:active ? [...get().favorites,id] : get().favorites.filter(item => item !== id)});
    } catch (error) { if (generation === epoch) {set({error:readable(error)});await get().loadFavorites();} }
    finally {if (generation === epoch) set({favoriteBusy:get().favoriteBusy.filter(item => item !== id)});}
  },
  loadActivity: async () => {
    const generation = epoch, request = ++activityRequest;
    const current = () => generation === epoch && request === activityRequest;
    set(state => ({ activityLoad: { orders: beginLoad(state.activityLoad.orders), subscriptions: beginLoad(state.activityLoad.subscriptions) } }));
    try {
      const token = await accessToken();
      if (!current()) return;
      await Promise.all([
        customerDetailsApi.orders(token).then(result => { if (current()) set(state => ({ orders: result.items, activityLoad: { ...state.activityLoad, orders: 'success' } })); })
          .catch(() => { if (current()) set(state => ({ error: 'Some activity could not be loaded. Please refresh.', activityLoad: { ...state.activityLoad, orders: failedLoad(state.activityLoad.orders) } })); }),
        customerDetailsApi.subscriptions(token).then(result => { if (current()) set(state => ({ subscriptions: result.items, activityLoad: { ...state.activityLoad, subscriptions: 'success' } })); })
          .catch(() => { if (current()) set(state => ({ error: 'Some activity could not be loaded. Please refresh.', activityLoad: { ...state.activityLoad, subscriptions: failedLoad(state.activityLoad.subscriptions) } })); }),
      ]);
    } catch (error) { if (current()) set(state => ({ error: readable(error), activityLoad: { orders: failedLoad(state.activityLoad.orders), subscriptions: failedLoad(state.activityLoad.subscriptions) } })); }
  },
  loadAccount: async () => {
    const generation = epoch, request = ++accountRequest;
    const current = () => generation === epoch && request === accountRequest;
    set(state => ({ accountLoad: { wallet: beginLoad(state.accountLoad.wallet), ledger: beginLoad(state.accountLoad.ledger), notifications: beginLoad(state.accountLoad.notifications) } }));
    try {
      const token = await accessToken();
      if (!current()) return;
      await Promise.all([
        customerApi.wallet(token).then(result => { if (current()) set(state => ({ wallet: result, accountLoad: { ...state.accountLoad, wallet: 'success' } })); })
          .catch(() => { if (current()) set(state => ({ error: 'Some account information could not be loaded. Please try again.', accountLoad: { ...state.accountLoad, wallet: failedLoad(state.accountLoad.wallet) } })); }),
        customerDetailsApi.ledger(token).then(result => { if (current()) set(state => ({ ledger: result.items, accountLoad: { ...state.accountLoad, ledger: 'success' } })); })
          .catch(() => { if (current()) set(state => ({ error: 'Some account information could not be loaded. Please try again.', accountLoad: { ...state.accountLoad, ledger: failedLoad(state.accountLoad.ledger) } })); }),
        customerDetailsApi.notifications(token).then(result => { if (current()) set(state => ({ notifications: result.items, accountLoad: { ...state.accountLoad, notifications: 'success' } })); })
          .catch(() => { if (current()) set(state => ({ error: 'Some account information could not be loaded. Please try again.', accountLoad: { ...state.accountLoad, notifications: failedLoad(state.accountLoad.notifications) } })); }),
      ]);
    } catch (error) { if (current()) set(state => ({ error: readable(error), accountLoad: { wallet: failedLoad(state.accountLoad.wallet), ledger: failedLoad(state.accountLoad.ledger), notifications: failedLoad(state.accountLoad.notifications) } })); }
  },
  readNotifications: async () => { try { await customerDetailsApi.readNotifications(await accessToken()); await get().loadAccount(); } catch (error) { set({ error: readable(error) }); } },
  cancelOrder: async id => { set({ busy: true }); try { await customerDetailsApi.cancel(await accessToken(), id, 'Customer request', Crypto.randomUUID()); await get().loadActivity(); } catch (error) { set({ error: readable(error) }); } finally { set({ busy: false }); } },
  reorder: async id => { if (get().pendingPlacement) {set({error:'Check your pending order before changing the cart.'});return;} set({ busy: true }); try { const result = await customerDetailsApi.reorder(await accessToken(), id, Crypto.randomUUID()); await get().refreshCart(); if (result.issues.length) set({ error: 'Some items could not be added. Review your cart.' }); } catch (error) { set({ error: readable(error) }); } finally { set({ busy: false }); } },
}));
