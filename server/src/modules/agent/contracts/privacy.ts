import type { TransactionContext } from '../../../platform/database/database.js';
export const AGENT_PRIVACY = Symbol('AGENT_PRIVACY');
export interface AgentPrivacy {
  hasActiveRuns(userId: string, tx: TransactionContext): Promise<boolean>;
  eraseForUser(userId: string, tx: TransactionContext): Promise<void>;
  deleteThread(userId: string, threadId: string): Promise<void>;
  deleteAllThreads(userId: string): Promise<void>;
  purgeExpired(days: number, batch: number): Promise<void>;
}
