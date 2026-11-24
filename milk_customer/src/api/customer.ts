import type { components, operations } from './customer.generated';
import { customerRequest } from './client';

/** Addressed catalog page size shared by Home, category, favorites, and search. */
export const CATALOG_PAGE_LIMIT = 24;

export type CustomerProfile = components['schemas']['CustomerProfileResponseDto'];
export type CustomerPrincipal = components['schemas']['PrincipalResponseDto'];
export type CustomerAddress = components['schemas']['AddressView'];
export type NewCustomerAddress = components['schemas']['CustomerAddressDto'];
export type PendingCustomerAddress = components['schemas']['PendingAddressDto'];
export type AddressResult = components['schemas']['AddressWriteView'];
export type CatalogPage = components['schemas']['CatalogPageView'];
export type CatalogItem = components['schemas']['ItemView'];
export type CatalogPreviewItem = components['schemas']['PreviewItemView'];
export type CatalogPreview = components['schemas']['CatalogPreviewView'];
export type Serviceability = components['schemas']['ServiceabilityView'];
type PutItem = components['schemas']['PutItemDto'];

export type ServerCart = components['schemas']['CartView'];
export type CartWriteResult = components['schemas']['CartWriteView'];
export type DeliverySettings = components['schemas']['DeliverySettingsView'];
export type FeeEstimate = components['schemas']['FeeEstimateView'];
export type FeeEstimateBand = components['schemas']['FeeEstimateBandView'];
export interface Coupon { code:string; kind:'PERCENT' | 'FLAT' | 'FREE_DELIVERY'; valuePaise:string; maxCapPaise:string | null; minOrderPaise:string }
export type QuoteRequest = operations['customerCheckoutQuote']['requestBody']['content']['application/json'];
export type PlaceRequest = operations['customerCheckoutPlace']['requestBody']['content']['application/json'];
export interface QuoteResult {
  quote: { quoteId: string; status: string; referralClaimId:string | null; lines: {variantId:string;unitPricePaise:string}[]; subtotalPaise: string; discountPaise: string; couponDiscountPaise: string; feeTotalPaise: string; taxTotalPaise: string; tipPaise: string; totalPaise: string; amountDuePaise: string; expiresAt: string; issues: { code: string; variantId?: string; detail?: string }[]; fees: { kind: string; amountPaise: string; taxPaise: string }[]; wallet: { promoPaise: string; cashPaise: string } | null };
  intentId: string; intentExpiresAt: string; codAvailable: boolean;
  /** Additive cart from the same evaluation that built the quote; absent on older servers. */
  cart?: ServerCart;
}
export interface PlacementOrder { orderId: string; orderNumber?: string; status: string; paymentStatus: string }
export type PlacementStatus = components['schemas']['PlacementStatusView'];
export interface PlaceResult { order: PlacementOrder; confirmation: 'CONFIRMED' | 'PENDING_PAYMENT'; payment: { attemptId: string } | null }
export interface WalletBalances { userId: string; cashPaise: string; promoPaise: string; version: string }
export interface AppContentItem {
  slot: 'CUSTOMER_HOME_BANNER' | 'CUSTOMER_OFFERS_CARD' | 'RIDER_HOME_ANNOUNCEMENT' | 'CUSTOMER_HELP' | 'RIDER_HELP';
  state: 'UNSET' | 'VISIBLE' | 'DISABLED' | 'INACTIVE';
  locale: 'en' | 'hi' | 'te' | null;
  title: string | null; body: string | null;
  imageMediaId: string | null; imageUrl: string | null;
  destination: string | null; version: number | null;
}

let previewInFlight: {token:string; request:Promise<CatalogPreview>} | null = null;
function catalogPreview(token:string):Promise<CatalogPreview> {
  if (previewInFlight?.token === token) return previewInFlight.request;
  const request=customerRequest<CatalogPreview>('/v1/customer/catalog/preview',{token}).finally(() => {
    if (previewInFlight?.request === request) previewInFlight=null;
  });
  previewInFlight={token,request};
  return request;
}

export const customerApi = {
  bootstrap: (idToken: string, referralCode?:string, signal?: AbortSignal) => customerRequest<CustomerPrincipal>('/v1/customer/auth/bootstrap', { method: 'POST', token: idToken, ...(referralCode ? {body:{referralCode}} : {}), ...(signal ? {signal} : {}) }),
  profile: (token: string) => customerRequest<CustomerProfile>('/v1/customer/me', { token }),
  addresses: (token: string) => customerRequest<CustomerAddress[]>('/v1/customer/addresses', { token }),
  createAddress: (token: string, body: NewCustomerAddress) => customerRequest<AddressResult>('/v1/customer/addresses', { method: 'POST', token, body }),
  createPendingAddress: (token: string, body: PendingCustomerAddress, key: string) => customerRequest<AddressResult>('/v1/customer/addresses/pending', { method: 'POST', token, body, idempotencyKey: key }),
  confirmAddressLocation: (token: string, id: string, body: components['schemas']['ConfirmAddressLocationDto']) => customerRequest<AddressResult>(`/v1/customer/addresses/${encodeURIComponent(id)}/location`, { method: 'PATCH', token, body }),
  updateAddress: (token: string, id: string, body: components['schemas']['UpdateAddressDto']) => customerRequest<AddressResult>(`/v1/customer/addresses/${encodeURIComponent(id)}`, { method: 'PATCH', token, body }),
  selectDefaultAddress: (token: string, id: string) => customerRequest<void>(`/v1/customer/addresses/${encodeURIComponent(id)}/default`, { method: 'POST', token }),
  serviceability: (token: string, pincode: string) => customerRequest<Serviceability>(`/v1/customer/serviceability?pincode=${encodeURIComponent(pincode)}`, { token }),
  deliverySettings: (token: string) => customerRequest<DeliverySettings>('/v1/customer/delivery-settings', { token }),
  catalogPreview,
  catalog: (token: string, addressId: string, cursor?: string) => customerRequest<CatalogPage>(`/v1/customer/catalog/home?${new URLSearchParams({ addressId, limit: String(CATALOG_PAGE_LIMIT), ...(cursor ? { cursor } : {}) })}`, { token }),
  categories: (token: string, addressId: string) => customerRequest<{items:{id:string; name:string}[]}>(`/v1/customer/catalog/categories?${new URLSearchParams({addressId})}`, {token}),
  category: (token: string, addressId: string, category: string, cursor?: string) => customerRequest<CatalogPage>(`/v1/customer/catalog/categories/${encodeURIComponent(category)}/products?${new URLSearchParams({addressId,limit:String(CATALOG_PAGE_LIMIT),...(cursor ? {cursor} : {})})}`, {token}),
  product: (token: string, addressId: string, productId: string, cursor?: string) => customerRequest<CatalogPage>(
    `/v1/customer/catalog/products/${encodeURIComponent(productId)}?${new URLSearchParams({ addressId, limit: String(CATALOG_PAGE_LIMIT), ...(cursor ? { cursor } : {}) })}`, { token },
  ),
  favorites: (token: string, cursor?: string) => customerRequest<{items:string[];nextCursor:string | null}>(`/v1/customer/favorites${cursor ? `?${new URLSearchParams({cursor})}` : ''}`, {token}),
  favoriteProducts: (token: string, addressId: string, cursor?: string) => customerRequest<CatalogPage>(`/v1/customer/favorites/products?${new URLSearchParams({addressId,limit:String(CATALOG_PAGE_LIMIT),...(cursor ? {cursor} : {})})}`, {token}),
  setFavorite: (token: string, productId:string, active:boolean) => customerRequest<void>(`/v1/customer/favorites/${encodeURIComponent(productId)}`, {token,method:active ? 'PUT' : 'DELETE'}),
  search: (token: string, addressId: string, query: string, cursor?: string) => customerRequest<CatalogPage>(`/v1/customer/search?${new URLSearchParams({ addressId, q: query, limit:String(CATALOG_PAGE_LIMIT), ...(cursor ? {cursor} : {}) })}`, { token }),
  cart: (token: string) => customerRequest<ServerCart>('/v1/customer/cart', { token }),
  putItem: (token: string, variantId: string, body: PutItem, key: string) => customerRequest<CartWriteResult>(`/v1/customer/cart/items/${encodeURIComponent(variantId)}`, { method: 'PUT', token, body, idempotencyKey: key, timeoutMs:12000 }),
  coupons: (token:string,addressId:string) => customerRequest<{items:Coupon[]}>(`/v1/customer/coupons/available?${new URLSearchParams({addressId})}`, {token}),
  applyCoupon: (token:string,code:string,version:number,key:string) => customerRequest<ServerCart>('/v1/customer/cart/coupon', {token,method:'POST',body:{code,version},idempotencyKey:key}),
  removeCoupon: (token:string,version:number,key:string) => customerRequest<ServerCart>(`/v1/customer/cart/coupon?${new URLSearchParams({version:String(version)})}`, {token,method:'DELETE',idempotencyKey:key}),
  quote: (token: string, body: QuoteRequest) => customerRequest<QuoteResult>('/v1/customer/checkout/quote', { method: 'POST', token, body, timeoutMs:20000 }),
  place: (token: string, body: PlaceRequest, key: string) => customerRequest<PlaceResult>('/v1/customer/checkout/place', { method: 'POST', token, body, idempotencyKey: key, timeoutMs:30000 }),
  placementStatus: (token:string,key:string) => customerRequest<PlacementStatus>('/v1/customer/checkout/placement-status',{token,idempotencyKey:key}),
  wallet: (token: string) => customerRequest<WalletBalances>('/v1/customer/wallet', { token }),
  appContent: (token: string, locale?: string) => customerRequest<AppContentItem[]>(`/v1/customer/app-content${locale ? `?${new URLSearchParams({ locale })}` : ''}`, { token }),
};

export interface CustomerOrder {
  orderId: string; orderNumber: string; status: string; paymentStatus: string; totalPaise: string;
  placedAt: string; items: { id: string; variantId: string; name: string; orderedQty: string; unitPricePaise: string }[];
}
export interface ReferralView { enabled:boolean; code:string | null; successfulReferrals:number; rewardPaise:string; freeDeliveryAvailable:boolean }
export interface WalletEntry { id: string; bucket: string; deltaPaise: string; reason: string; createdAt: string }
export interface Page<T> { items: T[]; nextCursor: string | null }
export type Notification = components['schemas']['NotificationViewDto'];
export interface SupportTicket { id: string; category: string; status: string; created_at: string; order_id: string | null }
export interface SupportMessage { id: string; author_id: string; body: string; created_at: string }
export interface SupportProgress { type: 'ACKNOWLEDGED' | 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'; created_at: string }

export type OrderGroupFilter = 'active' | 'delivered' | 'cancelled';

export const customerDetailsApi = {
  orders: (token: string, group?: OrderGroupFilter | 'all', cursor?: string) => {
    const qs = new URLSearchParams();
    if (group && group !== 'all') qs.set('group', group);
    if (cursor) qs.set('cursor', cursor);
    const path = qs.toString() ? `/v1/customer/orders?${qs.toString()}` : '/v1/customer/orders';
    return customerRequest<Page<CustomerOrder>>(path, { token });
  },
  order: (token: string, id: string) => customerRequest<CustomerOrder>(`/v1/customer/orders/${encodeURIComponent(id)}`, { token }),
  tracking: (token: string, id: string) => customerRequest<components['schemas']['OrderTrackingView']>(`/v1/customer/orders/${encodeURIComponent(id)}/tracking`, { token }),
  deliveryCode: (token: string, id: string) => customerRequest<components['schemas']['DeliveryCodeView']>(`/v1/customer/orders/${encodeURIComponent(id)}/delivery-code`, { token }),
  cancel: (token: string, id: string, reason: string, key: string) => customerRequest<CustomerOrder>(`/v1/customer/orders/${encodeURIComponent(id)}/cancel`, { token, method: 'POST', body: { reason }, idempotencyKey: key }),
  reorder: (token: string, id: string, key: string) => customerRequest<{ cartId: string; issues: { code: string; variantId: string }[] }>(`/v1/customer/orders/${encodeURIComponent(id)}/reorder`, { token, method: 'POST', idempotencyKey: key }),
  // Subscription endpoints retired per plan3 §7 — no client remains. Retirement compat
  // ({items:[],nextCursor:null}, 410 SUBSCRIPTIONS_RETIRED) is handled at the call site if needed.
  notifications: (token: string) => customerRequest<Page<Notification>>('/v1/customer/notifications', { token }),
  notificationPreferences: (token: string) => customerRequest<{ category: string; enabled: boolean }[]>('/v1/customer/notification-preferences', { token }),
  setAssistantNotifications: (token: string, enabled: boolean) => customerRequest<{ category: string; enabled: boolean }[]>('/v1/customer/notification-preferences', { token, method: 'PATCH', body: { updates: [{ category: 'ASSISTANT_UPDATES', enabled }] } }),
  registerDevice: (token: string, deviceToken: string) => customerRequest<{registered:boolean}>('/v1/customer/device-tokens', {token, method:'POST', body:{token:deviceToken,platform:'ANDROID',identifierType:'FCM_TOKEN'}}),
  unregisterDevice: (token: string, deviceToken: string) => customerRequest<{removed:boolean}>('/v1/customer/device-tokens', {token, method:'DELETE', body:{token:deviceToken}}),
  readNotifications: (token: string) => customerRequest<{ updated: number }>('/v1/customer/notifications/read-all', { token, method: 'POST' }),
  readNotification: (token: string, id: string) => customerRequest<{ read: boolean }>(`/v1/customer/notifications/${encodeURIComponent(id)}/read`, { token, method: 'POST' }),
  ledger: (token: string) => customerRequest<Page<WalletEntry>>('/v1/customer/wallet/ledger', { token }),
  updateProfile: (token: string, name: string) => customerRequest<void>('/v1/customer/me', { token, method: 'PATCH', body: { name } }),
  tickets: (token: string) => customerRequest<Page<SupportTicket>>('/v1/customer/tickets', { token }),
  ticket: (token: string, id: string) => customerRequest<{ticket: SupportTicket; messages: SupportMessage[]; progress: SupportProgress[]; nextMessagesCursor: string | null}>(`/v1/customer/tickets/${encodeURIComponent(id)}`, { token }),
  createTicket: (token: string, body: string, key: string, signal?: AbortSignal) => customerRequest<{id: string}>('/v1/customer/tickets', {token, method: 'POST', body: { category: 'General', body }, idempotencyKey: key, signal}),
  ticketMessage: (token: string, id: string, body: string, key: string, signal?: AbortSignal) => customerRequest<{id: string}>(`/v1/customer/tickets/${encodeURIComponent(id)}/messages`, {token, method: 'POST', body: { body }, idempotencyKey: key, signal}),
  referral: (token: string, signal?: AbortSignal) => customerRequest<ReferralView>('/v1/customer/referrals', { token, signal }),
  unreadCount: (token: string, signal?: AbortSignal) => customerRequest<{ count: number }>('/v1/customer/notifications/unread-count', { token, signal }),
  appContent: (token: string, locale?: string) => customerRequest<AppContentItem[]>(`/v1/customer/app-content${locale ? `?${new URLSearchParams({ locale })}` : ''}`, { token }),
};

export type PlaceSuggestion = components['schemas']['SuggestionView'];
// TODO(lead): regenerate customer.generated.ts — server PlaceView gained optional
// `pincode` (6-digit); intersect here until the generated type includes it.
export type PlaceDetails = components['schemas']['PlaceView'];
export const customerPlacesApi = {
  autocomplete: (token: string, input: string, signal?: AbortSignal) => customerRequest<PlaceSuggestion[]>(`/v1/customer/places/autocomplete?${new URLSearchParams({ input })}`, { token, ...(signal ? { signal } : {}) }),
  details: (token: string, placeId: string, signal?: AbortSignal) => customerRequest<PlaceDetails>(`/v1/customer/places/details?${new URLSearchParams({ placeId })}`, { token, ...(signal ? { signal } : {}) }),
  reverse: (token: string, lat: number, lng: number, signal?: AbortSignal) => customerRequest<PlaceDetails[]>(`/v1/customer/places/reverse?${new URLSearchParams({ lat: String(lat), lng: String(lng) })}`, { token, ...(signal ? { signal } : {}) }),
};
