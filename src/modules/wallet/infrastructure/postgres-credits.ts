import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import { parseMoney } from '../../../common/money/money.js';
import type { WalletBucket, WalletReason } from '../contracts/wallet.js';
import { WalletPrimitives } from './postgres-wallet.js';

/**
 * Credits and administrative adjustments. Credits are exactly-once by ledger
 * uniqueness (duplicate webhook captures land as no-ops); promo credits may
 * carry an expiry and always create an immutable lot. Adjustments run inside
 * an approved maker-checker execution keyed by the approval execution key.
 */
export class WalletCreditService {
  constructor(private readonly primitives: WalletPrimitives) {}
  async credit(input: {
    userId: string;
    bucket: WalletBucket;
    amountPaise: string;
    reason: WalletReason;
    refType: string;
    refId: string;
    expiresAt?: string;
    tx?: TransactionContext;
  }): Promise<boolean> {
    const amount = parseMoney(input.amountPaise);
    if (amount <= 0n) throw new Error('INVALID_MONEY');
    return this.primitives.run(input.tx, async (ctx) => {
      const account = await this.primitives.lockAccount(ctx, input.userId);
      const balanceAfter =
        input.bucket === 'cash'
          ? account.cash_balance_paise + amount
          : account.promo_balance_paise + amount;
      const applied = await this.primitives.insertLedgerRow(ctx, {
        accountId: account.id,
        bucket: input.bucket,
        deltaPaise: amount.toString(),
        reason: input.reason,
        refType: input.refType,
        refId: input.refId,
        balanceAfter,
      });
      if (!applied) return false;
      if (input.bucket === 'promo') {
        await this.grantLot(ctx, account.id, input, amount);
      }
      await this.primitives.applyBalance(
        ctx,
        account.id,
        account.version,
        input.bucket === 'cash' ? amount : 0n,
        input.bucket === 'promo' ? amount : 0n,
      );
      return true;
    });
  }
  private async grantLot(
    ctx: TransactionContext,
    accountId: string,
    input: { reason: WalletReason; refId: string; expiresAt?: string },
    amount: bigint,
  ): Promise<void> {
    await sql`INSERT INTO wallet_promo_lots
      (id,account_id,grant_reason,source_reference,amount_paise,remaining_paise,expires_at,state)
      VALUES (${uuidV7()}::uuid,${accountId}::uuid,${input.reason},${input.refId},${amount.toString()}::bigint,
        ${amount.toString()}::bigint,${input.expiresAt ?? null},'ACTIVE')
      ON CONFLICT (account_id,grant_reason,source_reference) DO NOTHING`.execute(ctx);
  }
  async adjust(input: {
    userId: string;
    bucket: WalletBucket;
    deltaPaise: string;
    refId: string;
    tx: TransactionContext;
  }): Promise<void> {
    const delta = parseMoney(input.deltaPaise, true);
    if (delta === 0n) throw new Error('INVALID_MONEY');
    await this.primitives.run(input.tx, async (ctx) => {
      const account = await this.primitives.lockAccount(ctx, input.userId);
      const balanceAfter =
        input.bucket === 'cash'
          ? account.cash_balance_paise + delta
          : account.promo_balance_paise + delta;
      if (balanceAfter < 0n) throw new Error('WALLET_INSUFFICIENT');
      const applied = await this.primitives.insertLedgerRow(ctx, {
        accountId: account.id,
        bucket: input.bucket,
        deltaPaise: delta.toString(),
        reason: 'ADMIN_ADJUSTMENT',
        refType: 'ADMIN_APPROVAL',
        refId: input.refId,
        balanceAfter,
      });
      if (!applied) throw new Error('RESOURCE_CONFLICT');
      await this.primitives.applyBalance(
        ctx,
        account.id,
        account.version,
        input.bucket === 'cash' ? delta : 0n,
        input.bucket === 'promo' ? delta : 0n,
      );
    });
  }
}

/** Per-order funding records define the refundable wallet capacity (D16). */
export class WalletFundingService {
  constructor(private readonly primitives: WalletPrimitives) {}
  async record(input: {
    orderId: string;
    attemptId?: string;
    walletSpendReference?: string;
    promoPaise: string;
    cashPaise: string;
    tx?: TransactionContext;
  }): Promise<void> {
    if (parseMoney(input.promoPaise) + parseMoney(input.cashPaise) === 0n && !input.attemptId)
      throw new Error('INVALID_INPUT');
    await this.primitives.run(input.tx, async (ctx) => {
      // Upsert: reinstatement (P6.4) replaces the reversed spend reference
      // with the reacquired one so refund capacity always tracks the current
      // funding of the order.
      await sql`INSERT INTO wallet_funding_allocations
        (id,order_id,attempt_id,wallet_spend_reference,promo_paise,cash_paise)
        VALUES (${uuidV7()}::uuid,${input.orderId}::uuid,${input.attemptId ?? null}::uuid,${input.walletSpendReference ?? null},
          ${parseMoney(input.promoPaise).toString()}::bigint,${parseMoney(input.cashPaise).toString()}::bigint)
        ON CONFLICT (order_id) DO UPDATE SET wallet_spend_reference=EXCLUDED.wallet_spend_reference,
          promo_paise=EXCLUDED.promo_paise,cash_paise=EXCLUDED.cash_paise`.execute(ctx);
    });
  }
}
