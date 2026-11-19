/// <reference types="jest" />
import { customerApi } from '../src/api/customer';
import {
  clearCatalogCache, fetchCatalogPage, getCachedCatalogPage, invalidateFavoritesCache, isCatalogPageFresh,
  sameCatalogItems, setCachedCatalogPage, type CatalogQuery,
} from '../src/store/catalog-cache';

jest.mock('../src/api/customer', () => ({
  CATALOG_PAGE_LIMIT: 24,
  customerApi: { catalog: jest.fn(), category: jest.fn(), favoriteProducts: jest.fn(), search: jest.fn() },
}));
const api = jest.mocked(customerApi);
const item = (variantId: string, sellingPaise = '1000') => ({
  productId: 'product', name: 'Milk', description: '', categoryId: 'dairy', brandId: null,
  variantId, variantName: '500 ml', sku: variantId, sellingPaise, mrpPaise: '1200',
  discountPercent: 0, availability: 'IN_STOCK' as const, maxPerOrder: 10, images: [],
});
const query = (overrides: Partial<CatalogQuery> = {}): CatalogQuery => ({
  userId: 'user-1', addressId: 'address-1', kind: 'home', key: '', cursor: null, ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  clearCatalogCache();
});

test('keys entries by account, address, filter, and cursor', () => {
  setCachedCatalogPage(query(), { items: [item('a')], nextCursor: null });
  expect(getCachedCatalogPage(query())?.items).toHaveLength(1);
  expect(getCachedCatalogPage(query({ userId: 'user-2' }))).toBeUndefined();
  expect(getCachedCatalogPage(query({ addressId: 'address-2' }))).toBeUndefined();
  expect(getCachedCatalogPage(query({ kind: 'category', key: 'dairy' }))).toBeUndefined();
  expect(getCachedCatalogPage(query({ cursor: 'next' }))).toBeUndefined();
});

test('treats entries older than 60 seconds as stale', () => {
  const now = Date.now();
  expect(isCatalogPageFresh({ items: [], nextCursor: null, fetchedAt: now - 59_999 }, now)).toBe(true);
  expect(isCatalogPageFresh({ items: [], nextCursor: null, fetchedAt: now - 60_000 }, now)).toBe(false);
});

test('deduplicates concurrent requests for the same page', async () => {
  let finish!: (value: { items: ReturnType<typeof item>[]; nextCursor: null }) => void;
  api.catalog.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const first = fetchCatalogPage(query(), 'token');
  const second = fetchCatalogPage(query(), 'token');
  expect(api.catalog).toHaveBeenCalledTimes(1);
  expect(api.catalog).toHaveBeenCalledWith('token', 'address-1', undefined);
  finish({ items: [item('a')], nextCursor: null });
  await expect(first).resolves.toMatchObject({ nextCursor: null });
  await expect(second).resolves.toMatchObject({ nextCursor: null });
  expect(getCachedCatalogPage(query())?.items).toHaveLength(1);
});

test('requests 24 variants per addressed page', async () => {
  const real = jest.requireActual('../src/api/customer') as typeof import('../src/api/customer');
  const fetchMock = jest.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 })));
  const previousFetch = globalThis.fetch;
  const previousUrl = process.env.EXPO_PUBLIC_API_URL;
  process.env.EXPO_PUBLIC_API_URL = 'http://192.168.1.10:3000/';
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    await real.customerApi.catalog('token', 'address-1');
    await real.customerApi.search('token', 'address-1', 'milk');
    await real.customerApi.category('token', 'address-1', 'dairy');
    await real.customerApi.favoriteProducts('token', 'address-1');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const call of fetchMock.mock.calls) expect(String(call[0])).toContain('limit=24');
  } finally {
    globalThis.fetch = previousFetch;
    process.env.EXPO_PUBLIC_API_URL = previousUrl;
  }
});

test('does not cache failures, and clears one account without touching another', async () => {
  api.catalog.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [item('a')], nextCursor: null });
  await expect(fetchCatalogPage(query(), 'token')).rejects.toThrow('offline');
  await expect(fetchCatalogPage(query(), 'token')).resolves.toMatchObject({ nextCursor: null });
  expect(api.catalog).toHaveBeenCalledTimes(2);
  setCachedCatalogPage(query({ userId: 'user-2' }), { items: [item('b')], nextCursor: null });
  clearCatalogCache('user-1');
  expect(getCachedCatalogPage(query())).toBeUndefined();
  expect(getCachedCatalogPage(query({ userId: 'user-2' }))?.items).toHaveLength(1);
});

test('invalidating favorites clears only favorites and blocks pre-save replies', async () => {
  setCachedCatalogPage(query({ kind: 'favorites', key: 'favorites' }), { items: [item('a')], nextCursor: null });
  setCachedCatalogPage(query({ kind: 'home' }), { items: [item('b')], nextCursor: null });
  invalidateFavoritesCache('user-1');
  expect(getCachedCatalogPage(query({ kind: 'favorites', key: 'favorites' }))).toBeUndefined();
  expect(getCachedCatalogPage(query({ kind: 'home' }))?.items).toHaveLength(1);
  // A favorites fetch started before the save must not repopulate the refreshed cache.
  let finish!: (value: { items: ReturnType<typeof item>[]; nextCursor: null }) => void;
  api.favoriteProducts.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const stale = fetchCatalogPage(query({ kind: 'favorites', key: 'favorites' }), 'token');
  invalidateFavoritesCache('user-1');
  finish({ items: [item('a2')], nextCursor: null });
  await expect(stale).resolves.toMatchObject({ nextCursor: null });
  expect(getCachedCatalogPage(query({ kind: 'favorites', key: 'favorites' }))).toBeUndefined();
});

test('reuses tile arrays only when the visible offer is unchanged', () => {
  expect(sameCatalogItems([item('a')], [item('a')])).toBe(true);
  expect(sameCatalogItems([item('a')], [item('a', '1100')])).toBe(false);
  expect(sameCatalogItems([item('a')], [item('b')])).toBe(false);
  expect(sameCatalogItems([item('a')], [])).toBe(false);
});
