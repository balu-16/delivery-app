import {
  feeEstimateBands,
  type PricingFeeConfig,
} from '../../../src/modules/pricing/contracts/pricing.js';

const fees: PricingFeeConfig = {
  deliveryFeeSlabs: [
    { maxOrderValuePaise: 20000n, feePaise: 4000n },
    { maxOrderValuePaise: null, feePaise: 2000n },
  ],
  freeDeliveryThresholdPaise: 59900n,
  handlingFeePaise: 500n,
  smallCartThresholdPaise: 19900n,
  smallCartFeePaise: 1500n,
  surgeFeePaise: 2500n,
  surgeEnabled: true,
  feeTaxRules: [],
};

test('orders bands by ceiling with a null final band', () => {
  const bands = feeEstimateBands(fees);
  expect(bands.map((band) => band.upToSubtotalPaise)).toEqual([19900n, 20000n, 59900n, null]);
  expect(bands.at(-1)).toMatchObject({ upToSubtotalPaise: null });
});

test('waives delivery at the free threshold and charges small carts below theirs', () => {
  const bands = feeEstimateBands(fees);
  const below = bands[0]!;
  expect(below.upToSubtotalPaise).toBe(19900n);
  expect(below.deliveryPaise).toBe(4000n);
  expect(below.smallCartPaise).toBe(0n);
  expect(below.handlingPaise).toBe(500n);
  expect(below.surgePaise).toBe(2500n);
  const waived = bands[2]!;
  expect(waived.upToSubtotalPaise).toBe(59900n);
  expect(waived.deliveryPaise).toBe(0n);
  expect(waived.smallCartPaise).toBe(0n);
  const open = bands[3]!;
  expect(open.deliveryPaise).toBe(0n);
  expect(open.smallCartPaise).toBe(0n);
});

test('omits surge while disabled and waives the open band past the threshold', () => {
  const bands = feeEstimateBands({
    ...fees,
    surgeEnabled: false,
    freeDeliveryThresholdPaise: 999999999999n,
  });
  for (const band of bands) expect(band.surgePaise).toBe(0n);
  expect(bands[0]!.deliveryPaise).toBe(4000n);
  expect(bands.at(-1)!.deliveryPaise).toBe(0n);
});

test('matches checkout delivery fees at every band sample', async () => {
  const { computeQuote } = await import('../../../src/modules/pricing/contracts/pricing.js');
  for (const band of feeEstimateBands(fees)) {
    const merchandise = band.upToSubtotalPaise ?? 59901n;
    const totals = computeQuote({
      lines: [
        {
          variantId: 'v',
          quantity: 1n,
          unitPricePaise: merchandise,
          mrpPaise: merchandise,
          taxRateBps: 0,
          eligibleForDiscount: false,
        },
      ],
      coupon: null,
      tipPaise: 0n,
      fees,
      wallet: null,
      minOrderPaise: 0n,
      maxOrderPaise: 999999999999n,
    });
    const fee = (kind: string) =>
      totals.fees.find((entry) => entry.kind === kind)?.amountPaise ?? 0n;
    expect(band.deliveryPaise).toBe(fee('DELIVERY'));
    expect(band.handlingPaise).toBe(fee('HANDLING'));
    expect(band.smallCartPaise).toBe(fee('SMALL_CART'));
    expect(band.surgePaise).toBe(fee('SURGE'));
  }
});
