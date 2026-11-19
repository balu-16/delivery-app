import { customerApi, type DeliverySettings, type FeeEstimateBand } from '../api/customer';

/** Delivery-settings entries are shared between Cart and checkout for 60 seconds. */
export const FEES_CACHE_TTL_MS = 60_000;

export type CachedDeliverySettings = { settings: DeliverySettings; fetchedAt: number };

const entries = new Map<string, CachedDeliverySettings>();
const inFlight = new Map<string, Promise<DeliverySettings>>();
let cacheEpoch = 0;

export function getCachedDeliverySettings(userId: string): CachedDeliverySettings | undefined {
  return entries.get(userId);
}

export function isDeliverySettingsFresh(entry: CachedDeliverySettings, now: number = Date.now()): boolean {
  return now - entry.fetchedAt < FEES_CACHE_TTL_MS;
}

export function setCachedDeliverySettings(userId: string, settings: DeliverySettings, now: number = Date.now()): void {
  entries.set(userId, { settings, fetchedAt: now });
}

/** Clear cached settings (and in-flight dedup) for one account, or for every account on sign-out. */
export function clearFeesCache(userId?: string): void {
  if (userId === undefined) {
    cacheEpoch++;
    entries.clear();
    inFlight.clear();
    return;
  }
  entries.delete(userId);
  inFlight.delete(userId);
}

/**
 * Fetch delivery settings through the shared cache. Concurrent callers for the
 * same account share one request. Successful replies are cached; failures are
 * not, so a failed refresh keeps the last estimate visible.
 */
export function fetchDeliverySettings(userId: string, token: string): Promise<DeliverySettings> {
  const pending = inFlight.get(userId);
  if (pending) return pending;
  const epoch = cacheEpoch;
  const tracked = customerApi.deliverySettings(token).then(settings => {
    if (epoch === cacheEpoch) setCachedDeliverySettings(userId, settings);
    return settings;
  });
  inFlight.set(userId, tracked);
  const release = () => { if (inFlight.get(userId) === tracked) inFlight.delete(userId); };
  tracked.then(release, release);
  return tracked;
}

/**
 * Look up the first band whose inclusive ceiling covers the displayed subtotal.
 * Bands are ordered; a null ceiling marks the final band. Returns null when
 * there are no bands, so callers keep the subtotal without an estimate.
 */
export function lookupFeeBand(bands: FeeEstimateBand[], subtotalPaise: string): FeeEstimateBand | null {
  let subtotal: bigint;
  try {
    subtotal = BigInt(subtotalPaise);
  } catch {
    return null;
  }
  for (const band of bands) {
    if (band.upToSubtotalPaise === null) return band;
    try {
      if (subtotal <= BigInt(band.upToSubtotalPaise)) return band;
    } catch {
      return null;
    }
  }
  return null;
}

/** Total estimated charges for one band, as decimal-string paise. */
export function feeBandTotalPaise(band: FeeEstimateBand): string {
  return (BigInt(band.deliveryPaise) + BigInt(band.handlingPaise) +
    BigInt(band.smallCartPaise) + BigInt(band.surgePaise)).toString();
}
