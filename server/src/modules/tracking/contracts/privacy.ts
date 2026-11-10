import type { TransactionContext } from '../../../platform/database/database.js';
export const TRACKING_PRIVACY = Symbol('TRACKING_PRIVACY');
export interface TrackingPrivacy {
  fence(userId: string, tx: TransactionContext): Promise<void>;
  eraseBatch(userId: string): Promise<boolean>;
}
