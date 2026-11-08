import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { transactionWithRetry, type Database } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { PaymentOrderOperations } from '../../payments/contracts/payments.js';
import type { WalletTopupIntent, WalletTopups } from '../contracts/wallet.js';
import { parseMoney } from '../../../common/money/money.js';
import { WalletPrimitives } from './postgres-wallet.js';
import { lockActiveCustomer } from '../../identity/contracts/account-lock.js';

/** Business month windows run in Asia/Kolkata (Section 4 time rules). */
const IST_OFFSET_MINUTES = 330;
export function istMonthWindow(now: Date): [Date, Date] {
  const ist = new Date(now.getTime() + IST_OFFSET_MINUTES * 60_000);
  const start = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - IST_OFFSET_MINUTES * 60_000;
  const end =
    Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1) - IST_OFFSET_MINUTES * 60_000;
  return [new Date(start), new Date(end)];
}
/** Derived references stay within the documented receipt limit (<= 40 chars). */
export function topupReference(intentId: string): string {
  return `topup-${intentId.replaceAll('-', '')}`;
}

/**
 * Top-up intents (Section 19): a durable payment attempt plus gateway order is
 * created within the configured per-transaction and monthly (IST) caps; the
 * wallet is credited only by the wallet module's consumer of the verified
 * capture event, never from a client callback. Monthly usage counts credited
 * top-ups plus still-open attempts; failed attempts release no capacity. The
 * account row lock serialises concurrent creations for one user.
 */
export class WalletTopupService implements WalletTopups {
  constructor(
    private readonly db: Database,
    private readonly primitives: WalletPrimitives,
    private readonly orders: PaymentOrderOperations,
    private readonly config: AppConfig,
    private readonly publicKeyId: string | null,
    private readonly provider: 'fake' | 'razorpay',
  ) {}
  async create(
    userId: string,
    amountPaise: string,
    opts?: { intentId?: string },
  ): Promise<WalletTopupIntent> {
    const amount = parseMoney(amountPaise);
    const intentId = opts?.intentId ?? uuidV7();
    const intent = await transactionWithRetry(this.db, async (tx) => {
      await lockActiveCustomer(userId, tx);
      if (!(await this.primitives.walletEnabled(tx))) throw new Error('WALLET_DISABLED');
      const account = await this.primitives.lockAccount(tx, userId);
      const existing = await sql<{
        operation_reference: string;
        user_id: string;
        amount_paise: string;
      }>`SELECT operation_reference,user_id::text,amount_paise::text FROM payment_attempts WHERE operation_reference=${topupReference(intentId)}`.execute(
        tx,
      );
      if (existing.rows[0]) {
        if (existing.rows[0].user_id !== userId || existing.rows[0].amount_paise !== amountPaise)
          throw new Error('RESOURCE_CONFLICT');
        return existing.rows[0].operation_reference;
      }
      const [minPaise, maxPaise, monthlyPaise] = await Promise.all([
        this.config.get('topupMinPaise'),
        this.config.get('topupMaxPaise'),
        this.config.get('topupMonthlyCapPaise'),
      ]);
      if (amount < parseMoney(minPaise) || amount > parseMoney(maxPaise))
        throw new Error('INVALID_MONEY');
      const [start, end] = istMonthWindow(await this.primitives.currentLotTime(tx));
      const usage = await this.monthlyUsage(tx, account.id, userId, start, end);
      if (usage + amount > parseMoney(monthlyPaise)) throw new Error('RESOURCE_CONFLICT');
      const created = await this.orders.createAttempt({
        aggregateId: intentId,
        kind: 'WALLET_TOPUP',
        userId,
        amountPaise,
        currency: 'INR',
        operationReference: topupReference(intentId),
        tx,
      });
      return created.operationReference;
    });
    const completed = await this.orders.completeSetup(intent, intent);
    return {
      topupId: completed.attemptId,
      operationReference: completed.operationReference,
      gatewayOrderId: completed.gatewayOrderId,
      amountPaise: completed.amountPaise,
      currency: completed.currency,
      provider: this.provider,
      publicKeyId: this.publicKeyId,
    };
  }
  private async monthlyUsage(
    tx: Parameters<WalletPrimitives['currentLotTime']>[0],
    accountId: string,
    userId: string,
    start: Date,
    end: Date,
  ): Promise<bigint> {
    const credited = await sql<{
      total: string | null;
    }>`SELECT COALESCE(SUM(delta_paise),0)::text AS total
      FROM wallet_ledger WHERE account_id=${accountId}::uuid AND reason='TOPUP_CREDIT'
      AND created_at >= ${start} AND created_at < ${end}`.execute(tx);
    const open = await sql<{
      total: string | null;
    }>`SELECT COALESCE(SUM(amount_paise),0)::text AS total
      FROM payment_attempts WHERE user_id=${userId}::uuid AND kind='WALLET_TOPUP'
      AND status IN ('CREATED','AUTHORIZED','UNKNOWN') AND created_at >= ${start} AND created_at < ${end}`.execute(
      tx,
    );
    return BigInt(credited.rows[0]!.total ?? '0') + BigInt(open.rows[0]!.total ?? '0');
  }
}
