import {
  clampToMaxPerOrder,
  evaluateLines,
  expectedVersion,
  parseQuantity,
  requireVersion,
} from '../../../src/modules/cart/domain/cart.js';

describe('absolute quantity parsing', () => {
  it('accepts bounded digit strings', () => {
    expect(parseQuantity('0')).toBe(0n);
    expect(parseQuantity('3')).toBe(3n);
    expect(parseQuantity('1000')).toBe(1000n);
  });
  it('rejects non-digits, signs, blanks and oversized values', () => {
    for (const bad of ['-1', '1.5', 'abc', '', ' 1', '01a', '1e2', '1'.repeat(11), '1001'])
      expect(() => parseQuantity(bad)).toThrow('INVALID_QUANTITY');
  });
});
describe('per-order clamp', () => {
  it('clamps above the configured maximum and reports it', () => {
    expect(clampToMaxPerOrder(10n, 5)).toEqual({ quantity: 5n, clamped: true });
    expect(clampToMaxPerOrder(5n, 5)).toEqual({ quantity: 5n, clamped: false });
  });
  it('rejects unbounded or invalid configuration', () => {
    expect(() => clampToMaxPerOrder(1n, 0)).toThrow('INVALID_INPUT');
    expect(() => clampToMaxPerOrder(1n, Number.NaN)).toThrow('INVALID_INPUT');
  });
});
describe('fresh evaluation flags', () => {
  const base = {
    variantId: 'v1',
    storedQuantity: 2n,
    storedUnitPricePaise: 1000n,
    currentUnitPricePaise: 1000n,
    available: 10n,
    saleable: true,
  };
  it('unavailable, unpublished or zero-stock lines are flagged, never dropped', () => {
    expect(evaluateLines([{ ...base, saleable: false }])).toEqual([
      {
        code: 'ITEM_UNAVAILABLE',
        variantId: 'v1',
        detail: 'item is not currently saleable at this store',
      },
    ]);
    expect(evaluateLines([{ ...base, available: 0n }])).toEqual([
      {
        code: 'ITEM_UNAVAILABLE',
        variantId: 'v1',
        detail: 'item is not currently saleable at this store',
      },
    ]);
  });
  it('price moves are flagged with both values', () => {
    expect(evaluateLines([{ ...base, currentUnitPricePaise: 1250n }])).toEqual([
      { code: 'PRICE_CHANGED', variantId: 'v1', detail: 'price moved from 1000 to 1250' },
    ]);
  });
  it('quantities over availability are flagged with the clamp', () => {
    expect(evaluateLines([{ ...base, storedQuantity: 5n, available: 3n }])).toEqual([
      { code: 'QTY_REDUCED', variantId: 'v1', detail: 'quantity reduced to 3' },
    ]);
  });
  it('a clean line produces no issues and multiple problems can coexist', () => {
    expect(evaluateLines([base])).toEqual([]);
    expect(
      evaluateLines([{ ...base, storedQuantity: 5n, available: 3n, currentUnitPricePaise: 900n }]),
    ).toEqual([
      { code: 'PRICE_CHANGED', variantId: 'v1', detail: 'price moved from 1000 to 900' },
      { code: 'QTY_REDUCED', variantId: 'v1', detail: 'quantity reduced to 3' },
    ]);
  });
});
describe('optimistic version guard', () => {
  it('accepts safe integers above zero', () => {
    expect(expectedVersion(1)).toBe(1);
    expect(() => expectedVersion(0)).toThrow('INVALID_INPUT');
    expect(() => expectedVersion(1.5)).toThrow('INVALID_INPUT');
  });
  it('mismatched versions conflict', () => {
    expect(() => requireVersion(3n, 2n as unknown as number)).toThrow('CONCURRENT_MODIFICATION');
    expect(() => requireVersion(3n, 3)).not.toThrow();
    expect(() => requireVersion(3n, 4)).toThrow('CONCURRENT_MODIFICATION');
  });
});
