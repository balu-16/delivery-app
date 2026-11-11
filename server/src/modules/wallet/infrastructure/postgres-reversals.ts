import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import { parseMoney } from '../../../common/money/money.js';
import type { LotTake } from './postgres-wallet.js';
import { WalletPrimitives } from './postgres-wallet.js';

interface DebitRow {
  id: string;
  account_id: string;
  bucket: 'cash' | 'promo';
  delta_paise: string;
  ref_id: string;
  lot_allocations: LotTake[];
}

/**
 * Exact-once spend reversal (ADR 0008, ADD-13). The reversal ledger row's
 * uniqueness makes `reverseSpend` idempotent; each original debit restores its
 * own bucket. Promo returns to the original lot while it is still unexpired;
 * the expired share normally moves to a fresh non-expiring lot. Referral
 * grants retain their original expiry, including when an order is reversed.
 */
export class WalletReversalService {
  constructor(private readonly primitives: WalletPrimitives) {}
  async reverseSpend(
    reference: string,
    tx?: TransactionContext,
    partial?: { amountPaise: string; reversalReference: string },
  ): Promise<boolean> {
    return this.primitives.run(tx, async (ctx) => {
      const debits =
        await sql<DebitRow>`SELECT id,account_id,bucket,delta_paise::text AS delta_paise,ref_id,lot_allocations
        FROM wallet_ledger WHERE ref_type='ORDER' AND ref_id=${reference} AND reason='ORDER_PAYMENT' ORDER BY bucket`.execute(
          ctx,
        );
      if (!debits.rows.length) return false;
      const account = await sql<{
        id: string;
        cash_balance_paise: string;
        promo_balance_paise: string;
        version: string;
      }>`SELECT id,cash_balance_paise::text,promo_balance_paise::text,version::text FROM wallet_accounts WHERE id=${debits.rows[0]!.account_id}::uuid FOR UPDATE`.execute(
        ctx,
      );
      const locked = account.rows[0];
      if (!locked) throw new Error('WALLET_ACCOUNT_MISSING');
      const reversalRef = partial?.reversalReference ?? `cancel:${reference}`;
      const previous = await sql<{
        bucket: 'cash' | 'promo';
        amount_paise: string;
        lot_allocations: LotTake[];
        reversal_reference: string;
      }>`SELECT bucket,amount_paise::text,lot_allocations,reversal_reference FROM wallet_reversal_allocations WHERE spend_reference=${reference}`.execute(
        ctx,
      );
      if (previous.rows.some((r) => r.reversal_reference === reversalRef)) return false;
      const totalLeft = debits.rows.reduce(
        (sum, d) =>
          sum -
          BigInt(d.delta_paise) -
          previous.rows
            .filter((p) => p.bucket === d.bucket)
            .reduce((a, p) => a + BigInt(p.amount_paise), 0n),
        0n,
      );
      let remaining = partial ? parseMoney(partial.amountPaise) : totalLeft;
      if (remaining <= 0n) return false;
      if (remaining > totalLeft) throw new Error('REFUND_LIMIT_EXCEEDED');
      let cashDelta = 0n,
        promoDelta = 0n;
      const now = await this.primitives.currentLotTime(ctx);
      for (const debit of debits.rows) {
        const used = previous.rows
          .filter((p) => p.bucket === debit.bucket)
          .reduce((a, p) => a + BigInt(p.amount_paise), 0n);
        const available = -BigInt(debit.delta_paise) - used;
        const take = remaining < available ? remaining : available;
        if (take <= 0n) continue;
        const originalTakes: LotTake[] = [];
        if (debit.bucket === 'promo') {
          const usedByLot = new Map<string, bigint>();
          for (const prior of previous.rows)
            for (const lot of prior.lot_allocations ?? [])
              usedByLot.set(lot.lotId, (usedByLot.get(lot.lotId) ?? 0n) + BigInt(lot.amountPaise));
          let left = take;
          for (const lot of debit.lot_allocations ?? []) {
            const availableLot = BigInt(lot.amountPaise) - (usedByLot.get(lot.lotId) ?? 0n);
            const n = left < availableLot ? left : availableLot;
            if (n > 0n) {
              originalTakes.push({ lotId: lot.lotId, amountPaise: n.toString() });
              left -= n;
            }
          }
          if (left !== 0n) throw new Error('WALLET_LOT_ALLOCATION_INVALID');
        }
        await sql`INSERT INTO wallet_reversal_allocations(spend_reference,reversal_reference,bucket,amount_paise,lot_allocations) VALUES (${reference},${reversalRef},${debit.bucket},${take.toString()}::bigint,${JSON.stringify(originalTakes)}::jsonb)`.execute(
          ctx,
        );
        const restored =
          debit.bucket === 'promo'
            ? await this.restoreLots(
                ctx,
                { ...debit, lot_allocations: originalTakes, ref_id: reversalRef },
                now,
              )
            : { allocations: [], expiredReferral: 0n };
        const applied = await this.primitives.insertLedgerRow(ctx, {
          accountId: locked.id,
          bucket: debit.bucket,
          deltaPaise: take.toString(),
          reason: 'ORDER_PAYMENT_REVERSAL',
          refType: 'REVERSAL',
          refId: reversalRef,
          balanceAfter:
            debit.bucket === 'cash'
              ? BigInt(locked.cash_balance_paise) + cashDelta + take
              : BigInt(locked.promo_balance_paise) + promoDelta + take,
          lotAllocations: restored.allocations,
        });
        if (!applied) throw new Error('RESOURCE_CONFLICT');
        if (restored.expiredReferral > 0n) {
          const expired = await this.primitives.insertLedgerRow(ctx, {
            accountId: locked.id,
            bucket: 'promo',
            deltaPaise: `-${restored.expiredReferral}`,
            reason: 'PROMO_EXPIRY',
            refType: 'REFERRAL_REVERSAL',
            refId: reversalRef,
            balanceAfter:
              BigInt(locked.promo_balance_paise) + promoDelta + take - restored.expiredReferral,
          });
          if (!expired) throw new Error('RESOURCE_CONFLICT');
        }
        if (debit.bucket === 'cash') cashDelta += take;
        else promoDelta += take - restored.expiredReferral;
        remaining -= take;
      }
      await this.primitives.applyBalance(
        ctx,
        locked.id,
        BigInt(locked.version),
        cashDelta,
        promoDelta,
      );
      return true;
    });
  }
  /** Restores unexpired lots; returns the fresh-lot allocation for expired shares. */
  private async restoreLots(
    ctx: TransactionContext,
    debit: DebitRow,
    now: Date,
  ): Promise<{ allocations: LotTake[]; expiredReferral: bigint }> {
    const allocations: LotTake[] = [];
    let expired = 0n;
    let expiredReferral = 0n;
    for (const take of debit.lot_allocations ?? []) {
      const amount = parseMoney(take.amountPaise);
      const restored = await sql<{ id: string }>`UPDATE wallet_promo_lots SET
        remaining_paise=remaining_paise+${amount.toString()}::bigint,
        state=CASE WHEN remaining_paise+${amount.toString()}::bigint > 0 THEN 'ACTIVE' ELSE state END
        WHERE id=${take.lotId}::uuid AND state <> 'EXPIRED'
          AND (expires_at IS NULL OR expires_at > ${now})
        RETURNING id`.execute(ctx);
      if (restored.rows.length)
        allocations.push({ lotId: take.lotId, amountPaise: amount.toString() });
      else {
        const original = await sql<{
          grant_reason: string;
          source_reference: string;
          expires_at: Date | null;
          state: string;
        }>`SELECT grant_reason,source_reference,expires_at,state FROM wallet_promo_lots WHERE id=${take.lotId}::uuid AND account_id=${debit.account_id}::uuid FOR UPDATE`.execute(
          ctx,
        );
        const lot = original.rows[0];
        if (
          lot?.grant_reason === 'PROMO_GRANT' &&
          /^referral:[0-9a-f-]{36}$/i.test(lot.source_reference) &&
          lot.expires_at &&
          (lot.state === 'EXPIRED' || new Date(lot.expires_at) <= now)
        )
          expiredReferral += amount;
        else expired += amount;
      }
    }
    if (expired > 0n) {
      const inserted = await sql<{ id: string }>`INSERT INTO wallet_promo_lots
        (id,account_id,grant_reason,source_reference,amount_paise,remaining_paise,expires_at,state)
        VALUES (${uuidV7()}::uuid,${debit.account_id}::uuid,'ORDER_PAYMENT_REVERSAL',${debit.ref_id},
          ${expired.toString()}::bigint,${expired.toString()}::bigint,NULL,'ACTIVE')
        ON CONFLICT (account_id,grant_reason,source_reference) DO NOTHING RETURNING id`.execute(
        ctx,
      );
      const lotId =
        inserted.rows[0]?.id ??
        (
          await sql<{ id: string }>`SELECT id FROM wallet_promo_lots
            WHERE account_id=${debit.account_id}::uuid AND grant_reason='ORDER_PAYMENT_REVERSAL' AND source_reference=${debit.ref_id}`.execute(
            ctx,
          )
        ).rows[0]!.id;
      allocations.push({ lotId, amountPaise: expired.toString() });
    }
    return { allocations, expiredReferral };
  }
}
