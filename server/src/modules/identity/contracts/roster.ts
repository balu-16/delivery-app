export interface StaffMember {
  userId: string;
  name: string;
  role: 'STORE_MANAGER';
}

export const IDENTITY_ROSTER = Symbol('IDENTITY_ROSTER');
export interface IdentityRoster {
  /** Store staff roster for fulfillment views; bounded keyset pages. */
  storeStaff(
    storeId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{ items: StaffMember[]; nextCursor: string | null }>;
}
