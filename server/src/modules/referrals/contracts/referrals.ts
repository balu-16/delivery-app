import type { TransactionContext } from '../../../platform/database/database.js';
export const REFERRALS = Symbol('REFERRALS');
export interface ReferralView {
  enabled: boolean;
  code: string | null;
  successfulReferrals: number;
  rewardPaise: string;
  freeDeliveryAvailable: boolean;
}
export interface Referrals {
  view(userId: string): Promise<ReferralView>;
  claimForNewCustomer(code: string, friendId: string, tx: TransactionContext): Promise<void>;
}
