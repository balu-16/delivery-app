import { randomBytes } from 'node:crypto';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import { lockActiveCustomer } from '../../identity/contracts/account-lock.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { WalletSpender } from '../../wallet/contracts/wallet.js';
import {
  REFERRAL_HISTORY_DEFAULT_LIMIT,
  REFERRAL_HISTORY_MAX_LIMIT,
  REFERRAL_INVITE_RATE_LIMIT_PER_HOUR,
  REFERRAL_REWARD_PAIRSE,
  historyCursor,
  isTrackedInviteCode,
  normalizeInviteLabel,
  normalizeReferralCode,
  type ReferralHistoryPage,
  type ReferralHistoryStatus,
  type ReferralInviteCreated,
  type ReferralView,
  type Referrals,
} from '../contracts/referrals.js';

/**
 * Rewards and the friend's entitlement commit with verified account creation.
 *
 * Assumed lead migration 068 shape (this code does not ship the migration):
 * `referral_invites(id uuid PK, referrer_id uuid FK users, code text UNIQUE,
 * label text NULL, created_at timestamptz DEFAULT clock_timestamp(),
 * claim_id uuid NULL UNIQUE FK referral_claims)`. Deviation must be reported
 * to the lead before integration; see plan3 §6(1).
 */
export class PostgresReferrals implements Referrals {
  constructor(
    private readonly db: Database,
    private readonly wallet: WalletSpender,
    private readonly config: AppConfig,
  ) {}

  /** Referral policy inside the caller transaction (shared advisory lock). */
  private async policy(tx: TransactionContext): Promise<{
    issuance: boolean;
    rewardPaise: string;
    expiryMonths: number;
  }> {
    const keys = [
      'referralIssuanceEnabled',
      'referralRewardPaise',
      'referralCreditExpiryMonths',
    ] as const;
    if (this.config.getMany) {
      const values = await this.config.getMany(keys, tx);
      return {
        issuance: values.referralIssuanceEnabled,
        rewardPaise: values.referralRewardPaise,
        expiryMonths: values.referralCreditExpiryMonths,
      };
    }
    const [issuance, rewardPaise, expiryMonths] = await Promise.all([
      this.config.get('referralIssuanceEnabled', tx),
      this.config.get('referralRewardPaise', tx),
      this.config.get('referralCreditExpiryMonths', tx),
    ]);
    return { issuance, rewardPaise, expiryMonths };
  }

  private async referralsEnabled(tx: TransactionContext): Promise<boolean> {
    const flag = await sql<{
      enabled: boolean;
    }>`SELECT enabled FROM feature_flags WHERE key='wallet_enabled' FOR SHARE`.execute(tx);
    if (flag.rows[0]?.enabled !== true) return false;
    const { issuance } = await this.policy(tx);
    return issuance === true;
  }
  async view(userId: string): Promise<ReferralView> {
    return transactionWithRetry(this.db, async (tx) => {
      await lockActiveCustomer(userId, tx);
      const verified = await sql<{
        email_verified: boolean;
      }>`SELECT email_verified FROM users WHERE id=${userId}::uuid`.execute(tx);
      if (!verified.rows[0]?.email_verified) throw new Error('EMAIL_NOT_VERIFIED');
      const { rewardPaise, expiryMonths } = await this.policy(tx);
      const enabled = await this.referralsEnabled(tx);
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
      const counts = await sql<{ referrals: string; pending: string; available: boolean }>`SELECT
        (SELECT count(*)::text FROM referral_claims WHERE referrer_id=${userId}::uuid) AS referrals,
        (SELECT count(*)::text FROM referral_invites WHERE referrer_id=${userId}::uuid AND claim_id IS NULL) AS pending,
        EXISTS(SELECT 1 FROM referral_claims WHERE friend_id=${userId}::uuid AND redeemed_order_id IS NULL) AS available`.execute(
        tx,
      );
      return {
        enabled,
        code: enabled ? (code ?? null) : null,
        successfulReferrals: Number(counts.rows[0]!.referrals),
        pendingReferrals: Number(counts.rows[0]!.pending),
        rewardPaise,
        rewardExpiryMonths: expiryMonths,
        freeDeliveryAvailable: counts.rows[0]!.available,
      };
    });
  }
  async claimForNewCustomer(
    rawCode: string,
    friendId: string,
    tx: TransactionContext,
  ): Promise<void> {
    const code = normalizeReferralCode(rawCode);
    if (isTrackedInviteCode(code)) {
      await this.claimWithInvite(code, friendId, tx);
      return;
    }
    await this.claimWithReusable(code, friendId, tx);
  }

  /**
   * Reusable permanent code path. Kept byte-identical in behavior to the pre-§6
   * implementation: flag first, then active/verified referrer join, then one
   * expiring promo credit. Replay for an existing friend is handled by the
   * bootstrap caller, never here, so the flag check cannot block a legacy retry.
   */
  private async claimWithReusable(
    code: string,
    friendId: string,
    tx: TransactionContext,
  ): Promise<void> {
    if (!(await this.referralsEnabled(tx))) throw new Error('REFERRALS_UNAVAILABLE');
    if (!/^[A-F0-9]{16}$/.test(code)) throw new Error('INVALID_REFERRAL_CODE');
    const result = await sql<{
      id: string;
    }>`SELECT u.id::text AS id FROM referral_codes r JOIN users u ON u.id=r.user_id
      WHERE r.code=${code} AND u.pool='CUSTOMER' AND u.status='ACTIVE' AND u.email_verified AND u.id<>${friendId}::uuid FOR SHARE OF u,r`.execute(
      tx,
    );
    const referrerId = result.rows[0]?.id;
    if (!referrerId) throw new Error('INVALID_REFERRAL_CODE');
    await this.applyClaim(code, referrerId, friendId, null, tx);
  }

  /**
   * Tracked invite path (plan3 §6(2)). Lock order preserves the bootstrap
   * transaction: friend row FOR UPDATE (caller) -> invite row FOR UPDATE ->
   * referrer user FOR SHARE. A matching retry (same friend) resolves through
   * the stored claim link before flag/earning checks; a used invite for another
   * friend is 409 REFERRAL_INVITE_USED.
   */
  private async claimWithInvite(
    code: string,
    friendId: string,
    tx: TransactionContext,
  ): Promise<void> {
    if (!/^INV-[A-F0-9]{32}$/.test(code)) throw new Error('INVALID_REFERRAL_CODE');
    const invite = await sql<{
      id: string;
      referrer_id: string;
      claim_id: string | null;
    }>`SELECT id::text AS id, referrer_id::text AS referrer_id, claim_id::text AS claim_id
      FROM referral_invites WHERE code=${code} FOR UPDATE`.execute(tx);
    const invited = invite.rows[0];
    if (!invited) throw new Error('INVALID_REFERRAL_CODE');
    if (invited.claim_id) {
      const linked = await sql<{
        friend_id: string;
      }>`SELECT friend_id::text AS friend_id FROM referral_claims WHERE id=${invited.claim_id}::uuid`.execute(
        tx,
      );
      if (linked.rows[0]?.friend_id === friendId) return;
      throw new Error('REFERRAL_INVITE_USED');
    }
    if (invited.referrer_id === friendId) throw new Error('INVALID_REFERRAL_CODE');
    if (!(await this.referralsEnabled(tx))) throw new Error('REFERRALS_UNAVAILABLE');
    const referrer = await sql<{
      id: string;
    }>`SELECT id::text AS id FROM users WHERE id=${invited.referrer_id}::uuid
      AND pool='CUSTOMER' AND status='ACTIVE' AND email_verified FOR SHARE`.execute(tx);
    if (!referrer.rows[0]) throw new Error('INVALID_REFERRAL_CODE');
    const permanent = await sql<{
      code: string;
    }>`SELECT code FROM referral_codes WHERE user_id=${invited.referrer_id}::uuid FOR SHARE`.execute(
      tx,
    );
    const permanentCode = permanent.rows[0]?.code;
    if (!permanentCode || !/^[A-F0-9]{16}$/.test(permanentCode))
      throw new Error('INVALID_REFERRAL_CODE');
    await this.applyClaim(permanentCode, invited.referrer_id, friendId, invited.id, tx);
  }

  /** Shared claim + credit + link. The caller holds the invite lock (or none for reusable). */
  private async applyClaim(
    permanentCode: string,
    referrerId: string,
    friendId: string,
    inviteId: string | null,
    tx: TransactionContext,
  ): Promise<void> {
    const id = uuidV7();
    // Policy read serializes with the claim/credit write (shared advisory
    // lock via AppConfig); the amount and India-time expiry are recorded on
    // the grant (wallet ledger delta + claim credit_expires_at) so history
    // stays accurate across later policy changes.
    const { rewardPaise, expiryMonths } = await this.policy(tx);
    const claim = await sql<{ credit_expires_at: Date }>`INSERT INTO referral_claims
      (id,referrer_id,friend_id,code,credit_expires_at,created_at)
      SELECT ${id}::uuid,${referrerId}::uuid,${friendId}::uuid,${permanentCode},
        ((t.created_at AT TIME ZONE 'Asia/Kolkata') + make_interval(months => ${expiryMonths})) AT TIME ZONE 'Asia/Kolkata',t.created_at
      FROM (SELECT clock_timestamp() AS created_at) t
      RETURNING credit_expires_at`.execute(tx);
    const expiresAt = claim.rows[0]!.credit_expires_at.toISOString();
    const credited = await this.wallet.credit({
      userId: referrerId,
      bucket: 'promo',
      amountPaise: rewardPaise,
      reason: 'PROMO_GRANT',
      refType: 'REFERRAL',
      refId: `referral:${id}`,
      expiresAt,
      tx,
    });
    if (!credited) throw new Error('RESOURCE_CONFLICT');
    if (inviteId) {
      const linked =
        await sql`UPDATE referral_invites SET claim_id=${id}::uuid WHERE id=${inviteId}::uuid AND claim_id IS NULL`.execute(
          tx,
        );
      if (!linked.numAffectedRows) throw new Error('REFERRAL_INVITE_USED');
    }
  }

  async history(
    userId: string,
    status: ReferralHistoryStatus,
    cursor?: string,
    limit?: number,
  ): Promise<ReferralHistoryPage> {
    if (status !== 'successful' && status !== 'pending') throw new Error('INVALID_PAGE');
    const bounded = limit ?? REFERRAL_HISTORY_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(bounded) || bounded < 1 || bounded > REFERRAL_HISTORY_MAX_LIMIT)
      throw new Error('INVALID_PAGE');
    const after = cursor ? historyCursor.decode(cursor, status, userId) : null;
    if (status === 'pending') return this.pendingHistory(userId, after, bounded);
    return this.successfulHistory(userId, after, bounded);
  }

  private async pendingHistory(
    userId: string,
    after: { timestamp: string; id: string } | null,
    limit: number,
  ): Promise<ReferralHistoryPage> {
    const rows = await sql<{
      id: string;
      label: string | null;
      code: string;
      created_at_text: string;
    }>`SELECT i.id::text AS id, i.label, i.code, i.created_at::text AS created_at_text
      FROM referral_invites i
      WHERE i.referrer_id=${userId}::uuid AND i.claim_id IS NULL
        ${after ? sql`AND (i.created_at, i.id) < (${after.timestamp}::timestamptz, ${after.id}::uuid)` : sql``}
      ORDER BY i.created_at DESC, i.id DESC LIMIT ${limit + 1}`.execute(this.db);
    const page = rows.rows.slice(0, limit);
    const items = page.map((row) => ({
      id: row.id,
      label: row.label,
      status: 'pending' as const,
      createdAt: new Date(row.created_at_text).toISOString(),
      inviteCode: row.code,
    }));
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.rows.length > limit && last
          ? historyCursor.encode('pending', userId, last.created_at_text, last.id)
          : null,
    };
  }

  private async successfulHistory(
    userId: string,
    after: { timestamp: string; id: string } | null,
    limit: number,
  ): Promise<ReferralHistoryPage> {
    const rows = await sql<{
      claim_id: string;
      invite_id: string | null;
      label: string | null;
      created_at_text: string;
      credit_expires_at: Date;
      reward_paise: string | null;
    }>`SELECT c.id::text AS claim_id, i.id::text AS invite_id, i.label,
        c.created_at::text AS created_at_text, c.credit_expires_at,
        l.delta_paise::text AS reward_paise
      FROM referral_claims c
      LEFT JOIN referral_invites i ON i.claim_id = c.id AND i.referrer_id = ${userId}::uuid
      LEFT JOIN LATERAL (
        SELECT w.delta_paise FROM wallet_ledger w
        WHERE w.ref_type = 'REFERRAL' AND w.ref_id = 'referral:' || c.id::text
          AND w.bucket = 'promo' AND w.reason = 'PROMO_GRANT'
        ORDER BY w.created_at, w.id LIMIT 1
      ) l ON true
      WHERE c.referrer_id = ${userId}::uuid
        ${after ? sql`AND (c.created_at, c.id) < (${after.timestamp}::timestamptz, ${after.id}::uuid)` : sql``}
      ORDER BY c.created_at DESC, c.id DESC LIMIT ${limit + 1}`.execute(this.db);
    const page = rows.rows.slice(0, limit);
    const items = page.map((row) => {
      const completedAt = new Date(row.created_at_text).toISOString();
      return {
        id: row.invite_id ?? row.claim_id,
        label: row.label,
        status: 'successful' as const,
        createdAt: completedAt,
        completedAt,
        rewardPaise: row.reward_paise ?? REFERRAL_REWARD_PAIRSE,
        creditExpiresAt: row.credit_expires_at.toISOString(),
      };
    });
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        rows.rows.length > limit && last
          ? historyCursor.encode('successful', userId, last.created_at_text, last.claim_id)
          : null,
    };
  }

  async createInvite(
    userId: string,
    label: string | undefined,
    tx: TransactionContext,
  ): Promise<ReferralInviteCreated> {
    await lockActiveCustomer(userId, tx);
    const verified = await sql<{
      email_verified: boolean;
    }>`SELECT email_verified FROM users WHERE id=${userId}::uuid`.execute(tx);
    if (!verified.rows[0]?.email_verified) throw new Error('EMAIL_NOT_VERIFIED');
    if (!(await this.referralsEnabled(tx))) throw new Error('REFERRALS_UNAVAILABLE');
    const normalizedLabel = normalizeInviteLabel(label);
    const recent = await sql<{ n: string }>`SELECT count(*)::text AS n FROM referral_invites
      WHERE referrer_id=${userId}::uuid AND created_at > clock_timestamp() - interval '1 hour'`.execute(
      tx,
    );
    if (Number(recent.rows[0]!.n) >= REFERRAL_INVITE_RATE_LIMIT_PER_HOUR)
      throw new Error('RATE_LIMITED');
    // Ensure the permanent code exists so a later claim can store it (plan §6(1)).
    const existing = await sql<{
      code: string;
    }>`SELECT code FROM referral_codes WHERE user_id=${userId}::uuid FOR SHARE`.execute(tx);
    if (!existing.rows[0]?.code) {
      let code: string | undefined;
      for (let attempt = 0; attempt < 5 && !code; attempt++) {
        const candidate = randomBytes(8).toString('hex').toUpperCase();
        const inserted = await sql<{
          code: string;
        }>`INSERT INTO referral_codes(user_id,code) VALUES(${userId}::uuid,${candidate}) ON CONFLICT DO NOTHING RETURNING code`.execute(
          tx,
        );
        code = inserted.rows[0]?.code;
      }
      if (!code) throw new Error('RESOURCE_CONFLICT');
    }
    let created: { id: string; code: string; created_at: Date } | undefined;
    for (let attempt = 0; attempt < 5 && !created; attempt++) {
      const code = `INV-${randomBytes(16).toString('hex').toUpperCase()}`;
      const inserted = await sql<{
        id: string;
        code: string;
        created_at: Date;
      }>`INSERT INTO referral_invites(id,referrer_id,code,label)
        VALUES(${uuidV7()}::uuid,${userId}::uuid,${code},${normalizedLabel})
        ON CONFLICT (code) DO NOTHING RETURNING id::text AS id, code, created_at`.execute(tx);
      created = inserted.rows[0];
    }
    if (!created) throw new Error('RESOURCE_CONFLICT');
    return {
      reference: created.id,
      code: created.code,
      createdAt: created.created_at.toISOString(),
    };
  }
}
