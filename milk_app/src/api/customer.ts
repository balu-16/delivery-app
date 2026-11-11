import type { components, operations } from './customer.generated';
import { customerRequest } from './client';

export type CustomerProfile = components['schemas']['ProfileResponseDto'];
export type CustomerPrincipal = components['schemas']['PrincipalResponseDto'];
export type CustomerAddress = components['schemas']['AddressView'];
export type NewCustomerAddress = components['schemas']['CustomerAddressDto'];
export type AddressResult = components['schemas']['AddressWriteView'];
export type CatalogPage = components['schemas']['CatalogPageView'];
export type CatalogItem = components['schemas']['ItemView'];
export type Serviceability = components['schemas']['ServiceabilityView'];
type PutItem = components['schemas']['PutItemDto'];

/** Server cart response types pending full response schemas in the backend OpenAPI. */
export interface ServerCart {
  cartId: string; userId: string; storeId: string; addressId: string; version: number; couponCode: string | null;
  lines: { variantId: string; productId?: string; productName?: string; variantName?: string; image?: string | null; quantity: string; unitPricePaise: string; mrpPaise: string; lineSubtotalPaise: string }[];
  issues: { code: string; variantId?: string; detail?: string }[];
}
export interface CartWriteResult { cart: ServerCart; clamped: boolean }
export interface Coupon { code:string; kind:'PERCENT' | 'FLAT' | 'FREE_DELIVERY'; valuePaise:string; maxCapPaise:string | null; minOrderPaise:string }
export type QuoteRequest = operations['customerCheckoutQuote']['requestBody']['content']['application/json'];
export type PlaceRequest = operations['customerCheckoutPlace']['requestBody']['content']['application/json'];
export interface QuoteResult {
  quote: { quoteId: string; status: string; referralClaimId:string | null; lines: {variantId:string;unitPricePaise:string}[]; subtotalPaise: string; discountPaise: string; couponDiscountPaise: string; feeTotalPaise: string; taxTotalPaise: string; tipPaise: string; totalPaise: string; amountDuePaise: string; expiresAt: string; issues: { code: string; variantId?: string; detail?: string }[]; fees: { kind: string; amountPaise: string; taxPaise: string }[]; wallet: { promoPaise: string; cashPaise: string } | null };
  intentId: string; intentExpiresAt: string; codAvailable: boolean;
}
export interface PlaceResult { order: { orderId: string; status: string; paymentStatus: string }; confirmation: 'CONFIRMED' | 'PENDING_PAYMENT'; payment: { attemptId: string } | null }
export interface WalletBalances { userId: string; cashPaise: string; promoPaise: string; version: string }

export const customerApi = {
  bootstrap: (idToken: string, referralCode?:string, signal?: AbortSignal) => customerRequest<CustomerPrincipal>('/v1/customer/auth/bootstrap', { method: 'POST', token: idToken, ...(referralCode ? {body:{referralCode}} : {}), ...(signal ? {signal} : {}) }),
  profile: (token: string) => customerRequest<CustomerProfile>('/v1/customer/me', { token }),
  addresses: (token: string) => customerRequest<CustomerAddress[]>('/v1/customer/addresses', { token }),
  createAddress: (token: string, body: NewCustomerAddress) => customerRequest<AddressResult>('/v1/customer/addresses', { method: 'POST', token, body }),
  selectDefaultAddress: (token: string, id: string) => customerRequest<void>(`/v1/customer/addresses/${encodeURIComponent(id)}/default`, { method: 'POST', token }),
  serviceability: (token: string, lat: number, lng: number) => customerRequest<Serviceability>(`/v1/customer/serviceability?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`, { token }),
  catalog: (token: string, addressId: string, cursor?: string) => customerRequest<CatalogPage>(`/v1/customer/catalog/home?${new URLSearchParams({ addressId, limit: '50', ...(cursor ? { cursor } : {}) })}`, { token }),
  categories: (token: string, addressId: string) => customerRequest<{items:{id:string; name:string}[]}>(`/v1/customer/catalog/categories?${new URLSearchParams({addressId})}`, {token}),
  category: (token: string, addressId: string, category: string, cursor?: string) => customerRequest<CatalogPage>(`/v1/customer/catalog/categories/${encodeURIComponent(category)}/products?${new URLSearchParams({addressId,limit:'50',...(cursor ? {cursor} : {})})}`, {token}),
  favorites: (token: string, cursor?: string) => customerRequest<{items:string[];nextCursor:string | null}>(`/v1/customer/favorites${cursor ? `?${new URLSearchParams({cursor})}` : ''}`, {token}),
  favoriteProducts: (token: string, addressId: string, cursor?: string) => customerRequest<CatalogPage>(`/v1/customer/favorites/products?${new URLSearchParams({addressId,limit:'50',...(cursor ? {cursor} : {})})}`, {token}),
  setFavorite: (token: string, productId:string, active:boolean) => customerRequest<void>(`/v1/customer/favorites/${encodeURIComponent(productId)}`, {token,method:active ? 'PUT' : 'DELETE'}),
  search: (token: string, addressId: string, query: string, cursor?: string) => customerRequest<CatalogPage>(`/v1/customer/search?${new URLSearchParams({ addressId, q: query, limit:'50', ...(cursor ? {cursor} : {}) })}`, { token }),
  cart: (token: string) => customerRequest<ServerCart>('/v1/customer/cart', { token }),
  putItem: (token: string, variantId: string, body: PutItem, key: string) => customerRequest<CartWriteResult>(`/v1/customer/cart/items/${encodeURIComponent(variantId)}`, { method: 'PUT', token, body, idempotencyKey: key }),
  coupons: (token:string,addressId:string) => customerRequest<{items:Coupon[]}>(`/v1/customer/coupons/available?${new URLSearchParams({addressId})}`, {token}),
  applyCoupon: (token:string,code:string,version:number,key:string) => customerRequest<ServerCart>('/v1/customer/cart/coupon', {token,method:'POST',body:{code,version},idempotencyKey:key}),
  removeCoupon: (token:string,version:number,key:string) => customerRequest<ServerCart>(`/v1/customer/cart/coupon?${new URLSearchParams({version:String(version)})}`, {token,method:'DELETE',idempotencyKey:key}),
  quote: (token: string, body: QuoteRequest) => customerRequest<QuoteResult>('/v1/customer/checkout/quote', { method: 'POST', token, body }),
  place: (token: string, body: PlaceRequest, key: string) => customerRequest<PlaceResult>('/v1/customer/checkout/place', { method: 'POST', token, body, idempotencyKey: key }),
  wallet: (token: string) => customerRequest<WalletBalances>('/v1/customer/wallet', { token }),
};

export interface CustomerOrder {
  orderId: string; orderNumber: string; status: string; paymentStatus: string; totalPaise: string;
  placedAt: string; items: { id: string; variantId: string; name: string; orderedQty: string; unitPricePaise: string }[];
}
export interface CustomerSubscription {
  id: string; status: string; variant_id: string; next_delivery_date: string | null;
}
export interface SubscriptionOptions { enabled: boolean; eligible: boolean; firstStartDate: string; slots: {id:string; name:string; startTime:string; endTime:string}[] }
export interface ReferralView { enabled:boolean; code:string | null; successfulReferrals:number; rewardPaise:string; freeDeliveryAvailable:boolean }
export interface SubscriptionCreateRequest { variantId:string; quantity:string; frequencyRule:{type:'DAILY' | 'ALTERNATE_DAYS'}; startDate:string; slotId:string; addressId:string }
export interface WalletEntry { id: string; bucket: string; deltaPaise: string; reason: string; createdAt: string }
export interface Page<T> { items: T[]; nextCursor: string | null }
export type Notification = components['schemas']['NotificationViewDto'];
export interface SupportTicket { id: string; category: string; status: string; created_at: string; order_id: string | null }
export interface SupportMessage { id: string; author_id: string; body: string; created_at: string }

export const customerDetailsApi = {
  orders: (token: string) => customerRequest<Page<CustomerOrder>>('/v1/customer/orders', { token }),
  order: (token: string, id: string) => customerRequest<CustomerOrder>(`/v1/customer/orders/${encodeURIComponent(id)}`, { token }),
  tracking: (token: string, id: string) => customerRequest<components['schemas']['OrderTrackingView']>(`/v1/customer/orders/${encodeURIComponent(id)}/tracking`, { token }),
  deliveryCode: (token: string, id: string) => customerRequest<components['schemas']['DeliveryCodeView']>(`/v1/customer/orders/${encodeURIComponent(id)}/delivery-code`, { token }),
  cancel: (token: string, id: string, reason: string, key: string) => customerRequest<CustomerOrder>(`/v1/customer/orders/${encodeURIComponent(id)}/cancel`, { token, method: 'POST', body: { reason }, idempotencyKey: key }),
  reorder: (token: string, id: string, key: string) => customerRequest<{ cartId: string; issues: { code: string; variantId: string }[] }>(`/v1/customer/orders/${encodeURIComponent(id)}/reorder`, { token, method: 'POST', idempotencyKey: key }),
  subscriptions: (token: string) => customerRequest<Page<CustomerSubscription>>('/v1/customer/subscriptions', { token }),
  subscriptionOptions: (token: string, addressId: string, variantId: string) => customerRequest<SubscriptionOptions>(`/v1/customer/subscriptions/options?${new URLSearchParams({addressId,variantId})}`, {token}),
  createSubscription: (token: string, body: SubscriptionCreateRequest, key: string) => customerRequest<{id:string; nextDeliveryDate:string; effectiveFrom:string}>('/v1/customer/subscriptions', {token, method:'POST', body, idempotencyKey:key}),
  subscriptionAction: (token: string, id: string, action: 'cancel' | 'resume' | 'skip' | 'pause', body: object, key: string) => customerRequest<unknown>(`/v1/customer/subscriptions/${encodeURIComponent(id)}/${action}`, {token, method:'POST', body, idempotencyKey:key}),
  notifications: (token: string) => customerRequest<Page<Notification>>('/v1/customer/notifications', { token }),
  registerDevice: (token: string, deviceToken: string) => customerRequest<{registered:boolean}>('/v1/customer/device-tokens', {token, method:'POST', body:{token:deviceToken,platform:'ANDROID',identifierType:'FCM_TOKEN'}}),
  unregisterDevice: (token: string, deviceToken: string) => customerRequest<{removed:boolean}>('/v1/customer/device-tokens', {token, method:'DELETE', body:{token:deviceToken}}),
  readNotifications: (token: string) => customerRequest<{ updated: number }>('/v1/customer/notifications/read-all', { token, method: 'POST' }),
  ledger: (token: string) => customerRequest<Page<WalletEntry>>('/v1/customer/wallet/ledger', { token }),
  updateProfile: (token: string, name: string) => customerRequest<void>('/v1/customer/me', { token, method: 'PATCH', body: { name } }),
  tickets: (token: string) => customerRequest<Page<SupportTicket>>('/v1/customer/tickets', { token }),
  ticket: (token: string, id: string) => customerRequest<{ticket: SupportTicket; messages: SupportMessage[]; nextMessagesCursor: string | null}>(`/v1/customer/tickets/${encodeURIComponent(id)}`, { token }),
  createTicket: (token: string, body: string, key: string) => customerRequest<{id: string}>('/v1/customer/tickets', {token, method: 'POST', body: { category: 'General', body }, idempotencyKey: key}),
  ticketMessage: (token: string, id: string, body: string, key: string) => customerRequest<{id: string}>(`/v1/customer/tickets/${encodeURIComponent(id)}/messages`, {token, method: 'POST', body: { body }, idempotencyKey: key}),
  referral: (token:string) => customerRequest<ReferralView>('/v1/customer/referrals',{token}),
};

export type PlaceSuggestion = components['schemas']['SuggestionView'];
export type PlaceDetails = components['schemas']['PlaceView'];
export const customerPlacesApi = {
  autocomplete: (token: string, input: string) => customerRequest<PlaceSuggestion[]>(`/v1/customer/places/autocomplete?${new URLSearchParams({ input })}`, { token }),
  details: (token: string, placeId: string) => customerRequest<PlaceDetails>(`/v1/customer/places/details?${new URLSearchParams({ placeId })}`, { token }),
};
