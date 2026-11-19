import { jest } from '@jest/globals';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import { PostgresQuotes } from '../../../src/modules/cart/infrastructure/postgres-quotes.js';
import { fakeDatabase } from '../helpers/fake-db.js';

const CART = {
  id: 'c1',
  user_id: 'u1',
  store_id: 's1',
  address_id: 'a1',
  coupon_code: null,
  version: '1',
};
const LINE = {
  variant_id: 'v1',
  quantity: '2',
  unit_price_paise: '100',
  mrp_paise: '120',
  product_id: 'p1',
  product_name: 'Milk',
  variant_name: '500 ml',
  image_id: null,
  category_id: null,
  gst_rate_bps: 0,
  published: true,
  product_deleted: null,
  variant_deleted: null,
  fresh_price: '100',
  fresh_mrp: '120',
  price_id: 'price1',
  available: '10',
};
const FEE_SETTINGS = {
  deliveryFeeSlabs: [
    { maxOrderValuePaise: '20000', feePaise: '4000' },
    { maxOrderValuePaise: null, feePaise: '2000' },
  ],
  freeDeliveryThresholdPaise: '59900',
  handlingFeePaise: '500',
  smallCartThresholdPaise: '19900',
  smallCartFeePaise: '1500',
  surgeFeePaise: '0',
  feeTaxRules: [],
  minOrderPaise: '0',
  maxOrderPaise: '100000000',
};

test('refreshWithCart returns the quote and cart from one evaluation', async () => {
  const { db, queries } = fakeDatabase((query) => {
    if (query.sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
    if (query.sql.includes('FROM addresses a JOIN delivery_pincodes'))
      return { rows: [{ store_id: 's1' }] };
    if (query.sql.includes('FROM carts WHERE user_id')) return { rows: [CART] };
    if (query.sql.includes('FROM cart_items ci')) return { rows: [LINE] };
    if (query.sql.includes('FROM catalog_revision WHERE singleton'))
      return { rows: [{ revision: '5' }] };
    if (query.sql.includes('FROM app_config')) return { rows: [{ version: '9' }] };
    if (query.sql.includes("key='surge_enabled'")) return { rows: [{ enabled: false }] };
    if (query.sql.includes('FROM referral_claims')) return { rows: [] };
    if (query.sql.includes('clock_timestamp() AS now')) return { rows: [{ now: new Date() }] };
    return { rows: [] };
  });
  const getMany = jest.fn(async () => FEE_SETTINGS);
  const get = jest.fn(async () => 900);
  const config = { getMany, get } as unknown as AppConfig;
  const quotes = new PostgresQuotes(db, config, {} as never);
  const { quote, cart } = await quotes.refreshWithCart({ userId: 'u1', addressId: 'a1' });
  expect(quote.cartId).toBe('c1');
  expect(quote.cartVersion).toBe(1);
  expect(cart.cartId).toBe(quote.cartId);
  expect(cart.version).toBe(quote.cartVersion);
  expect(cart.storeId).toBe(quote.storeId);
  expect(cart.lines).toHaveLength(1);
  expect(cart.lines[0]).toMatchObject({ variantId: 'v1', quantity: '2', unitPricePaise: '100' });
  // The cart lines are read once and shared by the quote and the cart view.
  expect(queries.filter((query) => query.sql.includes('FROM cart_items ci'))).toHaveLength(1);
  expect(quote.subtotalPaise).toBe('200');
});
