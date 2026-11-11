import {
  allocateProRata,
  computeQuote,
  roundHalfUp,
  deliveryFee,
  type PricingFeeConfig,
  type PricingLineInput,
} from '../../../src/modules/pricing/contracts/pricing.js';

/** Deterministic PRNG (mulberry32) so property runs are reproducible. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const baseFees = (): PricingFeeConfig => ({
  deliveryFeeSlabs: [
    { maxOrderValuePaise: 20000n, feePaise: 4000n },
    { maxOrderValuePaise: 50000n, feePaise: 2000n },
    { maxOrderValuePaise: null, feePaise: 0n },
  ],
  freeDeliveryThresholdPaise: 50000n,
  handlingFeePaise: 500n,
  smallCartThresholdPaise: 10000n,
  smallCartFeePaise: 1500n,
  surgeFeePaise: 2500n,
  surgeEnabled: false,
  feeTaxRules: [{ appliesTo: 'ALL', taxBps: 1800, split: 'CGST_SGST' }],
});
const line = (over: Partial<PricingLineInput> = {}): PricingLineInput => ({
  variantId: 'v1',
  quantity: 1n,
  unitPricePaise: 10000n,
  mrpPaise: 100000n,
  taxRateBps: 500,
  eligibleForDiscount: true,
  ...over,
});
const noFees = (): PricingFeeConfig => ({
  ...baseFees(),
  deliveryFeeSlabs: [{ maxOrderValuePaise: null, feePaise: 0n }],
  freeDeliveryThresholdPaise: 0n,
  handlingFeePaise: 0n,
  smallCartThresholdPaise: 0n,
  smallCartFeePaise: 0n,
  surgeFeePaise: 0n,
});

describe('D14 inclusive GST fixture', () => {
  it('an inclusive ₹105 line at 5% totals ₹105.00 and discloses ₹5.00 tax exactly once', () => {
    const totals = computeQuote({
      lines: [line({ unitPricePaise: 10500n, mrpPaise: 10500n, taxRateBps: 500 })],
      coupon: null,
      tipPaise: 0n,
      fees: noFees(),
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    expect(totals.subtotalPaise).toBe(10500n);
    expect(totals.discountPaise).toBe(0n);
    expect(totals.lines[0]!.taxPaise).toBe(500n);
    expect(totals.taxTotalPaise).toBe(500n);
    expect(totals.totalPaise).toBe(10500n);
    expect(totals.amountDuePaise).toBe(10500n);
  });
  it('tax extraction happens after discount allocation', () => {
    const totals = computeQuote({
      lines: [line({ unitPricePaise: 10500n, mrpPaise: 10500n, taxRateBps: 500 })],
      coupon: { kind: 'FLAT', value: 500n, maxCapPaise: null },
      tipPaise: 0n,
      fees: noFees(),
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    // taxable = 10000; tax = 10000*500/10500 = 476.19 -> 476
    expect(totals.lines[0]!.discountPaise).toBe(500n);
    expect(totals.lines[0]!.taxPaise).toBe(476n);
    expect(totals.totalPaise).toBe(10000n);
  });
});

describe('largest-remainder allocation', () => {
  it('allocates 100 paise across three equal lines summing exactly', () => {
    const allocations = allocateProRata(100n, [333n, 333n, 334n]);
    expect(allocations.reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(allocations).toEqual([33n, 33n, 34n]);
  });
  it('ties break by weight then index without ever losing paise', () => {
    const allocations = allocateProRata(7n, [10n, 10n, 10n]);
    expect(allocations.reduce((a, b) => a + b, 0n)).toBe(7n);
    expect(allocations).toEqual([3n, 2n, 2n]);
  });
  it('a coupon discount is split over eligible lines only and sums to the coupon discount', () => {
    const totals = computeQuote({
      lines: [
        line({ variantId: 'a', unitPricePaise: 3330n, quantity: 1n }),
        line({ variantId: 'b', unitPricePaise: 3330n, quantity: 1n }),
        line({ variantId: 'c', unitPricePaise: 3340n, quantity: 1n }),
        line({ variantId: 'd', unitPricePaise: 900n, eligibleForDiscount: false }),
      ],
      coupon: { kind: 'FLAT', value: 100n, maxCapPaise: null },
      tipPaise: 0n,
      fees: noFees(),
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    expect(totals.discountPaise).toBe(100n);
    expect(totals.lines.map((l) => l.discountPaise)).toEqual([33n, 33n, 34n, 0n]);
    expect(totals.lines.reduce((sum, l) => sum + l.discountPaise, 0n)).toBe(totals.discountPaise);
  });
});

describe('fees', () => {
  it('combines a referral delivery waiver with a merchandise coupon', () => {
    const totals = computeQuote({
      lines: [line()],
      coupon: { kind: 'FLAT', value: 2000n, maxCapPaise: null },
      referralFreeDelivery: true,
      tipPaise: 0n,
      fees: baseFees(),
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    expect(totals.discountPaise).toBe(2000n);
    expect(totals.deliveryFeeWaived).toBe(true);
    expect(totals.fees.find((fee) => fee.kind === 'DELIVERY')).toBeUndefined();
  });
  it('delivery fee follows the slab on post-discount merchandise value', () => {
    expect(deliveryFee(20000n, baseFees())).toBe(4000n);
    expect(deliveryFee(20001n, baseFees())).toBe(2000n);
    expect(deliveryFee(50001n, baseFees())).toBe(0n);
    const discounted = computeQuote({
      lines: [line({ unitPricePaise: 25000n })],
      coupon: { kind: 'FLAT', value: 10000n, maxCapPaise: null },
      tipPaise: 0n,
      fees: {
        ...baseFees(),
        handlingFeePaise: 0n,
        smallCartFeePaise: 0n,
        smallCartThresholdPaise: 0n,
      },
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    // Without the discount, 25000 lands in the second slab (2000). After the
    // discount, merchandise is 15000 — back inside the first slab (4000).
    expect(discounted.fees.find((f) => f.kind === 'DELIVERY')!.amountPaise).toBe(4000n);
  });
  it('free-delivery threshold waives the delivery fee', () => {
    const totals = computeQuote({
      lines: [line({ unitPricePaise: 50000n })],
      coupon: null,
      tipPaise: 0n,
      fees: baseFees(),
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    expect(totals.deliveryFeeWaived).toBe(true);
    expect(totals.fees.find((f) => f.kind === 'DELIVERY')).toBeUndefined();
  });
  it('a FREE_DELIVERY coupon zeroes the delivery fee and discounts no line', () => {
    const totals = computeQuote({
      lines: [line({ unitPricePaise: 30000n })],
      coupon: { kind: 'FREE_DELIVERY', value: 0n, maxCapPaise: null },
      tipPaise: 0n,
      fees: baseFees(),
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    expect(totals.deliveryFeeWaived).toBe(true);
    expect(totals.discountPaise).toBe(0n);
    expect(totals.couponDiscountPaise).toBe(0n);
  });
  it('small-cart fee applies only below the threshold and surge only when enabled', () => {
    const below = computeQuote({
      lines: [line({ unitPricePaise: 5000n })],
      coupon: null,
      tipPaise: 0n,
      fees: { ...baseFees(), handlingFeePaise: 0n },
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    expect(below.fees.find((f) => f.kind === 'SMALL_CART')!.amountPaise).toBe(1500n);
    expect(below.fees.find((f) => f.kind === 'SURGE')).toBeUndefined();
    const surge = computeQuote({
      lines: [line({ unitPricePaise: 5000n })],
      coupon: null,
      tipPaise: 0n,
      fees: { ...baseFees(), handlingFeePaise: 0n, surgeEnabled: true },
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    expect(surge.fees.find((f) => f.kind === 'SURGE')!.amountPaise).toBe(2500n);
  });
  it('fee tax is extracted inclusively per rule; a specific rule overrides ALL', () => {
    const totals = computeQuote({
      lines: [line({ unitPricePaise: 5000n, taxRateBps: 0 })],
      coupon: null,
      tipPaise: 0n,
      fees: {
        ...baseFees(),
        surgeEnabled: false,
        feeTaxRules: [{ appliesTo: 'ALL', taxBps: 1800, split: 'CGST_SGST' }],
      },
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    const delivery = totals.fees.find((f) => f.kind === 'DELIVERY')!;
    // 4000 * 1800 / 11800 = 610.17 -> 610
    expect(delivery.taxPaise).toBe(610n);
    expect(delivery.taxSplit).toBe('CGST_SGST');
    const specific = computeQuote({
      lines: [line({ unitPricePaise: 5000n, taxRateBps: 0 })],
      coupon: null,
      tipPaise: 0n,
      fees: {
        ...baseFees(),
        feeTaxRules: [
          { appliesTo: 'ALL', taxBps: 1800, split: 'CGST_SGST' },
          { appliesTo: 'DELIVERY', taxBps: 500, split: 'IGST' },
        ],
      },
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    const deliverySpecific = specific.fees.find((f) => f.kind === 'DELIVERY')!;
    expect(deliverySpecific.taxPaise).toBe(190n); // 4000*500/10500 = 190.47 -> 190
    expect(deliverySpecific.taxSplit).toBe('IGST');
  });
});

describe('tip and wallet', () => {
  it('tip is never discounted and never taxed but is part of the total', () => {
    const totals = computeQuote({
      lines: [line({ unitPricePaise: 10000n })],
      coupon: { kind: 'PERCENT', value: 5000n, maxCapPaise: null },
      tipPaise: 2500n,
      fees: noFees(),
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    expect(totals.tipPaise).toBe(2500n);
    expect(totals.discountPaise).toBe(5000n);
    expect(totals.taxTotalPaise).toBe(238n); // only line tax on 5000*500/10500 = 238.09
    expect(totals.fees.find((f) => f.kind === 'TIP')).toMatchObject({
      amountPaise: 2500n,
      taxPaise: 0n,
    });
    expect(totals.totalPaise).toBe(5000n + 2500n);
  });
  it('wallet applies promo first up to the spend cap then cash; amountDue never goes negative', () => {
    const totals = computeQuote({
      lines: [line({ unitPricePaise: 10000n })],
      coupon: null,
      tipPaise: 0n,
      fees: noFees(),
      wallet: { promoAvailablePaise: 100000n, cashAvailablePaise: 100000n, promoSpendCapBps: 3000 },
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    expect(totals.wallet).toEqual({ promoPaise: 3000n, cashPaise: 7000n });
    expect(totals.amountDuePaise).toBe(0n);
    const partial = computeQuote({
      lines: [line({ unitPricePaise: 10000n })],
      coupon: null,
      tipPaise: 0n,
      fees: noFees(),
      wallet: { promoAvailablePaise: 1000n, cashAvailablePaise: 500n, promoSpendCapBps: 5000 },
      minOrderPaise: 0n,
      maxOrderPaise: 100000000n,
    });
    expect(partial.wallet).toEqual({ promoPaise: 1000n, cashPaise: 500n });
    expect(partial.amountDuePaise).toBe(8500n);
  });
});

describe('order bounds', () => {
  it('min and max order flags reflect post-discount merchandise and the total', () => {
    const totals = computeQuote({
      lines: [line({ unitPricePaise: 5000n })],
      coupon: { kind: 'FLAT', value: 4500n, maxCapPaise: null },
      tipPaise: 0n,
      fees: noFees(),
      wallet: null,
      minOrderPaise: 1000n,
      maxOrderPaise: 100000000n,
    });
    expect(totals.minOrderNotMet).toBe(true);
    const tooBig = computeQuote({
      lines: [line({ unitPricePaise: 100000n })],
      coupon: null,
      tipPaise: 0n,
      fees: noFees(),
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 90000n,
    });
    expect(tooBig.maxOrderExceeded).toBe(true);
  });
});

describe('property-style invariants (deterministic seeds)', () => {
  const couponFor = (rand: () => number) => {
    const roll = rand();
    if (roll < 0.25) return null;
    if (roll < 0.5)
      return {
        kind: 'PERCENT' as const,
        value: BigInt(1 + Math.floor(rand() * 10000)),
        maxCapPaise: rand() < 0.5 ? null : BigInt(Math.floor(rand() * 20000)),
      };
    if (roll < 0.75)
      return {
        kind: 'FLAT' as const,
        value: BigInt(Math.floor(rand() * 30000)),
        maxCapPaise: rand() < 0.5 ? null : BigInt(Math.floor(rand() * 20000)),
      };
    return { kind: 'FREE_DELIVERY' as const, value: 0n, maxCapPaise: null };
  };
  it('totals reconcile exactly, allocations sum, and no amount is negative or created', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rand = rng(seed * 7919);
      const lineCount = 1 + Math.floor(rand() * 6);
      const lines: PricingLineInput[] = Array.from({ length: lineCount }, (_, index) =>
        line({
          variantId: `v${index}`,
          quantity: BigInt(1 + Math.floor(rand() * 5)),
          unitPricePaise: BigInt(1 + Math.floor(rand() * 40000)),
          mrpPaise: BigInt(60000),
          taxRateBps: [0, 500, 1200, 1800, 2800][Math.floor(rand() * 5)]!,
          eligibleForDiscount: rand() < 0.8,
        }),
      );
      const wallet =
        rand() < 0.5
          ? {
              promoAvailablePaise: BigInt(Math.floor(rand() * 40000)),
              cashAvailablePaise: BigInt(Math.floor(rand() * 40000)),
              promoSpendCapBps: Math.floor(rand() * 10001),
            }
          : null;
      const fees = {
        ...baseFees(),
        surgeEnabled: rand() < 0.3,
        freeDeliveryThresholdPaise: BigInt(Math.floor(rand() * 60000)),
      };
      const tipPaise = BigInt(Math.floor(rand() * 3000));
      const totals = computeQuote({
        lines,
        coupon: couponFor(rand),
        tipPaise,
        fees,
        wallet,
        minOrderPaise: BigInt(Math.floor(rand() * 1000)),
        maxOrderPaise: 100000000n,
      });
      // Lines are returned sorted by variantId.
      const sorted = [...lines].sort((a, b) => a.variantId.localeCompare(b.variantId));
      expect(totals.lines.map((l) => l.variantId)).toEqual(sorted.map((l) => l.variantId));
      // Reconciliation: subtotal - discount + fees + tip = total.
      expect(totals.subtotalPaise).toBe(
        sorted.reduce((s, l) => s + l.quantity * l.unitPricePaise, 0n),
      );
      expect(totals.discountPaise).toBe(totals.lines.reduce((s, l) => s + l.discountPaise, 0n));
      expect(totals.feeTotalPaise).toBe(
        totals.fees.reduce((s, f) => s + f.amountPaise, 0n) - totals.tipPaise,
      );
      expect(totals.totalPaise).toBe(
        totals.subtotalPaise - totals.discountPaise + totals.feeTotalPaise + totals.tipPaise,
      );
      expect(totals.taxTotalPaise).toBe(
        totals.lines.reduce((s, l) => s + l.taxPaise, 0n) +
          totals.fees.reduce((s, f) => s + f.taxPaise, 0n),
      );
      // Per-line integrity.
      for (const l of totals.lines) {
        expect(l.lineSubtotalPaise).toBe(l.quantity * l.unitPricePaise);
        expect(l.lineTotalPaise).toBe(l.lineSubtotalPaise - l.discountPaise);
        expect(l.discountPaise).toBeGreaterThanOrEqual(0n);
        expect(l.taxPaise).toBeGreaterThanOrEqual(0n);
        if (l.lineTotalPaise > 0n)
          expect(l.taxPaise).toBe(
            roundHalfUp(l.lineTotalPaise * BigInt(l.taxRateBps), 10000n + BigInt(l.taxRateBps)),
          );
      }
      // Coupon discount consistency: line discounts sum to the coupon discount,
      // each allocation never exceeds its line and ineligible lines get zero.
      for (const [index, l] of totals.lines.entries()) {
        if (!sorted[index]!.eligibleForDiscount) expect(l.discountPaise).toBe(0n);
        expect(l.discountPaise).toBeLessThanOrEqual(l.lineSubtotalPaise);
      }
      // Fees and tips are non-negative; tip carries no tax.
      for (const f of totals.fees) {
        expect(f.amountPaise).toBeGreaterThanOrEqual(0n);
        expect(f.taxPaise).toBeGreaterThanOrEqual(0n);
        if (f.kind === 'TIP') expect(f.taxPaise).toBe(0n);
      }
      // Wallet: promo first under the cap, cash fills the rest, amountDue = total - applied.
      if (wallet) {
        expect(totals.wallet).not.toBeNull();
        const applied = totals.wallet!.promoPaise + totals.wallet!.cashPaise;
        expect(applied).toBeLessThanOrEqual(totals.totalPaise);
        expect(totals.wallet!.promoPaise).toBeLessThanOrEqual(
          roundHalfUp(totals.totalPaise * BigInt(wallet.promoSpendCapBps), 10000n),
        );
        expect(totals.wallet!.promoPaise).toBeLessThanOrEqual(wallet.promoAvailablePaise);
        expect(totals.amountDuePaise).toBe(totals.totalPaise - applied);
      } else {
        expect(totals.wallet).toBeNull();
        expect(totals.amountDuePaise).toBe(totals.totalPaise);
      }
      expect(totals.amountDuePaise).toBeGreaterThanOrEqual(0n);
      // No paise created: everything the customer owes is accounted for.
      expect(totals.totalPaise).toBeLessThanOrEqual(
        totals.subtotalPaise + totals.feeTotalPaise + totals.tipPaise,
      );
    }
  });
  it('rounding never loses or creates paise in allocation for adversarial splits', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rand = rng(seed * 104729);
      const total = BigInt(1 + Math.floor(rand() * 99991));
      const weights = Array.from({ length: 1 + Math.floor(rand() * 7) }, () =>
        BigInt(1 + Math.floor(rand() * 100000)),
      );
      const allocations = allocateProRata(total, weights);
      expect(allocations.reduce((a, b) => a + b, 0n)).toBe(total);
      for (const allocation of allocations) expect(allocation).toBeLessThanOrEqual(total);
    }
  });
});
