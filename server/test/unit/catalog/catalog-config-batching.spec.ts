import { jest } from '@jest/globals';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import { PostgresCatalogQuery } from '../../../src/modules/catalog/infrastructure/catalog-query.js';
import { fakeDatabase } from '../helpers/fake-db.js';

function catalog(config: AppConfig) {
  const { db, queries } = fakeDatabase((query) => {
    if (query.sql.includes('FROM addresses a JOIN delivery_pincodes'))
      return { rows: [{ store_id: 's1' }] };
    return { rows: [] };
  });
  return { query: new PostgresCatalogQuery(db, config), queries };
}

test('reads catalog tunables through one getMany', async () => {
  const getMany = jest.fn(async () => ({ catalogLowStockThreshold: 5, catalogMaxPerOrder: 10 }));
  const get = jest.fn(async () => {
    throw new Error('must not fall back');
  });
  const { query } = catalog({ getMany, get } as unknown as AppConfig);
  const result = await query.list('u1', undefined, {});
  expect(result).toMatchObject({ items: [], nextCursor: null });
  expect(typeof result.etag).toBe('string');
  expect(getMany).toHaveBeenCalledTimes(1);
  expect(getMany).toHaveBeenCalledWith(['catalogLowStockThreshold', 'catalogMaxPerOrder']);
  expect(get).not.toHaveBeenCalled();
});

test('falls back to sequential gets when getMany is unavailable', async () => {
  const get = jest.fn(async (key: string) => (key === 'catalogLowStockThreshold' ? 5 : 10));
  const { query } = catalog({ get } as unknown as AppConfig);
  await query.list('u1', undefined, {});
  expect(get).toHaveBeenCalledTimes(2);
});
