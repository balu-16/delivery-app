export interface AddressDraft {
  line1: string;
  line2?: string;
  landmark?: string;
  pincode: string;
  contactName: string;
  contactPhone: string;
  point: { lat: number; lng: number };
}
export interface Address extends AddressDraft {
  id: string;
  isDefault: boolean;
  version: string;
}
export interface AddressWriteResult {
  address: Address;
  needsConfirmation: boolean;
  degraded: boolean;
}
export interface AddressRepository {
  list(userId: string): Promise<Address[]>;
  create(
    userId: string,
    draft: AddressDraft,
    maxCount: number,
    makeDefault: boolean,
  ): Promise<Address>;
  update(
    userId: string,
    addressId: string,
    draft: AddressDraft,
    expectedVersion: string,
  ): Promise<Address>;
  setDefault(userId: string, addressId: string): Promise<void>;
  remove(userId: string, addressId: string): Promise<void>;
}
export interface AddressOperations {
  list(userId: string): Promise<Address[]>;
  create(userId: string, draft: AddressDraft, makeDefault?: boolean): Promise<AddressWriteResult>;
  update(
    userId: string,
    id: string,
    draft: AddressDraft,
    expectedVersion: string,
  ): Promise<AddressWriteResult>;
  setDefault(userId: string, id: string): Promise<void>;
  remove(userId: string, id: string): Promise<void>;
}
