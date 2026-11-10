import { sql } from 'kysely';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { EventEnvelope } from '../../../platform/outbox/outbox.js';
import { parseMoney } from '../../../common/money/money.js';
import type { WalletSpender } from '../contracts/wallet.js';
import { WalletPrimitives } from './postgres-wallet.js';

/**
 * Promo expiry (Section 19): unspent lot remainders are written off FIFO by
 * grant time through a ledger row (PROMO_EXPIRY) under the account lock, so
 * the ledger always reconciles with the balance and the sum of lot remainders.
 * The sweep is idempotent and safe to run twice or late.
 */
export class WalletExpiryService {
  constructor(
    private readonly db: Database,
    private readonly primitives: WalletPrimitives,
    private readonly spender: WalletSpender,
  ) {}
  async expirePromoLots(limit = 100): Promise<number> {
    const due = await this.db.transaction().execute(async (tx) => {
      const rows = await sql<{
        id: string;
        account_id: string;
        remaining_paise: string;
      }>`SELECT id,account_id,remaining_paise::text AS remaining_paise
        FROM wallet_promo_lots WHERE state='ACTIVE' AND remaining_paise>0 AND expires_at IS NOT NULL AND expires_at <= clock_timestamp()
        ORDER BY expires_at,id LIMIT ${limit} FOR UPDATE SKIP LOCKED`.execute(tx);
      return rows.rows;
    });
    let processed = 0;
    for (const lot of due) {
      const done = await transactionWithRetry(this.db, async (tx) =>
        this.expireOne(tx, lot.id, lot.account_id),
      );
      if (done) processed += 1;
    }
    return processed;
  }
  private async expireOne(
    tx: TransactionContext,
    lotId: string,
    accountId: string,
  ): Promise<boolean> {
    const locked = await sql<{
      id: string;
      cash_balance_paise: bigint;
      promo_balance_paise: bigint;
      version: bigint;
    }>`SELECT a.id,a.cash_balance_paise,a.promo_balance_paise,a.version
      FROM wallet_accounts a JOIN wallet_promo_lots lot ON lot.account_id=a.id
      WHERE lot.id=${lotId}::uuid AND a.id=${accountId}::uuid FOR UPDATE OF a`.execute(tx);
    const row = locked.rows[0];
    if (!row) return false;
    const lots = await sql<{
      remaining_paise: string;
    }>`SELECT remaining_paise::text FROM wallet_promo_lots
      WHERE id=${lotId}::uuid AND state='ACTIVE' AND expires_at <= clock_timestamp() FOR UPDATE`.execute(
      tx,
    );
    if (!lots.rows[0]) return false;
    const remaining = parseMoney(lots.rows[0].remaining_paise);
    if (remaining === 0n) return false;
    const applied = await this.primitives.insertLedgerRow(tx, {
      accountId: row.id,
      bucket: 'promo',
      deltaPaise: `-${remaining}`,
      reason: 'PROMO_EXPIRY',
      refType: 'LOT',
      refId: lotId,
      balanceAfter: BigInt(row.promo_balance_paise) - remaining,
    });
    if (!applied) return false;
    await sql`UPDATE wallet_promo_lots SET remaining_paise=0,state='EXPIRED' WHERE id=${lotId}::uuid AND state='ACTIVE'`.execute(
      tx,
    );
    await this.primitives.applyBalance(tx, row.id, BigInt(row.version), 0n, -remaining);
    return true;
  }
}

/**
 * Wallet effects of verified payment events. The consumer name is `wallet`;
 * dedupe comes from `processed_events` plus ledger uniqueness, so a replayed
 * event or a duplicate capture credits exactly once.
 */
export class WalletEventConsumer {
  static readonly CONSUMER = 'wallet';
  constructor(
    private readonly primitives: WalletPrimitives,
    private readonly spender: WalletSpender,
  ) {}
  async handle(tx: TransactionContext, event: EventEnvelope): Promise<void> {
    if (event.eventType === 'payments.topup.captured') await this.creditTopup(tx, event.payload);
    else if (event.eventType === 'payments.refund.settled')
      await this.settleRefund(tx, event.payload);
    // Unknown event types are ignored: consumers only apply their own schema.
  }
  private async creditTopup(tx: TransactionContext, payload: unknown): Promise<void> {
    const body = payload as {
      userId?: string | null;
      amountPaise?: string;
      attemptId?: string;
    };
    if (!body.userId || !body.attemptId || typeof body.amountPaise !== 'string')
      throw new Error('INVALID_TOPUP_EVENT');
    await this.spender.credit({
      userId: body.userId,
      bucket: 'cash',
      amountPaise: body.amountPaise,
      reason: 'TOPUP_CREDIT',
      refType: 'TOPUP_ATTEMPT',
      refId: body.attemptId,
      tx,
    });
  }
  private async settleRefund(tx: TransactionContext, payload: unknown): Promise<void> {
    const body = payload as {
      sourceType?: string;
      sourceId?: string;
      destination?: string;
      amountPaise?: string;
      refundId?: string;
      userId?: string | null;
    };
    if (!body.refundId || !body.destination || typeof body.amountPaise !== 'string')
      throw new Error('INVALID_REFUND_EVENT');
    if (body.destination !== 'WALLET') return;
    if (body.sourceType === 'WALLET_DEBIT') {
      if (!body.sourceId) throw new Error('INVALID_REFUND_EVENT');
      // The original spend is restored once; provenance stays on the buckets.
      await this.spender.reverseSpend(body.sourceId, tx, {
        amountPaise: body.amountPaise,
        reversalReference: body.refundId,
      });
      return;
    }
    if (!body.userId) throw new Error('INVALID_REFUND_EVENT');
    await this.spender.credit({
      userId: body.userId,
      bucket: 'cash',
      amountPaise: body.amountPaise,
      reason: 'REFUND_CREDIT',
      refType: 'REFUND',
      refId: body.refundId,
      tx,
    });
  }
}
