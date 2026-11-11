import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import { lockActiveCustomer } from '../../identity/contracts/account-lock.js';
import type { WalletSpender } from '../../wallet/contracts/wallet.js';
import type { ReferralView, Referrals } from '../contracts/referrals.js';

/** Rewards and the friend's entitlement commit with verified account creation. */
export class PostgresReferrals implements Referrals {
  constructor(
    private readonly db: Database,
    private readonly wallet: WalletSpender,
  ) {}
  async view(userId: string): Promise<ReferralView> {
    return transactionWithRetry(this.db, async (tx) => {
      await lockActiveCustomer(userId, tx);
      const verified = await sql<{
        email_verified: boolean;
      }>`SELECT email_verified FROM users WHERE id=${userId}::uuid`.execute(tx);
      if (!verified.rows[0]?.email_verified) throw new Error('EMAIL_NOT_VERIFIED');
      const flag = await sql<{
        enabled: boolean;
      }>`SELECT enabled FROM feature_flags WHERE key='wallet_enabled'`.execute(tx);
      const enabled = flag.rows[0]?.enabled === true;
      // One code per customer. The account lock serializes concurrent requests for the same user.
      let code = (
        await sql<{
          code: string;
        }>`SELECT code FROM referral_codes WHERE user_id=${userId}::uuid`.execute(tx)
      ).rows[0]?.code;
      if (!code && enabled) {
        for (let attempt = 0; attempt < 5 && !code; attempt++) {
          const candidate = randomBytes(8).toString('hex').toUpperCase();
          const inserted = await sql<{
            code: string;
          }>`INSERT INTO referral_codes(user_id,code) VALUES(${userId}::uuid,${candidate}) ON CONFLICT DO NOTHING RETURNING code`.execute(
            tx,
          );
          code = inserted.rows[0]?.code;
        }
      }
      if (enabled && !code) throw new Error('RESOURCE_CONFLICT');
      const counts = await sql<{ referrals: string; available: boolean }>`SELECT
        (SELECT count(*)::text FROM referral_claims WHERE referrer_id=${userId}::uuid) AS referrals,
        EXISTS(SELECT 1 FROM referral_claims WHERE friend_id=${userId}::uuid AND redeemed_order_id IS NULL) AS available`.execute(
        tx,
      );
      return {
        enabled,
        code: enabled ? (code ?? null) : null,
        successfulReferrals: Number(counts.rows[0]!.referrals),
        rewardPaise: '1000',
        freeDeliveryAvailable: counts.rows[0]!.available,
      };
    });
  }
  async claimForNewCustomer(
    rawCode: string,
    friendId: string,
    tx: TransactionContext,
  ): Promise<void> {
    const flag = await sql<{
      enabled: boolean;
    }>`SELECT enabled FROM feature_flags WHERE key='wallet_enabled' FOR SHARE`.execute(tx);
    if (flag.rows[0]?.enabled !== true) throw new Error('REFERRALS_UNAVAILABLE');
    const code = rawCode.trim().toUpperCase();
    if (!/^[A-F0-9]{16}$/.test(code)) throw new Error('INVALID_REFERRAL_CODE');
    const result = await sql<{
      id: string;
    }>`SELECT u.id::text AS id FROM referral_codes r JOIN users u ON u.id=r.user_id
      WHERE r.code=${code} AND u.pool='CUSTOMER' AND u.status='ACTIVE' AND u.email_verified AND u.id<>${friendId}::uuid FOR SHARE OF u,r`.execute(
      tx,
    );
    const referrerId = result.rows[0]?.id;
    if (!referrerId) throw new Error('INVALID_REFERRAL_CODE');
    const id = uuidV7();
    const claim = await sql<{ credit_expires_at: Date }>`INSERT INTO referral_claims
      (id,referrer_id,friend_id,code,credit_expires_at,created_at)
      SELECT ${id}::uuid,${referrerId}::uuid,${friendId}::uuid,${code},
        ((t.created_at AT TIME ZONE 'Asia/Kolkata') + interval '1 month') AT TIME ZONE 'Asia/Kolkata',t.created_at
      FROM (SELECT clock_timestamp() AS created_at) t
      RETURNING credit_expires_at`.execute(tx);
    const expiresAt = claim.rows[0]!.credit_expires_at.toISOString();
    const credited = await this.wallet.credit({
      userId: referrerId,
      bucket: 'promo',
      amountPaise: '1000',
      reason: 'PROMO_GRANT',
      refType: 'REFERRAL',
      refId: `referral:${id}`,
      expiresAt,
      tx,
    });
    if (!credited) throw new Error('RESOURCE_CONFLICT');
  }
}
