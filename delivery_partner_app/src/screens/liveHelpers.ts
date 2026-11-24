/**
 * Account-scoped request registry for live reads.
 *
 * Each read is registered under `resource` (optionally suffixed with a record
 * ID) for one account subject. Concurrent callers asking for the same key
 * share a single in-flight request instead of issuing duplicate reads.
 * `invalidateLiveRequests()` (navigation away / sign-out) drops every
 * pending entry and retires the current generation so late resolutions are
 * ignored by owners that still hold the previous generation.
 */
type RegistryEntry = { generation: number; promise: Promise<unknown>; controller: AbortController };

const registry = new Map<string, RegistryEntry>();
let registryGeneration = 0;

/** Current registry generation. Capture it to detect superseded reads. */
export function liveRequestGeneration(): number {
  return registryGeneration;
}

/** Drop all pending reads and supersede every in-flight generation. */
export function invalidateLiveRequests(): void {
  registryGeneration += 1;
  registry.forEach(entry => entry.controller.abort());
  registry.clear();
}

/**
 * Run `fetcher` for `subject` + `key`, sharing one in-flight promise across
 * concurrent callers. The entry is removed once the request settles, so a
 * later read issues a fresh request. Rejections are shared too and are
 * never cached.
 */
export function dedupedRead<T>(subject: string, key: string, fetcher: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const composite = `${subject}:${key}`;
  const existing = registry.get(composite);
  if (existing && existing.generation === registryGeneration) return existing.promise as Promise<T>;
  const controller = new AbortController();
  const tracked = fetcher(controller.signal).finally(() => {
    if (registry.get(composite)?.promise === tracked) registry.delete(composite);
  });
  registry.set(composite, { generation: registryGeneration, promise: tracked, controller });
  return tracked;
}

export function formatMoney(value: string | null | undefined): string {
  if (value == null || !/^-?\d+$/.test(value)) return '—';
  const amount = BigInt(value);
  const abs = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}₹${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
export function shortTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
