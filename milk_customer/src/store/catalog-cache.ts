import { CATALOG_PAGE_LIMIT, customerApi, type CatalogPage } from '../api/customer';

export { CATALOG_PAGE_LIMIT };
/** Fresh entries render immediately; stale entries render while a refresh runs. */
export const CATALOG_CACHE_TTL_MS = 60_000;

export type CatalogKind = 'home' | 'search' | 'category' | 'favorites';
export type CatalogQuery = {
  userId: string; addressId: string; kind: CatalogKind; key: string; cursor: string | null;
};
export type CachedCatalogPage = { items: CatalogPage['items']; nextCursor: string | null; fetchedAt: number };

const entries = new Map<string, CachedCatalogPage>();
const inFlight = new Map<string, Promise<CatalogPage>>();
let cacheEpoch = 0;
let favoritesEpoch = 0;

export function catalogCacheKey(query: CatalogQuery): string {
  return `${query.userId}\n${query.addressId}\n${query.kind}\n${query.key}\n${query.cursor ?? ''}`;
}

export function getCachedCatalogPage(query: CatalogQuery): CachedCatalogPage | undefined {
  return entries.get(catalogCacheKey(query));
}

export function isCatalogPageFresh(page: CachedCatalogPage, now: number = Date.now()): boolean {
  return now - page.fetchedAt < CATALOG_CACHE_TTL_MS;
}

export function setCachedCatalogPage(query: CatalogQuery, page: CatalogPage, now: number = Date.now()): void {
  entries.set(catalogCacheKey(query), { items: page.items, nextCursor: page.nextCursor, fetchedAt: now });
}

/**
 * Drop every Favorites page for one account after a confirmed save, and
 * forget pre-save in-flight Favorites responses so an older reply cannot
 * repopulate the refreshed cache. Other kinds keep their cache.
 */
export function invalidateFavoritesCache(userId: string): void {
  favoritesEpoch++;
  const prefix = `${userId}\n`;
  for (const key of [...entries.keys()]) {
    if (key.startsWith(prefix) && key.split('\n')[2] === 'favorites') entries.delete(key);
  }
  for (const key of [...inFlight.keys()]) {
    if (key.startsWith(prefix) && key.split('\n')[2] === 'favorites') inFlight.delete(key);
  }
}

/** Clear cached pages (and in-flight dedup) for one account, or for every account on sign-out. */
export function clearCatalogCache(userId?: string): void {
  if (userId === undefined) {
    cacheEpoch++;
    entries.clear();
    inFlight.clear();
    return;
  }
  const prefix = `${userId}\n`;
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
  for (const key of [...inFlight.keys()]) if (key.startsWith(prefix)) inFlight.delete(key);
}

/**
 * Fetch one addressed page through the shared cache. Concurrent callers for the same
 * account+address+filter+cursor share one request. Successful replies are cached;
 * failures are not. Callers still discard replies that arrive after an address,
 * session, or filter change.
 */
export function fetchCatalogPage(query: CatalogQuery, token: string): Promise<CatalogPage> {
  const key = catalogCacheKey(query);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const epoch = cacheEpoch;
  const favEpoch = favoritesEpoch;
  const task = (async (): Promise<CatalogPage> => {
    const cursor = query.cursor ?? undefined;
    switch (query.kind) {
      case 'home': return customerApi.catalog(token, query.addressId, cursor);
      case 'search': return customerApi.search(token, query.addressId, query.key, cursor);
      case 'category': return customerApi.category(token, query.addressId, query.key, cursor);
      case 'favorites': return customerApi.favoriteProducts(token, query.addressId, cursor);
    }
  })();
  const tracked = task.then(page => {
    if (epoch === cacheEpoch && (query.kind !== 'favorites' || favEpoch === favoritesEpoch)) {
      setCachedCatalogPage(query, page);
    }
    return page;
  });
  inFlight.set(key, tracked);
  const release = () => { if (inFlight.get(key) === tracked) inFlight.delete(key); };
  tracked.then(release, release);
  return tracked;
}

/** True when two pages show the same tiles, so the previous array can be reused for stable props. */
export function sameCatalogItems(a: CatalogPage['items'], b: CatalogPage['items']): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return item.variantId === other.variantId && item.sellingPaise === other.sellingPaise &&
      item.mrpPaise === other.mrpPaise && item.availability === other.availability;
  });
}
