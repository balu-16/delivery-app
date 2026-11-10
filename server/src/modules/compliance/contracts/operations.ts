export const ADMIN_COMPLIANCE_OPERATIONS = Symbol('ADMIN_COMPLIANCE_OPERATIONS');
export interface AdminComplianceOperationsContract {
  list(
    kind: 'fraud' | 'reconciliation' | 'approval',
    cursor: string | undefined,
    limit: number,
  ): Promise<{ items: unknown[]; nextCursor: string | null }>;
  detail(kind: 'fraud' | 'reconciliation' | 'approval', id: string): Promise<unknown>;
  review(
    kind: 'fraud' | 'reconciliation' | 'approval',
    id: string,
    actor: string,
    decision: string,
    reason: string,
  ): Promise<void>;
}
export const ADMIN_QUEUE_OPERATIONS = Symbol('ADMIN_QUEUE_OPERATIONS');
export interface AdminQueueOperationsContract {
  failed(concern: string): Promise<unknown>;
  replay(concern: string, id: string, actor: string, reason: string): Promise<void>;
  outbox(): Promise<unknown>;
  replayOutbox(eventId: string, consumer: string, actor: string, reason: string): Promise<void>;
}
