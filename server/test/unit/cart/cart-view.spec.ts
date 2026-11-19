import { jest } from '@jest/globals';
import type { Database } from '../../../src/platform/database/database.js';
import { evaluateCartLines } from '../../../src/modules/cart/infrastructure/cart-evaluation.js';

test('an out-of-stock cart item can still show its changed shared price', async () => {
  const rows = [
    {
      variant_id: 'variant',
      quantity: '1',
      unit_price_paise: '10000',
      mrp_paise: '10000',
      product_id: 'product',
      product_name: 'Milk',
      variant_name: '500 ml',
      image_id: null,
      category_id: 'dairy',
      gst_rate_bps: 0,
      published: true,
      product_deleted: null,
      variant_deleted: null,
      fresh_price: '12500',
      fresh_mrp: '12500',
      price_id: 'price',
      available: '0',
    },
  ];
  const executor = {
    transformQuery: (query: unknown) => query,
    compileQuery: (query: unknown) => query,
    executeQuery: jest.fn(async () => ({ rows })),
  };
  const db = { getExecutor: () => executor } as unknown as Database;
  const result = await evaluateCartLines(db, {
    id: 'cart',
    user_id: 'user',
    store_id: 'store',
    address_id: 'address',
    coupon_code: null,
    version: '1',
  });
  expect(result.issues.map((issue) => issue.code)).toEqual(['ITEM_UNAVAILABLE', 'PRICE_CHANGED']);
  expect(result.lines[0]?.freshUnitPricePaise).toBe(12500n);
});
