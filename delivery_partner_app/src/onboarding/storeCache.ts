import { riderApi, type OnboardingStore } from "../api";

/**
 * Session-scoped store-list cache. The picker fetches on open when needed and
 * reuses the result within the signed-in session; an account switch never
 * shares rows across accounts.
 */
type CacheEntry = {
  stores: OnboardingStore[];
  fetchedAt: number;
};

const cacheByAccount = new Map<string, CacheEntry>();
const inFlightByAccount = new Map<string, Promise<OnboardingStore[]>>();

export function peekCachedStores(accountId: string): OnboardingStore[] | null {
  return cacheByAccount.get(accountId)?.stores ?? null;
}

export async function fetchStoresIfNeeded(accountId: string, force = false): Promise<OnboardingStore[]> {
  if (!force) {
    const cached = cacheByAccount.get(accountId);
    if (cached) return cached.stores;
    const inFlight = inFlightByAccount.get(accountId);
    if (inFlight) return inFlight;
  }
  const task = (async () => {
    try {
      const stores = await riderApi.onboardingStores();
      cacheByAccount.set(accountId, { stores, fetchedAt: Date.now() });
      return stores;
    } finally {
      inFlightByAccount.delete(accountId);
    }
  })();
  inFlightByAccount.set(accountId, task);
  return task;
}

/** Clears one account's cache (sign-out / account switch). Test-only helper. */
export function clearStoreCache(accountId?: string) {
  if (accountId) {
    cacheByAccount.delete(accountId);
    inFlightByAccount.delete(accountId);
    return;
  }
  cacheByAccount.clear();
  inFlightByAccount.clear();
}

/** Local case-insensitive filter over the cached list by store name and city. */
export function filterStores(stores: OnboardingStore[], query: string): OnboardingStore[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return stores;
  return stores.filter(
    (store) =>
      store.name.toLowerCase().includes(needle) || store.city.toLowerCase().includes(needle),
  );
}
