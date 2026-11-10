export interface StoreStatusInput {
  storeId: string;
  actorId: string;
  status: 'ONLINE' | 'PAUSED';
  reason?: string;
  admin: boolean;
  correlationId: string;
}
export interface StoreManagement {
  setStatus(input: StoreStatusInput): Promise<void>;
}
