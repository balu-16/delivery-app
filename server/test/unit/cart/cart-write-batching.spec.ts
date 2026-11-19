import { jest } from '@jest/globals';
import type { CompiledQuery } from 'kysely';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import { PostgresCartService } from '../../../src/modules/cart/infrastructure/postgres-carts.js';
import { fakeDatabase } from '../helpers/fake-db.js';

const CART = {
  id: 'c1',
  user_id: 'u1',
  store_id: 's1',
  address_id: 'a1',
  coupon_code: null,
  version: '1',
};

function service(
  route: (query: CompiledQuery) => { rows: unknown[] },
  metrics?: { observeStage: (...args: unknown[]) => void },
) {
  const { db, queries } = fakeDatabase(route);
  const config = {
    getMany: async () => ({ catalogMaxPerOrder: 10, maxCartLines: 50 }),
  } as unknown as AppConfig;
  return {
    service: new PostgresCartService(db, config, {} as never, metrics as never),
    queries,
  };
}

function routeFor(combined: unknown, bumpedVersion: string) {
  return (query: CompiledQuery): { rows: unknown[] } => {
    if (query.sql.includes('pg_advisory_xact_lock')) return { rows: [{ ok: true }] };
    if (query.sql.includes('FROM carts WHERE user_id')) return { rows: [CART] };
    if (query.sql.includes('FROM catalog_global_prices p JOIN catalog_variants'))
      return { rows: [combined] };
    if (query.sql.includes('UPDATE carts SET version=version+1'))
      return { rows: [{ ...CART, version: bumpedVersion }] };
    if (query.sql.includes('FROM cart_items ci')) return { rows: [] };
    return { rows: [] };
  };
}

const FRESH_LINE = {
  selling_paise: '100',
  mrp_paise: '120',
  gst_rate_bps: 0,
  existing_quantity: null,
  existing_unit_price: null,
  line_count: '0',
};

test('inserts a new line and bumps the version in one statement after one read', async () => {
  const { service: carts, queries } = service(routeFor(FRESH_LINE, '2'));
  const result = await carts.putItem('u1', 'v1', '2', { expectedVersion: 1 });
  expect(result.cart.version).toBe(2);
  expect(result.clamped).toBe(false);
  const reads = queries.filter((query) =>
    query.sql.includes('FROM catalog_global_prices p JOIN catalog_variants'),
  );
  expect(reads).toHaveLength(1);
  expect(reads[0]!.sql).toContain('existing_quantity');
  expect(reads[0]!.sql).toContain('line_count');
  const writes = queries.filter((query) =>
    query.sql.includes('UPDATE carts SET version=version+1'),
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]!.sql).toContain('INSERT INTO cart_items');
  // No separate line SELECT, count SELECT, line write or version UPDATE.
  expect(queries.filter((query) => query.sql.includes('SELECT count(*)::text AS n'))).toHaveLength(
    0,
  );
});

test('updates an existing line and bumps the version in one statement', async () => {
  const { service: carts, queries } = service(
    routeFor({ ...FRESH_LINE, existing_quantity: '1', existing_unit_price: '100' }, '2'),
  );
  const result = await carts.putItem('u1', 'v1', '3', { expectedVersion: 1 });
  expect(result.cart.version).toBe(2);
  const writes = queries.filter((query) =>
    query.sql.includes('UPDATE carts SET version=version+1'),
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]!.sql).toContain('UPDATE cart_items SET quantity');
});

test('preserves price acceptance, line limits and version guards', async () => {
  const full = service(routeFor({ ...FRESH_LINE, line_count: '50' }, '2'));
  await expect(full.service.putItem('u1', 'v1', '1', { expectedVersion: 1 })).rejects.toThrow(
    'INVALID_INPUT',
  );
  const stale = service(routeFor(FRESH_LINE, '2'));
  await expect(
    stale.service.putItem('u1', 'v1', '1', {
      expectedVersion: 1,
      displayedUnitPricePaise: '90',
    }),
  ).rejects.toThrow('PRICE_CHANGED');
  const conflict = service(routeFor(FRESH_LINE, '2'));
  await expect(conflict.service.putItem('u1', 'v1', '1', { expectedVersion: 7 })).rejects.toThrow(
    'CONCURRENT_MODIFICATION',
  );
});

test('records lock wait for the cart write', async () => {
  const observeStage = jest.fn();
  const { service: carts } = service(routeFor(FRESH_LINE, '2'), { observeStage });
  await carts.putItem('u1', 'v1', '1', { expectedVersion: 1 });
  expect(observeStage).toHaveBeenCalledWith('cart_lock_wait', expect.any(Number));
});

test('rejects unavailable items without writing', async () => {
  const { service: carts, queries } = service((query) => {
    if (query.sql.includes('pg_advisory_xact_lock')) return { rows: [{ ok: true }] };
    if (query.sql.includes('FROM carts WHERE user_id')) return { rows: [CART] };
    return { rows: [] };
  });
  await expect(carts.putItem('u1', 'v1', '1', { expectedVersion: 1 })).rejects.toThrow(
    'ITEM_UNAVAILABLE',
  );
  expect(queries.some((query) => query.sql.includes('UPDATE carts SET'))).toBe(false);
});
