import type { Json, TransactionContext } from '../../../platform/database/database.js';

/** Policy is supplied by trusted application code, never by the request caller. */
export interface ApprovalAction {
  readonly version: number;
  readonly makerRole: string;
  readonly checkerRole: string;
  readonly ttlSeconds: number;
  validate(payload: Json): boolean;
  execute(
    tx: TransactionContext,
    payload: Json,
    executionKey: string,
    checkerId: string,
  ): Promise<void>;
}
export interface ApprovalExecutor {
  request(makerId: string, action: string, payload: Json): Promise<string>;
  approve(checkerId: string, requestId: string): Promise<void>;
}
export interface ApprovalFactory {
  create(actions: Readonly<Record<string, ApprovalAction>>): ApprovalExecutor;
}
export const APPROVAL_FACTORY = Symbol('APPROVAL_FACTORY');
