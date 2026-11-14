import { jest } from '@jest/globals';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import { PostgresCatalogQuery } from '../../../src/modules/catalog/infrastructure/catalog-query.js';
import type { Database } from '../../../src/platform/database/database.js';

function database(rows: unknown[]) {
  const execute = jest.fn(async () => ({ rows }));
  const executor = {
    transformQuery: (query: unknown) => query,
    compileQuery: (query: unknown) => query,
    executeQuery: execute,
  };
  return { db: { getExecutor: () => executor } as unknown as Database, execute };
}

const item = {
  product_id: 'product',
  name: 'Milk',
  description: 'Test',
  category_id: 'category',
  variant_id: 'variant',
  variant_name: '500 ml',
  selling_paise: '3500',
  mrp_paise: '4000',
  images: [{ id: 'image', key: 'public/milk.png' }],
};

test('does not expose a catalog when a preview store was not configured', async () => {
  const { db, execute } = database([item]);
  const query = new PostgresCatalogQuery(db, {} as AppConfig);
  await expect(query.preview()).resolves.toEqual({ items: [] });
  expect(execute).not.toHaveBeenCalled();
});

test('returns the configured store price and images without claiming address-specific stock', async () => {
  const { db } = database([item]);
  const query = new PostgresCatalogQuery(
    db,
    {} as AppConfig,
    'https://cdn.example.test',
    undefined,
    '01800000-0000-7000-8000-000000000011',
  );
  const result = await query.preview();
  expect(result.items).toEqual([
    expect.objectContaining({
      name: 'Milk',
      sellingPaise: '3500',
      mrpPaise: '4000',
      discountPercent: 12,
      images: ['https://cdn.example.test/public/milk.png'],
    }),
  ]);
  expect(result.items[0]).not.toHaveProperty('availability');
  expect(result.items[0]).not.toHaveProperty('remaining');
});

test('uses the public media route when there is no CDN and handles zero MRP', async () => {
  const { db } = database([{ ...item, selling_paise: '0', mrp_paise: '0' }]);
  const query = new PostgresCatalogQuery(
    db,
    {} as AppConfig,
    undefined,
    undefined,
    '01800000-0000-7000-8000-000000000011',
  );
  const result = await query.preview();
  expect(result.items[0]).toMatchObject({ discountPercent: 0, images: ['/media/image'] });
});

test('preview route retains customer authentication and disables caching', async () => {
  await import('reflect-metadata');
  const { CustomerCatalogController } =
    await import('../../../src/surfaces/customer/catalog/customer.controller.js');
  const { AUTH_POLICY } = await import('../../../src/modules/identity/contracts/http.js');
  const { GUARDS_METADATA } = await import('@nestjs/common/constants');
  const { IdentityGuard } =
    await import('../../../src/modules/identity/contracts/identity-guard.js');
  const preview = jest.fn(async () => ({ items: [] }));
  const controller = new CustomerCatalogController({ preview } as never, {} as never);
  const header = jest.fn();
  expect(Reflect.getMetadata(AUTH_POLICY, CustomerCatalogController)).toMatchObject({
    audience: 'customer',
  });
  expect(Reflect.getMetadata(GUARDS_METADATA, CustomerCatalogController)).toContain(IdentityGuard);
  await expect(controller.preview({ header } as never)).resolves.toEqual({ items: [] });
  expect(header).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  expect(preview).toHaveBeenCalledTimes(1);
});
