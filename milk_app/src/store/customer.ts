import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { create } from 'zustand';
import { ApiError } from '../api/client';
import { customerApi, customerDetailsApi, type CatalogItem, type CustomerAddress, type CustomerProfile, type NewCustomerAddress, type ServerCart, type QuoteResult, type PlaceRequest, type CustomerOrder, type CustomerSubscription, type SubscriptionCreateRequest, type Notification, type WalletBalances, type WalletEntry } from '../api/customer';
import { accessToken, restoreSession, signOut } from '../auth/session';
import { unregisterPushBeforeSignOut } from '../notifications/push';

const pendingKey = (userId: string) => `@dairydirect/pending-checkout-v1:${userId}`;
const subscriptionKey = (userId: string) => `@dairydirect/pending-subscription-v1:${userId}`;
const subscriptionActionKey = (userId: string) => `@dairydirect/pending-subscription-action-v1:${userId}`;
type PendingPlacement = { userId: string; key: string; body: PlaceRequest };
type PendingSubscription = { userId: string; key: string; body: SubscriptionCreateRequest };
export type SubscriptionActionRequest = {id:string; action:'cancel' | 'resume' | 'skip' | 'pause'; body:Record<string,string>};
type PendingSubscriptionAction = SubscriptionActionRequest & {userId:string; key:string};
let cartQueue: Promise<unknown> = Promise.resolve();
let epoch = 0;

function readable(error: unknown) {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'CONCURRENT_MODIFICATION': return 'Your cart changed on another device. We refreshed it; please review it.';
      case 'IDEMPOTENCY_LEASE_LOST': case 'REQUEST_IN_PROGRESS': return 'Your request is still being checked. Retry the same request shortly.';
      case 'CART_NOT_FOUND': return 'Your cart is empty.';
      case 'INVENTORY_INSUFFICIENT': case 'ITEM_UNAVAILABLE': return 'This item is no longer available in the requested quantity.';
      case 'PRICE_CHANGED': return 'Prices changed. Review a new quote before ordering.';
      case 'QUOTE_EXPIRED': return 'Your order summary expired. Review it again before ordering.';
      case 'ADDRESS_NOT_SERVICEABLE': return 'This address is not currently serviceable.';
      case 'COD_NOT_ELIGIBLE': case 'COD_LIMIT_EXCEEDED': return 'Cash on delivery is not available for this order.';
      case 'WALLET_INSUFFICIENT': case 'WALLET_DISABLED': return 'Your wallet availability changed. Review your order again.';
      case 'CUTOFF_PASSED': return 'This delivery is past the change cutoff.';
      case 'SUBSCRIPTION_STATE_INVALID': return 'This subscription can no longer be changed in that way.';
      default: return `The request could not be completed (${error.code}).`;
    }
  }
  if (error instanceof TypeError) return 'Unable to reach the server. Check your connection and try again.';
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
async function safeCart(token: string) {
  try { return await customerApi.cart(token); }
  catch (error) { if (error instanceof ApiError && error.code === 'CART_NOT_FOUND') return null; throw error; }
}
type Status = 'loading' | 'signedOut' | 'signedIn' | 'unavailable';
type CustomerState = {
  status: Status; error: string | null; busy: boolean; cartBusy: boolean;
  profile: CustomerProfile | null; addresses: CustomerAddress[]; selectedAddress: string | null;
  products: CatalogItem[]; cursor: string | null; cart: ServerCart | null; quote: QuoteResult | null;
  pendingPlacement: PendingPlacement | null; orders: CustomerOrder[]; subscriptions: CustomerSubscription[];
  pendingSubscription: PendingSubscription | null;
  pendingSubscriptionAction: PendingSubscriptionAction | null;
  favorites: string[]; favoritesLoaded: boolean; favoriteBusy: string[];
  notifications: Notification[]; wallet: WalletBalances | null; ledger: WalletEntry[];
  initialize: () => Promise<void>; load: () => Promise<void>; logout: () => Promise<void>;
  chooseAddress: (id: string) => Promise<void>; addAddress: (value: NewCustomerAddress) => Promise<{needsConfirmation:boolean; degraded:boolean; temporarilyUnavailable:boolean}>;
  loadCatalog: (cursor?: string) => Promise<void>; updateCart: (id: string, delta: number) => Promise<void>;
  refreshCart: () => Promise<void>; createQuote: () => Promise<void>; placeOrder: () => Promise<boolean>;
  changeCoupon: (code:string | null) => Promise<void>;
  loadActivity: () => Promise<void>; loadAccount: () => Promise<void>; readNotifications: () => Promise<void>;
  cancelOrder: (id: string) => Promise<void>; reorder: (id: string) => Promise<void>; clearError: () => void;
  createSubscription: (body?: SubscriptionCreateRequest) => Promise<boolean>;
  runSubscriptionAction: (request?:SubscriptionActionRequest) => Promise<boolean>;
  loadFavorites: () => Promise<void>; toggleFavorite: (id:string) => Promise<void>;
};

const blank = { profile: null, addresses: [], selectedAddress: null, products: [], cursor: null, cart: null, quote: null, pendingPlacement: null, pendingSubscription: null, pendingSubscriptionAction:null, favorites: [], favoritesLoaded:false, favoriteBusy:[], orders: [], subscriptions: [], notifications: [], wallet: null, ledger: [] };
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
      const [profile, addresses, cart] = await Promise.all([customerApi.profile(token), customerApi.addresses(token), safeCart(token)]);
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
      set({ profile, addresses, selectedAddress: chosen, cart, quote: null, pendingPlacement: pending, pendingSubscription, pendingSubscriptionAction, status: 'signedIn', busy: false });
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
    catch (error) { if (generation === epoch) set({ error: readable(error) }); } finally { if (generation === epoch) set({ busy: false }); }
  },
  addAddress: async value => {
    const generation = epoch;
    set({ busy: true, error: null });
    try {
      const token = await accessToken();
      const service = await customerApi.serviceability(token, value.lat, value.lng).catch(error => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403))
          throw new Error('Could not check delivery coverage. Sign in again and try again.');
        if (error instanceof TypeError)
          throw new Error('Could not check delivery coverage. Check your connection and try again.');
        throw new Error('Could not check delivery coverage. Please try again shortly.');
      });
      if (!service.zone || service.reasons.includes('OUTSIDE_ZONE')) throw new Error('This address is outside the current delivery area.');
      const result = await customerApi.createAddress(token, { ...value, makeDefault: true });
      if (generation !== epoch) throw new Error('Session changed.');
      const addresses = [...get().addresses.filter(address => address.id !== result.address.id).map(address => ({...address,isDefault:false})), result.address];
      set({ addresses, selectedAddress: result.address.id, quote: null, products: [] });
      await get().loadCatalog();
      return {needsConfirmation:result.needsConfirmation, degraded:result.degraded, temporarilyUnavailable:!service.serviceable};
    } finally { if (generation === epoch) set({ busy: false }); }
  },
  loadCatalog: async cursor => {
    const addressId = get().selectedAddress; const generation = epoch;
    if (!addressId) return;
    try { const page = await customerApi.catalog(await accessToken(), addressId, cursor); if (generation === epoch && addressId === get().selectedAddress) set({ products: cursor ? [...get().products, ...page.items.filter(x => !get().products.some(y => y.variantId === x.variantId))] : page.items, cursor: page.nextCursor }); }
    catch (error) { if (generation === epoch) set({ error: readable(error) }); }
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
    try { const token = await accessToken(); const quote = await customerApi.quote(token, { addressId }); const cart = await safeCart(token); if (generation === epoch && addressId === get().selectedAddress) set({ quote, cart }); }
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
      if (generation === epoch && error instanceof ApiError && ['COD_NOT_ELIGIBLE', 'COD_LIMIT_EXCEEDED', 'PRICE_CHANGED', 'QUOTE_EXPIRED', 'CONCURRENT_MODIFICATION', 'INVENTORY_INSUFFICIENT', 'ITEM_UNAVAILABLE', 'ADDRESS_NOT_SERVICEABLE', 'CART_NOT_FOUND', 'WALLET_INSUFFICIENT', 'WALLET_DISABLED', 'COUPON_INVALID', 'MIN_ORDER_NOT_MET', 'MAX_ORDER_EXCEEDED'].includes(error.code)) {
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
    const generation = epoch;
    try {
      const token = await accessToken();
      const [orders, subscriptions] = await Promise.allSettled([customerDetailsApi.orders(token), customerDetailsApi.subscriptions(token)]);
      if (generation !== epoch) return;
      if (orders.status === 'fulfilled') set({ orders: orders.value.items });
      if (subscriptions.status === 'fulfilled') set({ subscriptions: subscriptions.value.items });
      if (orders.status === 'rejected' || subscriptions.status === 'rejected') set({ error: 'Some activity could not be loaded. Please refresh.' });
    } catch (error) { if (generation === epoch) set({ error: readable(error) }); }
  },
  loadAccount: async () => {
    const generation = epoch;
    try {
      const token = await accessToken();
      const [wallet, ledger, notifications] = await Promise.allSettled([customerApi.wallet(token), customerDetailsApi.ledger(token), customerDetailsApi.notifications(token)]);
      if (generation !== epoch) return;
      if (wallet.status === 'fulfilled') set({ wallet: wallet.value });
      if (ledger.status === 'fulfilled') set({ ledger: ledger.value.items });
      if (notifications.status === 'fulfilled') set({ notifications: notifications.value.items });
      if (wallet.status === 'rejected' || ledger.status === 'rejected' || notifications.status === 'rejected') set({ error: 'Some account information could not be loaded. Please try again.' });
    } catch (error) { if (generation === epoch) set({ error: readable(error) }); }
  },
  readNotifications: async () => { try { await customerDetailsApi.readNotifications(await accessToken()); await get().loadAccount(); } catch (error) { set({ error: readable(error) }); } },
  cancelOrder: async id => { set({ busy: true }); try { await customerDetailsApi.cancel(await accessToken(), id, 'Customer request', Crypto.randomUUID()); await get().loadActivity(); } catch (error) { set({ error: readable(error) }); } finally { set({ busy: false }); } },
  reorder: async id => { if (get().pendingPlacement) {set({error:'Check your pending order before changing the cart.'});return;} set({ busy: true }); try { const result = await customerDetailsApi.reorder(await accessToken(), id, Crypto.randomUUID()); await get().refreshCart(); if (result.issues.length) set({ error: 'Some items could not be added. Review your cart.' }); } catch (error) { set({ error: readable(error) }); } finally { set({ busy: false }); } },
}));
