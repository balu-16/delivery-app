import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { SpendOptions, SpendResult } from '../contracts/wallet.js';
import { allocateLots, assertSufficient, splitSpend } from '../domain/wallet-math.js';
import { parseMoney } from '../../../common/money/money.js';
import { WalletPrimitives } from './postgres-wallet.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import { uuidV7 } from '../../../common/ids/ids.js';

/**
 * Checkout spend (reason ORDER_PAYMENT): promo first up to the per-order cap
 * (`promoSpendCapBps` of the amount, floored), then cash. Runs strictly inside
 * the caller's placement transaction; the account row lock serialises two
 * devices, ledger uniqueness rejects a repeated reference, and the CHECK
 * constraints back the explicit WALLET_INSUFFICIENT rule.
 */
export class WalletSpendService {
  constructor(private readonly primitives: WalletPrimitives) {}
  async spend(
    userId: string,
    reference: string,
    amountPaise: string,
    tx: TransactionContext,
    opts?: SpendOptions,
  ): Promise<SpendResult> {
    const amount = parseMoney(amountPaise);
    if (amount <= 0n) throw new Error('INVALID_MONEY');
    return this.primitives.run(tx, async (ctx) => {
      if (!(await this.primitives.walletEnabled(ctx))) throw new Error('WALLET_DISABLED');
      const account = await this.primitives.lockAccount(ctx, userId);
      const now = await this.primitives.currentLotTime(ctx);
      const lots = await sql<{
        id: string;
        remaining_paise: string;
      }>`SELECT id,remaining_paise::text AS remaining_paise
        FROM wallet_promo_lots WHERE account_id=${account.id}::uuid AND state='ACTIVE' AND remaining_paise>0
        AND (expires_at IS NULL OR expires_at > ${now})
        ORDER BY created_at,id FOR UPDATE`.execute(ctx);
      const promoAvailable = lots.rows.reduce((sum, lot) => sum + BigInt(lot.remaining_paise), 0n);
      const capBps = opts?.promoCapBps ?? (await this.primitives.promoCapBps(ctx));
      const split = splitSpend(amountPaise, promoAvailable, capBps, opts?.promoCapBasePaise);
      assertSufficient(account.cash_balance_paise, split.cashPaise);
      const promoTake = BigInt(split.promoPaise);
      const cashTake = BigInt(split.cashPaise);
      let lotTakes: { lotId: string; amountPaise: string }[] = [];
      if (promoTake > 0n) {
        lotTakes = allocateLots(
          lots.rows.map((lot) => ({ lotId: lot.id, remainingPaise: BigInt(lot.remaining_paise) })),
          split.promoPaise,
        ).map((take) => ({ lotId: take.lotId, amountPaise: take.take.toString() }));
        await this.primitives.consumeLots(ctx, lotTakes);
      }
      const promoAfter = account.promo_balance_paise - promoTake;
      const cashAfter = account.cash_balance_paise - cashTake;
      if (promoTake > 0n) {
        const applied = await this.primitives.insertLedgerRow(ctx, {
          accountId: account.id,
          bucket: 'promo',
          deltaPaise: `-${promoTake}`,
          reason: 'ORDER_PAYMENT',
          refType: 'ORDER',
          refId: reference,
          balanceAfter: promoAfter,
          lotAllocations: lotTakes,
        });
        if (!applied) throw new Error('RESOURCE_CONFLICT');
      }
      if (cashTake > 0n) {
        const applied = await this.primitives.insertLedgerRow(ctx, {
          accountId: account.id,
          bucket: 'cash',
          deltaPaise: `-${cashTake}`,
          reason: 'ORDER_PAYMENT',
          refType: 'ORDER',
          refId: reference,
          balanceAfter: cashAfter,
        });
        if (!applied) throw new Error('RESOURCE_CONFLICT');
      }
      await this.primitives.applyBalance(ctx, account.id, account.version, -cashTake, -promoTake);
      const threshold = await this.primitives.lowBalanceThreshold(ctx);
      if (
        account.cash_balance_paise + account.promo_balance_paise >= threshold &&
        cashAfter + promoAfter < threshold
      )
        await appendEvent(
          ctx,
          {
            eventId: uuidV7(),
            eventType: 'wallet.low_balance',
            schemaVersion: 1,
            aggregateType: 'wallet_account',
            aggregateId: account.id,
            aggregateVersion: (account.version + 1n).toString(),
            occurredAt: now.toISOString(),
            correlationId: reference,
            causationId: null,
            payload: { userId, amountPaise: (cashAfter + promoAfter).toString() },
          },
          ['notifications'],
        );
      return { promoPaise: split.promoPaise, cashPaise: split.cashPaise };
    });
  }
}
