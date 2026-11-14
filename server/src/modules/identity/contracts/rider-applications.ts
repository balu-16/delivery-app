import type { VerifiedIdentity } from './identity.js';

export interface RiderApplicationDocument {
  id: string;
  type: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface RiderApplicationView {
  userId: string;
  status: string;
  vehicleType: string | null;
  vehicleNo: string | null;
  homeStoreId: string | null;
  requiredDocuments: string[];
  documents: RiderApplicationDocument[];
}

export interface RiderApplications {
  bootstrap(
    identity: VerifiedIdentity,
  ): Promise<{ userId: string; status: string; groupPending: boolean }>;
  get(userId: string): Promise<RiderApplicationView>;
  getForAdmin(actorId: string, userId: string): Promise<RiderApplicationView>;
  stores(): Promise<Array<{ id: string; name: string; city: string }>>;
  selectStore(userId: string, storeId: string): Promise<void>;
  getForStore(actorId: string, userId: string): Promise<RiderApplicationView>;
  listForStore(
    actorId: string,
    storeId: string,
    before?: string,
    status?: string,
  ): Promise<{
    items: Array<{ userId: string; name: string; email: string; status: string }>;
    nextCursor: string | null;
  }>;
  list(
    actorId: string,
    before?: string,
    status?: string,
  ): Promise<{
    items: Array<{ userId: string; name: string; email: string; status: string }>;
    nextCursor: string | null;
  }>;
}

export const RIDER_APPLICATIONS = Symbol('RIDER_APPLICATIONS');
