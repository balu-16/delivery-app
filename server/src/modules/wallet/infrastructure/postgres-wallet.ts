import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { WalletBucket, WalletReason } from '../contracts/wallet.js';
import { parseMoney } from '../../../common/money/money.js';

export interface AccountRow {
  id: string;
  user_id: string;
  cash_balance_paise: bigint;
  promo_balance_paise: bigint;
  version: bigint;
}
export interface LotTake {
  lotId: string;
  amountPaise: string;
}
export interface LedgerMovement {
  accountId: string;
  bucket: WalletBucket;
  deltaPaise: string;
  reason: WalletReason;
  refType: string;
  refId: string;
  balanceAfter: bigint;
  lotAllocations?: readonly LotTake[];
}

/** Shared primitives: one account row lock serialises all bucket movements. */
export class WalletPrimitives {
  async lowBalanceThreshold(tx: TransactionContext): Promise<bigint> {
    const row = await sql<{
      value: string;
    }>`SELECT value FROM app_config WHERE key='walletLowBalanceThresholdPaise'`.execute(tx);
    return parseMoney(row.rows[0]?.value ?? '10000');
  }
  constructor(private readonly db: Database) {}
  run<T>(tx: TransactionContext | undefined, fn: (tx: TransactionContext) => Promise<T>) {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }
  async ensureAccount(tx: TransactionContext, userId: string): Promise<string> {
    await sql`INSERT INTO wallet_accounts(id,user_id) VALUES (${uuidV7()}::uuid,${userId}::uuid)
      ON CONFLICT (user_id) DO NOTHING`.execute(tx);
    const rows = await sql<{
      id: string;
    }>`SELECT id FROM wallet_accounts WHERE user_id=${userId}::uuid`.execute(tx);
    const row = rows.rows[0];
    if (!row) throw new Error('WALLET_ACCOUNT_MISSING');
    return row.id;
  }
  async lockAccount(tx: TransactionContext, userId: string): Promise<AccountRow> {
    await this.ensureAccount(tx, userId);
    const rows =
      await sql<AccountRow>`SELECT id,user_id,cash_balance_paise,promo_balance_paise,version
      FROM wallet_accounts WHERE user_id=${userId}::uuid FOR UPDATE`.execute(tx);
    const row = rows.rows[0];
    if (!row) throw new Error('WALLET_ACCOUNT_MISSING');
    return {
      ...row,
      cash_balance_paise: BigInt(row.cash_balance_paise),
      promo_balance_paise: BigInt(row.promo_balance_paise),
      version: BigInt(row.version),
    };
  }
  async walletEnabled(tx: TransactionContext): Promise<boolean> {
    const rows = await sql<{
      enabled: boolean;
    }>`SELECT enabled FROM feature_flags WHERE key='wallet_enabled'`.execute(tx);
    return rows.rows[0]?.enabled ?? false;
  }
  /** Config default when the key was never stored (app-config definitions). */
  async promoCapBps(ctx: TransactionContext): Promise<number> {
    const rows = await sql<{
      value: number | null;
    }>`SELECT value FROM app_config WHERE key='promoSpendCapBps'`.execute(ctx);
    const stored = rows.rows[0]?.value;
    if (stored === null || stored === undefined) return 10000;
    if (typeof stored !== 'number' || !Number.isSafeInteger(stored) || stored < 0 || stored > 10000)
      throw new Error('INVALID_INPUT');
    return stored;
  }
  /** Ledger uniqueness is the exactly-once guarantee; false means replay. */
  async insertLedgerRow(tx: TransactionContext, movement: LedgerMovement): Promise<boolean> {
    const inserted = await sql<{ id: string }>`INSERT INTO wallet_ledger
      (id,account_id,bucket,delta_paise,reason,ref_type,ref_id,lot_allocations,balance_after)
      VALUES (${uuidV7()}::uuid,${movement.accountId}::uuid,${movement.bucket},${movement.deltaPaise}::bigint,
        ${movement.reason},${movement.refType},${movement.refId},
        ${JSON.stringify(movement.lotAllocations ?? [])}::jsonb,${movement.balanceAfter.toString()}::bigint)
      ON CONFLICT (account_id,bucket,ref_type,ref_id,reason) DO NOTHING RETURNING id`.execute(tx);
    return inserted.rows.length > 0;
  }
  async applyBalance(
    tx: TransactionContext,
    accountId: string,
    expectedVersion: bigint,
    cashDelta: bigint,
    promoDelta: bigint,
  ): Promise<void> {
    const updated = await sql<{ id: string }>`UPDATE wallet_accounts SET
      cash_balance_paise=cash_balance_paise+${cashDelta.toString()}::bigint,
      promo_balance_paise=promo_balance_paise+${promoDelta.toString()}::bigint,
      version=version+1,updated_at=clock_timestamp()
      WHERE id=${accountId}::uuid AND version=${expectedVersion.toString()}::bigint
      RETURNING id`.execute(tx);
    if (!updated.rows[0]) throw new Error('CONCURRENT_MODIFICATION');
  }
  /** Consumes FIFO lots; the caller holds the account row lock. */
  async consumeLots(ctx: TransactionContext, takes: readonly LotTake[]): Promise<void> {
    for (const take of takes) {
      await sql`UPDATE wallet_promo_lots SET
        remaining_paise=remaining_paise-${parseMoney(take.amountPaise).toString()}::bigint,
        state=CASE WHEN remaining_paise-${parseMoney(take.amountPaise).toString()}::bigint <= 0 THEN 'EXHAUSTED' ELSE state END
        WHERE id=${take.lotId}::uuid`.execute(ctx);
    }
  }
  async currentLotTime(ctx: TransactionContext): Promise<Date> {
    return databaseTimeAfterLock(ctx);
  }
}
