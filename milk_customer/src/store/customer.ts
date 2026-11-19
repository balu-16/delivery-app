import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { create } from 'zustand';
import { ApiError } from '../api/client';
import { requestMessage } from '../api/messages';
import { customerApi, customerDetailsApi, type CatalogItem, type CustomerAddress, type CustomerProfile, type DeliverySettings, type FeeEstimate, type NewCustomerAddress, type PendingCustomerAddress, type ServerCart, type QuoteResult, type PlaceRequest, type PlacementOrder, type CustomerOrder, type CustomerSubscription, type SubscriptionCreateRequest, type Notification, type WalletBalances, type WalletEntry } from '../api/customer';
import { accessToken, restoreSession, signOut } from '../auth/session';
import { unregisterPushBeforeSignOut } from '../notifications/push';
import { requireLocationServices } from '../utils/location-policy';
import { appendCartOperation, isCartOperation, projectCart, type CartOperation, type CartProduct } from './cart-sync';
import { clearCatalogCache, fetchCatalogPage, getCachedCatalogPage, invalidateFavoritesCache, isCatalogPageFresh, sameCatalogItems } from './catalog-cache';
import { clearFeesCache, fetchDeliverySettings, getCachedDeliverySettings, isDeliverySettingsFresh } from './fees-cache';
import { applyFavoriteDesires, favoritesStorageKey, isDefinitiveFavoriteError, parseFavoriteIds } from './favorites-sync';
import { isDefinitivePlacementError, ORDER_CONFIRMATION_WAIT, recoveryDelay, type CheckoutPhase } from './checkout-recovery';

const pendingKey = (userId: string) => `@dairydirect/pending-checkout-v1:${userId}`;
const subscriptionKey = (userId: string) => `@dairydirect/pending-subscription-v1:${userId}`;
const subscriptionActionKey = (userId: string) => `@dairydirect/pending-subscription-action-v1:${userId}`;
const cartActionsKey = (userId: string) => `@dairydirect/pending-cart-v1:${userId}`;
type PendingPlacement = { userId: string; key: string; body: PlaceRequest };
type PendingSubscription = { userId: string; key: string; body: SubscriptionCreateRequest };
export type SubscriptionActionRequest = {id:string; action:'cancel' | 'resume' | 'skip' | 'pause'; body:Record<string,string>};
type PendingSubscriptionAction = SubscriptionActionRequest & {userId:string; key:string};
let cartQueue: Promise<unknown> = Promise.resolve();
let cartPersistence: Promise<unknown> = Promise.resolve();
let confirmedCart: ServerCart | null = null;
let pendingCartActions: CartOperation[] = [];
let confirmedFavorites: string[] = [];
const favoriteDesired = new Map<string, boolean>();
const favoriteInflight = new Set<string>();
const favoriteChains = new Map<string, Promise<void>>();
const favoriteFailed = new Map<string, boolean>();
let cartWorkerGeneration = -1;
let epoch = 0;
let catalogRequest = 0, activityRequest = 0, accountRequest = 0;
let cartRevision = 0;
let placementStorage: Promise<unknown> = Promise.resolve();
let placementCheck: { key:string; generation:number; promise:Promise<void> } | null = null;
let quoteCheck: { generation:number; promise:Promise<void> } | null = null;
let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
let recoveryStarted = 0, recoveryAttempt = 0;

function stopPlacementRecovery() {
  if (recoveryTimer) clearTimeout(recoveryTimer);
  recoveryTimer=null;
  recoveryStarted=0;
  recoveryAttempt=0;
}
function schedulePlacementRecovery(pending:PendingPlacement, generation:number) {
  if (recoveryTimer || generation !== epoch || useCustomer.getState().pendingPlacement?.key !== pending.key) return;
  if (!recoveryStarted) recoveryStarted=Date.now();
  if (Date.now()-recoveryStarted >= 60000) return;
  recoveryTimer=setTimeout(() => {
    recoveryTimer=null;
    if (generation === epoch && useCustomer.getState().pendingPlacement?.key === pending.key)
      void useCustomer.getState().checkPendingPlacement();
  }, recoveryDelay(recoveryAttempt++));
  if (recoveryTimer && typeof (recoveryTimer as unknown as { unref?: unknown }).unref === 'function') (recoveryTimer as unknown as { unref: () => void }).unref();
}
function savePendingPlacement(pending:PendingPlacement) {
  const write=placementStorage.catch(() => {}).then(() => AsyncStorage.setItem(pendingKey(pending.userId),JSON.stringify(pending)));
  placementStorage=write;
  return write;
}
function clearPendingPlacement(pending:PendingPlacement) {
  const write=placementStorage.catch(() => {}).then(async () => {
    const raw=await AsyncStorage.getItem(pendingKey(pending.userId));
    if (!raw) return;
    let value:unknown;
    try { value=JSON.parse(raw); } catch { return; }
    if (value && typeof value === 'object' && 'key' in value && value.key === pending.key)
      await AsyncStorage.removeItem(pendingKey(pending.userId));
  });
  placementStorage=write;
  return write;
}

function persistCartActions(userId:string) {
  const value = JSON.stringify(pendingCartActions);
  const write = cartPersistence.catch(() => {}).then(() => AsyncStorage.setItem(cartActionsKey(userId),value));
  cartPersistence = write;
  return write;
}
async function removeCartActions(userId:string, remove:(action:CartOperation,index:number)=>boolean) {
  const before=pendingCartActions;
  pendingCartActions=before.filter((action,index) => !remove(action,index));
  try {await persistCartActions(userId);}
  catch (error) {
    const existing=new Set(before.map(action => action.id));
    pendingCartActions=[...before,...pendingCartActions.filter(action => !existing.has(action.id))];
    throw error;
  }
}
function publishCart(userId:string) {
  if (useCustomer.getState().profile?.userId !== userId) return;
  useCustomer.setState({cart:projectCart(confirmedCart,pendingCartActions,userId),cartBusy:pendingCartActions.length > 0,pendingVariantIds:[...new Set(pendingCartActions.map((action) => action.variantId))]});
}
function startCartSync(userId:string, generation:number):Promise<unknown> {
  if (cartWorkerGeneration === generation) return cartQueue;
  cartWorkerGeneration = generation;
  const previous = cartQueue.catch(() => {});
  const operation = previous.then(async () => {
    let conflicts=0;
    try {
      while (generation === epoch && pendingCartActions.length) {
        let action=pendingCartActions[0];
        const replay=!!action.request;
        if (!action.request) {
          const old=Number(confirmedCart?.lines.find(line => line.variantId === action.variantId)?.quantity ?? 0);
          const quantity=Math.max(0,old+action.delta);
          if (quantity === old && action.delta !== 0) {
            await removeCartActions(userId,(_action,index) => index === 0); publishCart(userId); continue;
          }
          action={...action,request:{quantity:String(quantity),version:confirmedCart?.version ?? 1,
            ...(action.product ? {displayedUnitPricePaise:action.product.sellingPaise} : action.acceptedPricePaise ? {displayedUnitPricePaise:action.acceptedPricePaise} : {}),
            ...(action.delta === 0 ? {acceptPriceChange:true} : {})}};
          pendingCartActions=[action,...pendingCartActions.slice(1)];
        }
        // Persist the exact key and body before sending, so an interrupted request can be retried safely.
        await persistCartActions(userId);
        if (generation !== epoch) return;
        try {
          const token=await accessToken();
          const result=await customerApi.putItem(token,action.variantId,action.request!,action.id);
          // An idempotent replay can return an older snapshot after another device changed the cart.
          let latest:ServerCart | null=result.cart;
          if (replay) {
            try {latest=await safeCart(token);}
            catch {if (generation === epoch) useCustomer.setState({cartSyncFailed:true,error:'Your cart was updated, but we could not refresh it. Tap Retry to check it safely.'});return;}
          }
          if (generation !== epoch) return;
          const previousCart=confirmedCart;
          confirmedCart=latest;
          conflicts=0;
          try { await removeCartActions(userId,(_action,index) => index === 0); }
          catch (error) {confirmedCart=previousCart;publishCart(userId);throw error;}
          publishCart(userId);
          useCustomer.setState({cartSyncFailed:false,...(result.clamped ? {error:'The quantity was adjusted to the per-order limit.'} : {})});
        } catch (error) {
          if (generation !== epoch) return;
          if (error instanceof ApiError && error.code === 'CONCURRENT_MODIFICATION' && conflicts++ < 3) {
            confirmedCart=await safeCart(await accessToken());
            if (generation !== epoch) return;
            pendingCartActions=[{...action,id:Crypto.randomUUID(),request:undefined},...pendingCartActions.slice(1)];
            await persistCartActions(userId); publishCart(userId); continue;
          }
          if (error instanceof ApiError && error.code === 'CONCURRENT_MODIFICATION') {
            pendingCartActions=[{...action,id:Crypto.randomUUID(),request:undefined},...pendingCartActions.slice(1)];
            await persistCartActions(userId);
            useCustomer.setState({cartSyncFailed:true,error:'Your cart is changing on another device. Tap Retry to save your changes.'});
            return;
          }
          if (error instanceof ApiError && error.status < 500 && ![408,429].includes(error.status) && !['REQUEST_IN_PROGRESS','IDEMPOTENCY_LEASE_LOST'].includes(error.code)) {
            await removeCartActions(userId,(next,index) => index === 0 || (error.code === 'PRICE_CHANGED' && next.variantId === action.variantId));
            if (error.code === 'PRICE_CHANGED') {
              try {confirmedCart=await safeCart(await accessToken());} catch { /* Keep the last known cart. */ }
              if (generation !== epoch) return;
            }
            publishCart(userId);
            useCustomer.setState({error:error.code === 'PRICE_CHANGED' ? 'Price changed. Review your cart.' : readable(error, 'save your cart')});
            continue;
          }
          useCustomer.setState({cartSyncFailed:true,error:'Your cart changes are waiting to be saved.'});
          return;
        }
      }
    } catch {
      if (generation === epoch) useCustomer.setState({cartSyncFailed:true,error:'Your cart changes could not be saved on this phone. Tap Retry in your cart.'});
    } finally { if (cartWorkerGeneration === generation) cartWorkerGeneration=-1; }
  });
  cartQueue=operation;
  return operation;
}

function resetFavoritesSync() {
  confirmedFavorites = [];
  favoriteDesired.clear();
  favoriteInflight.clear();
  favoriteChains.clear();
  favoriteFailed.clear();
}
function publishFavorites(userId: string) {
  if (useCustomer.getState().profile?.userId !== userId) return;
  useCustomer.setState({
    favorites: applyFavoriteDesires(confirmedFavorites, favoriteDesired),
    favoriteBusy: [...new Set([...favoriteDesired.keys(), ...favoriteInflight])],
  });
}
function persistConfirmedFavorites(userId: string) {
  return AsyncStorage.setItem(favoritesStorageKey(userId), JSON.stringify(confirmedFavorites));
}
async function readServerFavorites(token: string): Promise<string[]> {
  const favorites: string[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await customerApi.favorites(token, cursor);
    favorites.push(...page.items);
    if (page.nextCursor && seen.has(page.nextCursor)) throw new Error('Invalid favorites page.');
    if (page.nextCursor) seen.add(page.nextCursor);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return [...new Set(favorites)];
}
function confirmFavoriteIntent(userId: string, id: string, intent: boolean) {
  if (favoriteDesired.get(id) !== intent) return;
  favoriteDesired.delete(id);
  favoriteFailed.delete(id);
  const visible = new Set(confirmedFavorites);
  if (intent) visible.add(id);
  else visible.delete(id);
  confirmedFavorites = [...visible];
  // The save succeeded: refresh the account's Favorites product cache.
  invalidateFavoritesCache(userId);
  void persistConfirmedFavorites(userId).catch(() => undefined);
  publishFavorites(userId);
}
/** Serialize background writes per product; taps that have yet to be sent merge into the latest intent. */
function runFavoriteSync(userId: string, id: string, generation: number): Promise<void> {
  const previous = favoriteChains.get(id) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(() => favoriteWorker(userId, id, generation));
  favoriteChains.set(id, task);
  task.then(() => { if (favoriteChains.get(id) === task) favoriteChains.delete(id); },
    () => { if (favoriteChains.get(id) === task) favoriteChains.delete(id); });
  return task;
}
async function favoriteWorker(userId: string, id: string, generation: number): Promise<void> {
  const current = () => generation === epoch && useCustomer.getState().profile?.userId === userId;
  while (current()) {
    const intent = favoriteDesired.get(id);
    if (intent === undefined) return;
    favoriteInflight.add(id);
    publishFavorites(userId);
    try {
      await customerApi.setFavorite(await accessToken(), id, intent);
      if (!current()) return;
      confirmFavoriteIntent(userId, id, intent);
    } catch (error) {
      if (!current()) return;
      if (isDefinitiveFavoriteError(error)) {
        // A definitive rejection reverts only this product when the rejected intent is still current.
        if (favoriteDesired.get(id) === intent) {
          favoriteDesired.delete(id);
          favoriteFailed.set(id, intent);
          publishFavorites(userId);
        }
        useCustomer.setState({ favoriteError: 'Couldn’t save favorite.' });
        return;
      }
      // Ambiguous outcome (timeout, network, 5xx): reconcile against server state first.
      let reconciled = false;
      try {
        const server = await readServerFavorites(await accessToken());
        if (!current()) return;
        if (server.includes(id) === intent) {
          if (favoriteDesired.get(id) === intent) {
            favoriteDesired.delete(id);
            favoriteFailed.delete(id);
          }
          confirmedFavorites = server;
          invalidateFavoritesCache(userId);
          void persistConfirmedFavorites(userId).catch(() => undefined);
          publishFavorites(userId);
          reconciled = true;
        }
      } catch { /* Reconciliation failed; retry the latest intent below. */ }
      if (reconciled || !current()) continue;
      const latest = favoriteDesired.get(id);
      if (latest === undefined) return;
      try {
        await customerApi.setFavorite(await accessToken(), id, latest);
        if (!current()) return;
        confirmFavoriteIntent(userId, id, latest);
      } catch (retryError) {
        if (!current()) return;
        if (isDefinitiveFavoriteError(retryError)) {
          if (favoriteDesired.get(id) === latest) {
            favoriteDesired.delete(id);
            favoriteFailed.set(id, latest);
            publishFavorites(userId);
          }
        }
        // Ambiguous retries keep the latest intent so an explicit retry resumes the same change.
        useCustomer.setState({ favoriteError: 'Couldn’t save favorite.' });
        return;
      }
    } finally {
      favoriteInflight.delete(id);
      publishFavorites(userId);
    }
  }
}

export type LoadState = 'idle' | 'loading' | 'success' | 'error';
const beginLoad = (state: LoadState): LoadState => state === 'success' ? 'success' : 'loading';
const failedLoad = (state: LoadState): LoadState => state === 'success' ? 'success' : 'error';
const localMessages = new Set([
  'Your pending checkout could not be read. Please contact support before placing another order.',
  'Your pending cart changes could not be read. Please contact support.',
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

function readable(error: unknown, action = 'complete your request') {
  if (error instanceof Error && localMessages.has(error.message)) return error.message;
  return requestMessage(error, action);
}
async function safeCart(token: string) {
  try { return await customerApi.cart(token); }
  catch (error) { if (error instanceof ApiError && error.code === 'CART_NOT_FOUND') return null; throw error; }
}
type Status = 'loading' | 'signedOut' | 'signedIn' | 'unavailable';
type CustomerState = {
  status: Status; error: string | null; busy: boolean; cartBusy: boolean; cartSyncFailed:boolean; cartReady:boolean;
  pendingVariantIds: string[]; addressBusy: boolean; orderBusyId: string | null;
  checkoutPhase: CheckoutPhase; checkoutError:string | null; lastOrder:PlacementOrder | null;
  profile: CustomerProfile | null; addresses: CustomerAddress[]; selectedAddress: string | null; locationRequired: boolean;
  feeEstimate: FeeEstimate | null; feeLoading: boolean; feeError: string | null; reviewSlow: boolean;
  products: CatalogItem[]; cursor: string | null; cart: ServerCart | null; quote: QuoteResult | null;
  pendingPlacement: PendingPlacement | null; orders: CustomerOrder[]; subscriptions: CustomerSubscription[];
  pendingSubscription: PendingSubscription | null;
  pendingSubscriptionAction: PendingSubscriptionAction | null;
  favorites: string[]; favoritesLoaded: boolean; favoriteBusy: string[]; favoriteError: string | null;
  notifications: Notification[]; wallet: WalletBalances | null; ledger: WalletEntry[];
  catalogLoad: { addressId: string | null; state: LoadState };
  activityLoad: { orders: LoadState; subscriptions: LoadState };
  accountLoad: { wallet: LoadState; ledger: LoadState; notifications: LoadState };
  initialize: () => Promise<void>; load: () => Promise<void>; logout: () => Promise<void>;
  chooseAddress: (id: string) => Promise<void>; addAddress: (value: PendingCustomerAddress & Partial<Pick<NewCustomerAddress, 'lat' | 'lng'>>) => Promise<{id:string; locationNeeded:boolean; needsConfirmation:boolean; degraded:boolean; temporarilyUnavailable:boolean}>;
  confirmAddressLocation: (id: string, point: {lat:number; lng:number}) => Promise<{temporarilyUnavailable:boolean; needsConfirmation:boolean; degraded:boolean}>; refreshAddresses: () => Promise<void>; refreshDeliverySettings: () => Promise<boolean>;
  loadCatalog: (cursor?: string, options?: { force?: boolean }) => Promise<void>; updateCart: (id: string, delta: number, product?:CartProduct, acceptedPricePaise?:string) => Promise<void>; retryCart: () => Promise<void>;
  refreshCart: (options?:{silent?:boolean}) => Promise<void>; createQuote: () => Promise<void>; placeOrder: () => Promise<boolean>; checkPendingPlacement: () => Promise<void>;
  changeCoupon: (code:string | null) => Promise<void>;
  loadActivity: (options?:{silent?:boolean}) => Promise<void>; loadAccount: () => Promise<void>; readNotifications: () => Promise<void>;
  cancelOrder: (id: string) => Promise<boolean>; reorder: (id: string) => Promise<boolean>; clearError: () => void;
  createSubscription: (body?: SubscriptionCreateRequest) => Promise<boolean>;
  runSubscriptionAction: (request?:SubscriptionActionRequest) => Promise<boolean>;
  loadFavorites: () => Promise<void>; toggleFavorite: (id:string) => Promise<void>; retryFavorites: () => Promise<void>;
};

const blank = { profile: null, addresses: [], selectedAddress: null, locationRequired: true, feeEstimate: null as FeeEstimate | null, feeLoading: false, feeError: null as string | null, reviewSlow: false, products: [], cursor: null, cart: null, quote: null, pendingPlacement: null, pendingVariantIds: [] as string[], addressBusy: false, orderBusyId: null as string | null, checkoutPhase:'idle' as CheckoutPhase, checkoutError:null as string | null, lastOrder:null as PlacementOrder | null, pendingSubscription: null, pendingSubscriptionAction:null, favorites: [], favoritesLoaded:false, favoriteBusy:[] as string[], favoriteError:null as string | null, cartReady:true, orders: [], subscriptions: [], notifications: [], wallet: null, ledger: [],
  catalogLoad: { addressId: null, state: 'idle' as LoadState }, activityLoad: { orders: 'idle' as LoadState, subscriptions: 'idle' as LoadState },
  accountLoad: { wallet: 'idle' as LoadState, ledger: 'idle' as LoadState, notifications: 'idle' as LoadState } };
export const useCustomer = create<CustomerState>((set, get) => ({
  ...blank, status: 'loading', error: null, busy: false, cartBusy: false, cartSyncFailed:false, pendingVariantIds: [], addressBusy: false, orderBusyId: null,
  clearError: () => set({ error: null }),
  initialize: async () => {
    const generation = ++epoch;
    stopPlacementRecovery(); placementCheck=null; quoteCheck=null;
    cartQueue=Promise.resolve(); cartWorkerGeneration=-1; confirmedCart=null; pendingCartActions=[];
    resetFavoritesSync(); clearCatalogCache(); clearFeesCache();
    set({ cartReady:false });
    try {
      const signedIn = await restoreSession();
      if (generation !== epoch) return;
      if (!signedIn) { set({ status: 'signedOut', cartReady:true }); return; }
      await get().load();
    } catch (error) { if (generation === epoch) set({ status: 'unavailable', error: readable(error, 'load your account') }); }
  },
  load: async () => {
    const generation = epoch;
    set({ busy: true, error: null, cartReady: false });
    try {
      const token = await accessToken();
      const profile = await customerApi.profile(token);
      if (generation !== epoch) return;
      // Restore persisted recovery records before opening the shell; a damaged record fails closed.
      let pending: PendingPlacement | null = null;
      const raw = await AsyncStorage.getItem(pendingKey(profile.userId));
      const savedActions = await AsyncStorage.getItem(cartActionsKey(profile.userId));
      let restoredActions:CartOperation[] = [];
      if (savedActions) {
        try {
          const parsed:unknown=JSON.parse(savedActions);
          if (!Array.isArray(parsed) || !parsed.every(isCartOperation)) throw new Error('invalid cart actions');
          restoredActions=parsed;
        } catch { throw new Error('Your pending cart changes could not be read. Please contact support.'); }
      }
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
      // Verified identity opens the shell now; addresses, cart, favorites, and settings load independently.
      confirmedCart=null; pendingCartActions=restoredActions;
      set({ profile, status: 'signedIn', busy: false, cartReady: true,
        cart:projectCart(null,restoredActions,profile.userId), cartBusy:restoredActions.length>0,
        pendingVariantIds:[...new Set(restoredActions.map((action) => action.variantId))], cartSyncFailed:false,
        quote: null, pendingPlacement: pending, checkoutPhase:pending ? 'uncertain' : 'idle',
        pendingSubscription, pendingSubscriptionAction });
      if (pending) {stopPlacementRecovery();void get().checkPendingPlacement();}
      if (restoredActions.length) void startCartSync(profile.userId,generation);
      const [addressesSettled, cartSettled, settingsSettled] = await Promise.allSettled([
        customerApi.addresses(token), safeCart(token), fetchDeliverySettings(profile.userId, token).catch((): DeliverySettings => ({locationRequired:true})),
      ]);
      if (generation !== epoch || get().profile?.userId !== profile.userId) return;
      const cartValue = cartSettled.status === 'fulfilled' ? cartSettled.value : null;
      if (addressesSettled.status === 'fulfilled') {
        const addresses = addressesSettled.value;
        const chosen = addresses.find(x => x.isDefault)?.id ?? addresses.find(x => x.id === cartValue?.addressId)?.id ?? addresses[0]?.id ?? null;
        set({ addresses, selectedAddress: chosen });
      } else if (!get().addresses.length) {
        set({ error: readable(addressesSettled.reason, 'load addresses') });
      }
      if (cartSettled.status === 'fulfilled') {
        confirmedCart=cartValue;
        publishCart(profile.userId);
      } else if (!get().cart) {
        set({ error: readable(cartSettled.reason, 'load your cart') });
      }
      if (settingsSettled.status === 'fulfilled') set({ locationRequired: settingsSettled.value.locationRequired, ...(settingsSettled.value.feeEstimate ? { feeEstimate: settingsSettled.value.feeEstimate, feeError: null } : {}) });
      const chosenAddress = get().selectedAddress;
      await Promise.allSettled([get().loadFavorites(), ...(chosenAddress ? [get().loadCatalog()] : [])]);
    } catch (error) { if (generation === epoch) set({ status: 'unavailable', busy: false, error: readable(error, 'load your account') }); }
  },
  logout: async () => {
    const generation = ++epoch;
    stopPlacementRecovery(); placementCheck=null; quoteCheck=null;
    const userId = get().profile?.userId;
    set({busy:true,error:null});
    try {await unregisterPushBeforeSignOut(userId);}
    catch (error) {if (generation === epoch) set({busy:false,error:readable(error, 'sign out')});return;}
    cartQueue=Promise.resolve(); cartWorkerGeneration=-1; confirmedCart=null; pendingCartActions=[];
    resetFavoritesSync(); clearCatalogCache(); clearFeesCache();
    set({ ...blank, status: 'loading', error: null, busy: false, cartBusy: false, cartSyncFailed:false, pendingVariantIds: [], addressBusy: false, orderBusyId: null });
    try { await signOut(); if (generation === epoch) set({ status: 'signedOut' }); }
    catch (error) { if (generation === epoch) set({status:'unavailable',error:readable(error, 'sign out')}); }
  },
  chooseAddress: async id => {
    if (get().pendingPlacement || get().checkoutPhase === 'placing') {set({checkoutError:ORDER_CONFIRMATION_WAIT});return;}
    const generation = epoch;
    set({ addressBusy: true, error: null });
    try { const token = await accessToken(); await customerApi.selectDefaultAddress(token, id); if (generation !== epoch) return; set({ selectedAddress: id, products: [], cursor: null, quote: null }); void get().loadCatalog(); }
    catch (error) { if (generation === epoch) set({ error: readable(error, 'select your address') }); throw error; } finally { if (generation === epoch) set({ addressBusy: false }); }
  },
  addAddress: async value => {
    if (get().pendingPlacement || get().checkoutPhase === 'placing') throw new Error(ORDER_CONFIRMATION_WAIT);
    const generation = epoch;
    set({ addressBusy: true, error: null });
    try {
      const token = await accessToken();
      const hasPoint = typeof value.lat === 'number' && typeof value.lng === 'number';
      const service = await customerApi.serviceability(token, value.pincode).catch(error => {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403))
          throw new Error('Couldn’t check delivery coverage. Sign in again and try again.');
        if (error instanceof TypeError)
          throw new Error('Couldn’t check delivery coverage.');
        throw new Error('Couldn’t check delivery coverage.');
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
      void get().loadCatalog();
      return {id:address.id, locationNeeded:get().locationRequired && !address.point, needsConfirmation:result.needsConfirmation, degraded:result.degraded, temporarilyUnavailable:!service.serviceable};
    } finally { if (generation === epoch) set({ addressBusy: false }); }
  },
  refreshAddresses: async () => {
    const generation = epoch;
    const addresses = await customerApi.addresses(await accessToken());
    if (generation === epoch) set({addresses, selectedAddress:addresses.find(item => item.isDefault)?.id ?? get().selectedAddress});
  },
  refreshDeliverySettings: async () => {
    const generation = epoch;
    const userId = get().profile?.userId;
    if (!userId) {
      const { locationRequired } = await customerApi.deliverySettings(await accessToken());
      if (generation === epoch) set({ locationRequired });
      return locationRequired;
    }
    // A fresh shared entry applies instantly; a stale one stays visible while the refresh runs.
    const cached = getCachedDeliverySettings(userId);
    if (cached && isDeliverySettingsFresh(cached)) {
      if (generation === epoch) set({ locationRequired: cached.settings.locationRequired, ...(cached.settings.feeEstimate ? { feeEstimate: cached.settings.feeEstimate, feeError: null } : {}) });
      return cached.settings.locationRequired;
    }
    if (cached && generation === epoch) set({ locationRequired: cached.settings.locationRequired, ...(cached.settings.feeEstimate ? { feeEstimate: cached.settings.feeEstimate } : {}) });
    set({ feeLoading: true, feeError: null });
    try {
      const settings = await fetchDeliverySettings(userId, await accessToken());
      if (generation === epoch) set({ locationRequired: settings.locationRequired, feeLoading: false, ...(settings.feeEstimate ? { feeEstimate: settings.feeEstimate, feeError: null } : { feeError: null }) });
      return settings.locationRequired;
    } catch (error) {
      // A failed refresh keeps the last estimate visible; loading/retry feedback stays on the fees.
      if (generation !== epoch) throw error;
      set({ feeLoading: false, feeError: 'Couldn’t load delivery charges. Tap Retry.' });
      if (get().feeEstimate) return get().locationRequired;
      throw error;
    }
  },
  confirmAddressLocation: async (id, point) => {
    if (get().pendingPlacement || get().checkoutPhase === 'placing') throw new Error(ORDER_CONFIRMATION_WAIT);
    const generation = epoch;
    set({addressBusy:true,error:null});
    try {
      const address = get().addresses.find(item => item.id === id);
      if (!address) throw new Error('Address not found. Reopen your saved addresses and try again.');
      const token = await accessToken();
      const service = await customerApi.serviceability(token, address.pincode);
      const result = await customerApi.confirmAddressLocation(token, id, {...point, version:address.version});
      await customerApi.selectDefaultAddress(token, id);
      const addresses = await customerApi.addresses(token);
      if (generation !== epoch) throw new Error('Your session changed. Sign in and try again.');
      if (!addresses.some(item => item.id === result.address.id && item.point)) throw new Error('Couldn’t refresh the confirmed address.');
      set({addresses, selectedAddress:id, products:[], quote:null});
      await get().loadCatalog();
      return {temporarilyUnavailable:!service.serviceable,needsConfirmation:result.needsConfirmation,degraded:result.degraded};
    } finally {if (generation === epoch) set({addressBusy:false});}
  },
  loadCatalog: async (cursor, options) => {
    const addressId = get().selectedAddress; const generation = epoch;
    const userId = get().profile?.userId;
    if (!addressId || !get().addresses.some(item => item.id === addressId)) {set({products:[], cursor:null, catalogLoad:{addressId:null,state:'idle'}});return;}
    const request = ++catalogRequest;
    const query = userId ? { userId, addressId, kind: 'home' as const, key: '', cursor: cursor ?? null } : null;
    if (query && !cursor) {
      // A fresh shared-cache entry renders immediately without a network round trip.
      // Pull-to-refresh passes force to revalidate instead of serving the cache.
      const cached = getCachedCatalogPage(query);
      if (cached && isCatalogPageFresh(cached) && !options?.force) {
        set(state => ({ products: sameCatalogItems(state.products, cached.items) ? state.products : cached.items, cursor: cached.nextCursor, catalogLoad: { addressId, state: 'success' as LoadState } }));
        return;
      }
      // A stale entry stays visible while the refresh below runs.
      if (cached) set(state => ({ products: sameCatalogItems(state.products, cached.items) ? state.products : cached.items, cursor: cached.nextCursor, catalogLoad: { addressId, state: state.catalogLoad.state === 'success' ? 'success' as LoadState : 'loading' as LoadState } }));
    }
    const previous = get().catalogLoad;
    set({ catalogLoad: { addressId, state: previous.addressId === addressId ? beginLoad(previous.state) : 'loading' } });
    const current = () => generation === epoch && request === catalogRequest && addressId === get().selectedAddress;
    try {
      const page = query ? await fetchCatalogPage(query, await accessToken()) : await customerApi.catalog(await accessToken(), addressId, cursor);
      if (current()) set(state => {
        const items = cursor ? [...state.products, ...page.items.filter(x => !state.products.some(y => y.variantId === x.variantId))] : page.items;
        return { products: cursor || !sameCatalogItems(state.products, items) ? items : state.products, cursor: page.nextCursor, catalogLoad: { addressId, state: 'success' as LoadState } };
      });
    } catch (error) {
      if (current()) set({ error: readable(error, 'load products'), catalogLoad: { addressId, state: failedLoad(get().catalogLoad.state) } });
    }
  },
  refreshCart: async (options) => { const generation = epoch; try { await cartQueue.catch(() => {}); const previous=confirmedCart; const cart = await safeCart(await accessToken()); if (generation === epoch) {if (confirmedCart === previous || (cart && confirmedCart && cart.cartId === confirmedCart.cartId && cart.version >= confirmedCart.version)) confirmedCart=cart; const changed=previous?.cartId !== confirmedCart?.cartId || previous?.version !== confirmedCart?.version; const userId=get().profile?.userId; if (userId) publishCart(userId); if (changed) set({quote:null});} } catch (error) { if (generation === epoch && !options?.silent) set({ error: readable(error, 'load your cart') }); } },
  updateCart: async (id, delta, product, acceptedPricePaise) => {
    const state=get(), generation=epoch, userId=state.profile?.userId;
    if (!userId) {set({error:'Sign in to update your cart.'});return;}
    if (state.pendingPlacement || state.checkoutPhase === 'placing') {set({checkoutError:ORDER_CONFIRMATION_WAIT});return;}
    if (!state.cartReady) {set({error:'Restoring your cart. Try again in a moment.'});return;}
    const line=state.cart?.lines.find(item => item.variantId === id);
    const old=Number(line?.quantity ?? 0);
    if (delta > 0 && product && line && line.unitPricePaise !== product.sellingPaise) {set({error:'The price of this item changed. Review your cart to accept the new price before adding more.'});void get().refreshCart();return;}
    if ((!old && delta <= 0) || (!old && !product)) return;
    pendingCartActions=appendCartOperation(confirmedCart,pendingCartActions,userId,{id:Crypto.randomUUID(),variantId:id,delta,createdAt:Date.now(),...(product ? {product} : {}),...(acceptedPricePaise ? {acceptedPricePaise} : {})});
    cartRevision++;
    set({error:null,checkoutError:null,quote:null,cartSyncFailed:false}); publishCart(userId);
    try {await persistCartActions(userId);} catch {if (generation === epoch) set({cartSyncFailed:true,error:'Your cart changes could not be saved on this phone. Tap Retry in your cart.'});return;}
    if (generation !== epoch) return;
    await startCartSync(userId,generation);
  },
  retryCart: async () => { const userId=get().profile?.userId; if (userId && pendingCartActions.length) {set({error:null,cartSyncFailed:false});await startCartSync(userId,epoch);} },
  changeCoupon: async code => {
    const generation = epoch;
    if (get().pendingPlacement || get().checkoutPhase === 'placing') {set({checkoutError:ORDER_CONFIRMATION_WAIT});return;}
    const operation = cartQueue.catch(() => {}).then(async () => {
      if (generation !== epoch) return;
      const state = get();
      if (!state.cartReady) {set({error:'Restoring your cart. Try again in a moment.'});return;}
      if (state.pendingPlacement || state.checkoutPhase === 'placing' || pendingCartActions.length || !state.cart || state.cart.addressId !== state.selectedAddress) {set({error:'Review your cart and any pending order first.'});return;}
      set({cartBusy:true,error:null,quote:null});
      try {
        const token = await accessToken();
        const updated = code ? await customerApi.applyCoupon(token,code.trim(),state.cart.version,Crypto.randomUUID()) : await customerApi.removeCoupon(token,state.cart.version,Crypto.randomUUID());
        if (generation === epoch) {confirmedCart=updated;publishCart(get().profile!.userId);}
      } catch (error) {if (generation === epoch) {if (error instanceof ApiError && error.code === 'CONCURRENT_MODIFICATION') {confirmedCart=await safeCart(await accessToken());const userId=get().profile?.userId;if (userId) publishCart(userId);}set({error:readable(error, 'update your coupon')});}}
      finally {if (generation === epoch) set({cartBusy:pendingCartActions.length>0});}
    });
    cartQueue = operation; await operation;
  },
  createQuote: async () => {
    if (get().pendingPlacement || get().checkoutPhase === 'placing') {set({checkoutError:ORDER_CONFIRMATION_WAIT});return;}
    // Review is single-flight: concurrent callers share the in-progress review.
    if (quoteCheck && quoteCheck.generation === epoch) return quoteCheck.promise;
    const operation = (async () => {
      const generation=epoch, revision=cartRevision;
      set({checkoutPhase:'reviewing',checkoutError:null,error:null,quote:null,reviewSlow:false});
      // Small inline feedback only when review takes longer than 300 ms; the estimate and cart stay visible.
      const slowTimer=setTimeout(() => { if (generation === epoch && get().checkoutPhase === 'reviewing') set({reviewSlow:true}); }, 300);
      if (slowTimer && typeof (slowTimer as unknown as { unref?: unknown }).unref === 'function') (slowTimer as unknown as { unref: () => void }).unref();
      try {
        await cartQueue.catch(() => {});
        if (generation !== epoch) return;
        if (revision !== cartRevision || pendingCartActions.length) throw new Error('Save your pending cart changes before reviewing your order.');
        const addressId=get().selectedAddress;
        if (!addressId || !get().cart?.lines.length) throw new Error('Add items and select a delivery address first.');
        const required=await get().refreshDeliverySettings();
        if (required) {
          if (!get().addresses.find(item => item.id === addressId)?.point) throw new Error('Confirm the location at your delivery address before reviewing your order.');
          await requireLocationServices();
        }
        const token=await accessToken();
        const quote=await customerApi.quote(token,{addressId});
        // The additive quote cart comes from the same evaluation that built the quote; GET /cart is only a fallback.
        const cart=quote.cart ?? await safeCart(token);
        if (generation !== epoch) return;
        if (revision !== cartRevision || pendingCartActions.length || addressId !== get().selectedAddress) {
          set({checkoutError:'Your cart changed. Review your order again.'});return;
        }
        confirmedCart=cart;
        const userId=get().profile?.userId;
        if (userId) publishCart(userId);
        set({quote});
      } catch (error) {
        if (generation === epoch) set({checkoutError:readable(error, 'review your order')});
      } finally {
        clearTimeout(slowTimer);
        if (generation === epoch && get().checkoutPhase === 'reviewing') set({checkoutPhase:'idle',reviewSlow:false});
      }
    })();
    quoteCheck={generation:epoch,promise:operation};
    try { await operation; } finally { if (quoteCheck?.promise === operation) quoteCheck=null; }
  },
  placeOrder: async () => {
    if (get().checkoutPhase === 'placing' || get().checkoutPhase === 'reviewing') return false;
    const generation = epoch;
    set({checkoutPhase:'placing',checkoutError:null,error:null});
    let pending:PendingPlacement | null=null;
    let sent=false;
    try {
      const profile = get().profile; if (!profile) throw new Error('Sign in to order.');
      pending = get().pendingPlacement;
      if (!pending) {
        if (await get().refreshDeliverySettings()) {
          if (!get().addresses.find(item => item.id === get().selectedAddress)?.point) throw new Error('Confirm the location at your delivery address before reviewing your order.');
          await requireLocationServices();
        }
        const quote = get().quote;
        if (pendingCartActions.length) throw new Error('Save your pending cart changes before reviewing your order.');
        if (!quote || quote.quote.issues.length || Date.parse(quote.intentExpiresAt) <= Date.now()) throw new Error('Review a current checkout quote before ordering.');
        if (!quote.codAvailable) throw new Error('Cash on delivery is not available for this order.');
        pending = { userId: profile.userId, key: Crypto.randomUUID(), body: { quoteId: quote.quote.quoteId, intentId: quote.intentId, method: 'COD' } };
        await savePendingPlacement(pending);
        if (generation !== epoch) return false;
        set({ pendingPlacement: pending });
        if (get().quote?.quote.quoteId !== pending.body.quoteId || pendingCartActions.length) {
          await clearPendingPlacement(pending);
          set({pendingPlacement:null,quote:null});
          throw new Error('Your cart changed. Review your order again.');
        }
      }
      if (pending.userId !== profile.userId) throw new Error('This checkout belongs to a different account.');
      const token=await accessToken();
      if (generation !== epoch) return false;
      sent=true;
      const result = await customerApi.place(token, pending.body, pending.key);
      if (generation !== epoch) return true;
      if (!result?.order?.orderId || !result.order.status || !result.order.paymentStatus) throw new Error('INVALID_ORDER_RESPONSE');
      stopPlacementRecovery();
      set({lastOrder:result.order,pendingPlacement:null,quote:null,checkoutPhase:'idle',checkoutError:null,error:null});
      // Cleanup is awaited but never fails a confirmed order.
      await clearPendingPlacement(pending).catch(() => undefined);
      void get().refreshCart({silent:true});
      void get().loadActivity({silent:true});
      return true;
    } catch (error) {
      // Keep the exact request and key across ambiguous network failures; never create a duplicate.
      if (generation !== epoch) return false;
      if (pending && sent && isDefinitivePlacementError(error)) {
        try { await clearPendingPlacement(pending); set({pendingPlacement:null,quote:null,checkoutPhase:'idle'}); }
        catch {set({checkoutPhase:'uncertain'});}
        set({checkoutError:readable(error, 'place your order')});
      } else if (pending && get().pendingPlacement?.key === pending.key) {
        set({checkoutPhase:'uncertain',checkoutError:'We’re checking your order.'});
        void get().checkPendingPlacement();
      } else {
        set({checkoutPhase:'idle',checkoutError:readable(error, 'place your order')});
      }
      return false;
    } finally {
      if (generation === epoch && get().checkoutPhase === 'placing') set({checkoutPhase:get().pendingPlacement ? 'uncertain' : 'idle'});
    }
  },
  checkPendingPlacement: async () => {
    const pending=get().pendingPlacement, generation=epoch;
    if (!pending || pending.userId !== get().profile?.userId || get().checkoutPhase === 'placing') return;
    if (placementCheck?.key === pending.key && placementCheck.generation === generation) return placementCheck.promise;
    if (recoveryTimer) {clearTimeout(recoveryTimer);recoveryTimer=null;}
    if (!recoveryStarted) recoveryStarted=Date.now();
    set({checkoutPhase:'checking'});
    const operation=(async () => {
      try {
        const status=await customerApi.placementStatus(await accessToken(),pending.key);
        if (generation !== epoch || get().pendingPlacement?.key !== pending.key) return;
        if (status?.state === 'ORDER_FOUND' && status.order?.orderId && status.order.status && status.order.paymentStatus) {
          stopPlacementRecovery();
          set({lastOrder:status.order,pendingPlacement:null,quote:null,checkoutPhase:'idle',checkoutError:null,error:null});
          await clearPendingPlacement(pending).catch(() => undefined);
          void get().refreshCart({silent:true});
          void get().loadActivity({silent:true});
        } else if (get().checkoutPhase !== 'placing') set({checkoutPhase:'uncertain'});
      } catch {
        if (generation === epoch && get().pendingPlacement?.key === pending.key && get().checkoutPhase !== 'placing') set({checkoutPhase:'uncertain'});
      }
    })();
    placementCheck={key:pending.key,generation,promise:operation};
    try {await operation;} finally {
      if (placementCheck?.promise === operation) placementCheck=null;
      if (generation === epoch && get().pendingPlacement?.key === pending.key && get().checkoutPhase !== 'placing') schedulePlacementRecovery(pending,generation);
    }
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
      if (generation === epoch) set({error:readable(error, 'save your subscription')});
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
      if (generation === epoch) set({error:readable(error, 'save your subscription')});
      return false;
    } finally {if (generation === epoch) set({busy:false});}
  },
  loadFavorites: async () => {
    const generation = epoch;
    const userId = get().profile?.userId;
    if (userId && generation === epoch) {
      // Hydrate last-confirmed IDs first so the heart can respond before the network does.
      try {
        const raw = await AsyncStorage.getItem(favoritesStorageKey(userId));
        if (raw) {
          const hydrated = parseFavoriteIds(JSON.parse(raw));
          if (hydrated && generation === epoch && get().profile?.userId === userId) {
            confirmedFavorites = hydrated;
            publishFavorites(userId);
            set({ favoritesLoaded: true, favoriteError: null });
          }
        }
      } catch { /* Fall through to the network load. */ }
    }
    try {
      const token = await accessToken();
      // Merge additional ID pages as they arrive instead of waiting for the last page.
      const favorites:string[] = []; let cursor:string | undefined; const seen = new Set<string>();
      do {
        const page = await customerApi.favorites(token,cursor);
        favorites.push(...page.items);
        if (page.nextCursor && seen.has(page.nextCursor)) throw new Error('Invalid favorites page.');
        if (page.nextCursor) seen.add(page.nextCursor);
        cursor = page.nextCursor ?? undefined;
        if (userId && generation === epoch && get().profile?.userId === userId && cursor) {
          confirmedFavorites = [...new Set(favorites)];
          publishFavorites(userId);
          set({ favoritesLoaded: true });
        }
      } while (cursor);
      if (generation === epoch && (!userId || get().profile?.userId === userId)) {
        if (userId) {
          confirmedFavorites = [...new Set(favorites)];
          publishFavorites(userId);
          void persistConfirmedFavorites(userId).catch(() => undefined);
        } else {
          set({ favorites: [...new Set(favorites)] });
        }
        set({ favoritesLoaded:true, favoriteError:null });
      }
    } catch (error) {
      if (generation !== epoch) return;
      if (!get().favoritesLoaded) set({ favoritesLoaded:false, error:readable(error, 'load favorites') });
      else set({ favoriteError:'Couldn’t load favorites.' });
    }
  },
  toggleFavorite: async id => {
    const generation = epoch;
    const userId = get().profile?.userId;
    if (!userId || !get().favoritesLoaded) return;
    // The heart fills or clears on the tap; the write follows in the background.
    favoriteDesired.set(id, !get().favorites.includes(id));
    favoriteFailed.delete(id);
    publishFavorites(userId);
    set({ favoriteError: null });
    void runFavoriteSync(userId, id, generation);
  },
  retryFavorites: async () => {
    const generation = epoch;
    const userId = get().profile?.userId;
    if (!userId) return;
    set({ favoriteError: null });
    for (const [id, intent] of [...favoriteFailed]) {
      if (favoriteDesired.get(id) === undefined && generation === epoch) {
        favoriteDesired.set(id, intent);
        favoriteFailed.delete(id);
      }
    }
    publishFavorites(userId);
    const pending = [...new Set([...favoriteDesired.keys()])];
    if (!pending.length && !get().favoritesLoaded) { await get().loadFavorites(); return; }
    await Promise.all(pending.map(id => runFavoriteSync(userId, id, generation)));
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
          .catch(() => { if (current()) set(state => ({ error: 'Couldn’t load orders.', activityLoad: { ...state.activityLoad, orders: failedLoad(state.activityLoad.orders) } })); }),
        customerDetailsApi.subscriptions(token).then(result => { if (current()) set(state => ({ subscriptions: result.items, activityLoad: { ...state.activityLoad, subscriptions: 'success' } })); })
          .catch(() => { if (current()) set(state => ({ error: 'Couldn’t load subscriptions.', activityLoad: { ...state.activityLoad, subscriptions: failedLoad(state.activityLoad.subscriptions) } })); }),
      ]);
    } catch (error) { if (current()) set(state => ({ error: readable(error, 'load orders'), activityLoad: { orders: failedLoad(state.activityLoad.orders), subscriptions: failedLoad(state.activityLoad.subscriptions) } })); }
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
          .catch(() => { if (current()) set(state => ({ error: 'Couldn’t load your wallet.', accountLoad: { ...state.accountLoad, wallet: failedLoad(state.accountLoad.wallet) } })); }),
        customerDetailsApi.ledger(token).then(result => { if (current()) set(state => ({ ledger: result.items, accountLoad: { ...state.accountLoad, ledger: 'success' } })); })
          .catch(() => { if (current()) set(state => ({ error: 'Couldn’t load wallet activity.', accountLoad: { ...state.accountLoad, ledger: failedLoad(state.accountLoad.ledger) } })); }),
        customerDetailsApi.notifications(token).then(result => { if (current()) set(state => ({ notifications: result.items, accountLoad: { ...state.accountLoad, notifications: 'success' } })); })
          .catch(() => { if (current()) set(state => ({ error: 'Couldn’t load notifications.', accountLoad: { ...state.accountLoad, notifications: failedLoad(state.accountLoad.notifications) } })); }),
      ]);
    } catch (error) { if (current()) set(state => ({ error: readable(error, 'load your account'), accountLoad: { wallet: failedLoad(state.accountLoad.wallet), ledger: failedLoad(state.accountLoad.ledger), notifications: failedLoad(state.accountLoad.notifications) } })); }
  },
  readNotifications: async () => { try { await customerDetailsApi.readNotifications(await accessToken()); await get().loadAccount(); } catch (error) { set({ error: readable(error, 'update notifications') }); } },
  cancelOrder: async id => { set({ orderBusyId: id, error: null }); try { await customerDetailsApi.cancel(await accessToken(), id, 'Customer request', Crypto.randomUUID()); await get().loadActivity({silent:true}); return true; } catch (error) { set({ error: readable(error, 'cancel your order') }); return false; } finally { set({ orderBusyId: null }); } },
  reorder: async id => { if (get().pendingPlacement) {set({error:'Check your pending order before changing the cart.'});return false;} set({ orderBusyId: id, error: null }); try { const result = await customerDetailsApi.reorder(await accessToken(), id, Crypto.randomUUID()); await get().refreshCart({silent:true}); if (result.issues.length) { set({ error: 'Couldn’t reorder your items. Review your cart.' }); return false; } return true; } catch (error) { set({ error: readable(error, 'reorder items') }); return false; } finally { set({ orderBusyId: null }); } },
}));
