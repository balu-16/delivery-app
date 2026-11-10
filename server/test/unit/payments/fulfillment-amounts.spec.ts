import { fulfillmentAmounts } from '../../../src/modules/orders/domain/fulfillment-amounts.js';

test('a partial short keeps integer rounding equal to the refund and invoice', () => {
  const result = fulfillmentAmounts({
    ordered: 3n,
    fulfilled: 2n,
    unit: 100n,
    discount: 1n,
    taxBps: 500,
  });
  expect(result.net).toBe(199n);
  expect(result.reduction).toBe(100n);
  expect(result.unit * 2n - result.discount + result.reduction).toBe(299n);
  expect(result.tax).toBe(9n);
});
test.each([50n, 100n, 200n])(
  'replacement at %s never increases the original net charge',
  (replacementUnit) => {
    const result = fulfillmentAmounts({
      ordered: 2n,
      fulfilled: 2n,
      unit: 100n,
      discount: 20n,
      replacementUnit,
      taxBps: 1800,
    });
    expect(result.net).toBeLessThanOrEqual(180n);
    expect(result.reduction + result.net).toBe(180n);
    expect(result.net).toBe(replacementUnit < 100n ? 80n : 180n);
  },
);
test('a replacement below the retained discount cannot produce negative money', () => {
  const result = fulfillmentAmounts({
    ordered: 2n,
    fulfilled: 1n,
    unit: 100n,
    discount: 180n,
    replacementUnit: 5n,
    taxBps: 0,
  });
  expect(result.net).toBe(0n);
  expect(result.reduction).toBe(20n);
});
test.each([
  [-1n, 1n],
  [2n, 1n],
  [1n, 0n],
])('rejects invalid fulfilled/ordered quantities', (fulfilled, ordered) => {
  expect(() =>
    fulfillmentAmounts({ ordered, fulfilled, unit: 100n, discount: 0n, taxBps: 500 }),
  ).toThrow('INVALID_INPUT');
});
