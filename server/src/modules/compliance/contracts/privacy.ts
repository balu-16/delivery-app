export const PRIVACY_OPERATIONS = Symbol('PRIVACY_OPERATIONS');
export interface PrivacyOperations {
  requestWorkforce(actorId: string, userId: string): Promise<string>;
  approveWorkforce(actorId: string, approvalId: string): Promise<void>;
  statusForCustomer(userId: string): Promise<unknown>;
  adminStatus(requestId: string): Promise<unknown>;
  adminList(
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  retry(actorId: string, requestId: string): Promise<void>;
  createHold(actorId: string, userId: string, reason: string): Promise<string>;
  releaseHold(actorId: string, holdId: string, reason: string): Promise<void>;
}
