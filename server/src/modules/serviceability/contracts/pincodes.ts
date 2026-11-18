export const PINCODE_ADMIN = Symbol('PINCODE_ADMIN');

export interface PincodeCoverage {
  id: string;
  pincode: string;
  storeId: string;
  storeName: string;
  storeStatus: string;
  locality: string;
  active: boolean;
  version: string;
  updatedAt: string;
}

export interface PincodeAdministration {
  list(actorId: string): Promise<PincodeCoverage[]>;
  create(actorId: string, pincodes: string[], storeId: string, locality: string): Promise<void>;
  update(
    actorId: string,
    id: string,
    input: { storeId: string; locality: string; active: boolean; version: string },
  ): Promise<void>;
}
