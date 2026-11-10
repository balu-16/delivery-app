import {
  allocateLots,
  assertSufficient,
  perOrderPromoCap,
  splitSpend,
} from '../../../src/modules/wallet/domain/wallet-math.js';
import { istMonthWindow } from '../../../src/modules/wallet/infrastructure/wallet-topups.js';

describe('wallet bucket split (ADR 0008 spend order)', () => {
  it('spends promo first up to the per-order cap, then cash', () => {
    // Cap 6000 bps of 10000 = 6000; promo available 4000 -> all promo, rest cash.
    expect(splitSpend('10000', 4000n, 6000)).toEqual({ promoPaise: '4000', cashPaise: '6000' });
    // Promo available exceeds the cap: capped at 6000.
    expect(splitSpend('10000', 9000n, 6000)).toEqual({ promoPaise: '6000', cashPaise: '4000' });
    // Full cap (10000 bps) and enough promo covers the whole amount.
    expect(splitSpend('5000', 9000n, 10000)).toEqual({ promoPaise: '5000', cashPaise: '0' });
    // No promo: all cash.
    expect(splitSpend('7000', 0n, 10000)).toEqual({ promoPaise: '0', cashPaise: '7000' });
    // Cap floors: 10000 * 3333 bps = 3333 exactly, no paise created or lost.
    expect(perOrderPromoCap('10000', 3333)).toBe(3333n);
    expect(splitSpend('10000', 9000n, 3333)).toEqual({ promoPaise: '3333', cashPaise: '6667' });
  });
  it('rejects invalid caps and insufficient cash with typed errors', () => {
    expect(() => splitSpend('100', 0n, 10001)).toThrow('INVALID_INPUT');
    expect(() => splitSpend('100', 0n, -1)).toThrow('INVALID_INPUT');
    expect(() => assertSufficient(50n, '51')).toThrow('WALLET_INSUFFICIENT');
    expect(() => assertSufficient(50n, '50')).not.toThrow();
  });
});

describe('promo lot FIFO allocation', () => {
  it('consumes earliest lots first and preserves per-lot provenance', () => {
    const takes = allocateLots(
      [
        { lotId: 'lot-old', remainingPaise: 300n },
        { lotId: 'lot-mid', remainingPaise: 500n },
        { lotId: 'lot-new', remainingPaise: 900n },
      ],
      '800',
    );
    expect(takes).toEqual([
      { lotId: 'lot-old', take: 300n },
      { lotId: 'lot-mid', take: 500n },
    ]);
  });
  it('throws when lots cannot cover the amount', () => {
    expect(() =>
      allocateLots(
        [
          { lotId: 'a', remainingPaise: 100n },
          { lotId: 'b', remainingPaise: 100n },
        ],
        '500',
      ),
    ).toThrow('INVALID_MONEY');
    expect(allocateLots([], '0')).toEqual([]);
  });
});

describe('IST business month window', () => {
  it('covers the IST calendar month in UTC instants', () => {
    // 2026-11-01 00:30 IST is still October in UTC; the IST month starts at
    // 2026-10-31 18:30 UTC and ends 2026-11-30 18:30 UTC.
    const [start, end] = istMonthWindow(new Date('2026-11-01T00:30:00+05:30'));
    expect(start.toISOString()).toBe('2026-10-31T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-11-30T18:30:00.000Z');
    const [marchStart, aprilStart] = istMonthWindow(new Date('2026-03-15T10:00:00+05:30'));
    expect(marchStart.toISOString()).toBe('2026-02-28T18:30:00.000Z');
    expect(aprilStart.toISOString()).toBe('2026-03-31T18:30:00.000Z');
  });
});
