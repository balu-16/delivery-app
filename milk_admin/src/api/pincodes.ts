import { get, patch, post } from './http'

export interface PincodeCoverage {
  id: string
  pincode: string
  storeId: string
  storeName: string
  storeStatus: string
  locality: string
  active: boolean
  version: string
  updatedAt: string
}

export const listDeliveryPincodes = () => get<PincodeCoverage[]>('/v1/admin/delivery-pincodes')
export const addDeliveryPincodes = (input: {pincodes: string[]; storeId: string; locality: string}) =>
  post<void>('/v1/admin/delivery-pincodes', input)
export const updateDeliveryPincode = (id: string, input: {storeId: string; locality: string; active: boolean; version: string}) =>
  patch<void>(`/v1/admin/delivery-pincodes/${encodeURIComponent(id)}`, input)
