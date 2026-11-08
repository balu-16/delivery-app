import {
  checkCouponRules,
  eligibleLines,
  normalizeCode,
  parseCouponDraft,
  parseCouponPatch,
  parseCouponValue,
} from '../../../src/modules/coupons/domain/coupon-policy.js';

const draft = () => ({
  code: ' save20 ',
  kind: 'PERCENT' as const,
  valuePaise: '2000',
  maxCapPaise: '5000',
  minOrderPaise: '10000',
  perUserLimit: 2,
  globalLimit: 100,
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: '2026-12-31T23:59:59.000Z',
  storeId: '01800000-0000-7000-8000-000000000011',
  categoryId: null,
  productId: null,
  excludedVariantIds: [],
  stackable: false,
  firstOrderOnly: false,
});

describe('code normalization', () => {
  it('trims, uppercases and validates the shape', () => {
    expect(normalizeCode('  save20  ')).toBe('SAVE20');
    expect(normalizeCode('ab-1_2')).toBe('AB-1_2');
  });
  it('rejects empty, short, punctuated or overlong codes', () => {
    for (const bad of ['', '   ', 'ab', 'a'.repeat(41), 'has space', 'naïve', 'code!'])
      expect(() => normalizeCode(bad)).toThrow('INVALID_COUPON_CODE');
  });
});
describe('value parsing per kind', () => {
  it('percent values are basis points between 1 and 10000', () => {
    expect(parseCouponValue('PERCENT', '5000')).toBe(5000n);
    expect(() => parseCouponValue('PERCENT', '10001')).toThrow('INVALID_INPUT');
    expect(() => parseCouponValue('PERCENT', '0')).toThrow('INVALID_INPUT');
  });
  it('flat values are positive paise; free delivery is zero', () => {
    expect(parseCouponValue('FLAT', '500')).toBe(500n);
    expect(() => parseCouponValue('FLAT', '0')).toThrow('INVALID_INPUT');
    expect(parseCouponValue('FREE_DELIVERY', '0')).toBe(0n);
    expect(() => parseCouponValue('FREE_DELIVERY', '1')).toThrow('INVALID_INPUT');
  });
});
describe('draft validation', () => {
  it('accepts a well-formed draft and normalizes nothing silently', () => {
    expect(() => parseCouponDraft(draft())).not.toThrow();
  });
  it('rejects inverted validity windows and malformed scopes', () => {
    expect(() => parseCouponDraft({ ...draft(), validFrom: '2027-01-01T00:00:00.000Z' })).toThrow(
      'INVALID_INPUT:window',
    );
    expect(() => parseCouponDraft({ ...draft(), storeId: 'not-a-uuid' })).toThrow(
      'INVALID_INPUT:scope',
    );
    expect(() => parseCouponDraft({ ...draft(), excludedVariantIds: ['nope'] })).toThrow(
      'INVALID_INPUT:exclusions',
    );
    expect(() => parseCouponDraft({ ...draft(), perUserLimit: 0 })).toThrow('INVALID_INPUT');
    expect(() => parseCouponDraft({ ...draft(), maxCapPaise: '0' })).toThrow('INVALID_INPUT');
    expect(() => parseCouponDraft({ ...draft(), valuePaise: '-5' })).toThrow('INVALID_MONEY');
  });
});
describe('patch validation', () => {
  it('keeps only whitelisted fields and validates them', () => {
    const patch = parseCouponPatch({
      perUserLimit: 3,
      globalLimit: null,
      minOrderPaise: '200',
      active: true,
    } as never);
    expect(patch).toEqual({
      perUserLimit: 3,
      globalLimit: null,
      minOrderPaise: '200',
      active: true,
    });
  });
  it('rejects bad limits, windows and types', () => {
    expect(() => parseCouponPatch({ perUserLimit: 0 })).toThrow('INVALID_INPUT');
    expect(() => parseCouponPatch({ validTo: 'not-a-date' })).toThrow('INVALID_INPUT:validTo');
    expect(() => parseCouponPatch({ active: 'yes' as never })).toThrow('INVALID_INPUT');
    expect(() => parseCouponPatch({ minOrderPaise: '-2' })).toThrow('INVALID_MONEY');
  });
});
describe('rule checks', () => {
  const rules = () => ({
    active: true,
    validFrom: null,
    validTo: null,
    minOrderPaise: '1000',
    storeId: null,
    categoryId: null,
    productId: null,
    excludedVariantIds: [],
  });
  const input = () => ({
    storeId: '01800000-0000-7000-8000-000000000011',
    subtotalPaise: 5000n,
    lines: [
      {
        variantId: '01800000-0000-7000-8000-0000000000a1',
        productId: '01800000-0000-7000-8000-0000000000b1',
        categoryId: '01800000-0000-7000-8000-0000000000c1',
        quantity: 1n,
        unitPricePaise: 5000n,
      },
    ],
  });
  it('inactive coupons are invalid and expired windows surface their own code', () => {
    expect(() => checkCouponRules({ ...rules(), active: false }, new Date(), input())).toThrow(
      'COUPON_INVALID',
    );
    expect(() =>
      checkCouponRules({ ...rules(), validTo: '2020-01-01T00:00:00.000Z' }, new Date(), input()),
    ).toThrow('COUPON_EXPIRED');
    expect(() =>
      checkCouponRules({ ...rules(), validFrom: '2120-01-01T00:00:00.000Z' }, new Date(), input()),
    ).toThrow('COUPON_EXPIRED');
  });
  it('store scope and minimum order gate eligibility', () => {
    expect(() =>
      checkCouponRules(
        { ...rules(), storeId: '01800000-0000-7000-8000-000000000099' },
        new Date(),
        input(),
      ),
    ).toThrow('COUPON_NOT_ELIGIBLE');
    expect(() =>
      checkCouponRules({ ...rules(), minOrderPaise: '9000' }, new Date(), input()),
    ).toThrow('COUPON_NOT_ELIGIBLE');
  });
  it('excluded items and narrow scope leave no eligible lines', () => {
    expect(() =>
      checkCouponRules(
        { ...rules(), excludedVariantIds: ['01800000-0000-7000-8000-0000000000a1'] },
        new Date(),
        input(),
      ),
    ).toThrow('COUPON_NOT_ELIGIBLE');
    expect(() =>
      checkCouponRules(
        { ...rules(), categoryId: '01800000-0000-7000-8000-0000000000ff' },
        new Date(),
        input(),
      ),
    ).toThrow('COUPON_NOT_ELIGIBLE');
    expect(() =>
      checkCouponRules(
        { ...rules(), productId: '01800000-0000-7000-8000-0000000000ff' },
        new Date(),
        input(),
      ),
    ).toThrow('COUPON_NOT_ELIGIBLE');
    expect(() => checkCouponRules(rules(), new Date(), input())).not.toThrow();
  });
  it('eligible lines honour exclusions, category and product scope together', () => {
    const lines = [
      {
        variantId: 'a',
        productId: 'p1',
        categoryId: 'c1',
        quantity: 1n,
        unitPricePaise: 100n,
      },
      {
        variantId: 'b',
        productId: 'p1',
        categoryId: 'c2',
        quantity: 2n,
        unitPricePaise: 100n,
      },
      {
        variantId: 'c',
        productId: 'p2',
        categoryId: 'c1',
        quantity: 3n,
        unitPricePaise: 100n,
      },
    ];
    expect(eligibleLines(lines, { categoryId: null, productId: null }, ['b'])).toHaveLength(2);
    expect(eligibleLines(lines, { categoryId: 'c1', productId: null }, [])).toEqual([
      lines[0],
      lines[2],
    ]);
    expect(eligibleLines(lines, { categoryId: null, productId: 'p1' }, [])).toEqual([
      lines[0],
      lines[1],
    ]);
    expect(eligibleLines(lines, { categoryId: 'c1', productId: 'p1' }, [])).toEqual([lines[0]]);
    expect(eligibleLines(lines, { categoryId: null, productId: null }, [])).toHaveLength(3);
  });
});
