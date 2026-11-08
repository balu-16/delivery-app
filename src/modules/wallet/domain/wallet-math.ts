import { parseMoney } from '../../../common/money/money.js';

/**
 * Pure wallet arithmetic (ADR 0008). Promo spends first up to the per-order
 * cap (`promoSpendCapBps` of the amount, floored), cash covers the rest.
 * Every input/output is an integer-paise decimal string; nothing here touches
 * I/O, so the concurrency suite exercises these rules against real locks.
 */
export interface BucketSplit {
  promoPaise: string;
  cashPaise: string;
}

export function perOrderPromoCap(amountPaise: string, capBps: number): bigint {
  const amount = parseMoney(amountPaise);
  if (!Number.isSafeInteger(capBps) || capBps < 0 || capBps > 10000)
    throw new Error('INVALID_INPUT');
  return (amount * BigInt(capBps)) / 10000n;
}

/** Promo first, bounded by the cap and by the spendable promo balance. */
export function splitSpend(
  amountPaise: string,
  promoAvailablePaise: bigint,
  capBps: number,
  capBasePaise: string = amountPaise,
): BucketSplit {
  const amount = parseMoney(amountPaise);
  const promo = [perOrderPromoCap(capBasePaise, capBps), promoAvailablePaise, amount].reduce(
    (a, b) => (a < b ? a : b),
  );
  const cash = amount - promo;
  if (cash < 0n) throw new Error('INVALID_MONEY');
  return { promoPaise: promo.toString(), cashPaise: cash.toString() };
}

export function assertSufficient(cashBalancePaise: bigint, cashNeededPaise: string): void {
  if (cashBalancePaise < parseMoney(cashNeededPaise)) throw new Error('WALLET_INSUFFICIENT');
}

/** FIFO consumption across grant-time-ordered lots; returns per-lot takes. */
export function allocateLots(
  lots: readonly { lotId: string; remainingPaise: bigint }[],
  amountPaise: string,
): { lotId: string; take: bigint }[] {
  let remaining = parseMoney(amountPaise);
  const takes: { lotId: string; take: bigint }[] = [];
  for (const lot of lots) {
    if (remaining <= 0n) break;
    const take = remaining < lot.remainingPaise ? remaining : lot.remainingPaise;
    if (take <= 0n) continue;
    takes.push({ lotId: lot.lotId, take });
    remaining -= take;
  }
  if (remaining > 0n) throw new Error('INVALID_MONEY');
  return takes;
}
