import {
  APP_CONTENT_LOCALES,
  APP_CONTENT_SLOTS,
  SLOT_DESTINATIONS,
  type AppContentLocale,
  type AppContentSlot,
  type AppContentWrite,
} from '../contracts/app-content.js';

const UUID = /^[0-9a-f-]{36}$/i;

export function assertSlot(slot: string): asserts slot is AppContentSlot {
  if (!APP_CONTENT_SLOTS.includes(slot as AppContentSlot)) throw new Error('INVALID_INPUT');
}

export function assertLocale(locale: string): asserts locale is AppContentLocale {
  if (!APP_CONTENT_LOCALES.includes(locale as AppContentLocale)) throw new Error('INVALID_INPUT');
}

export function safeDestination(
  slot: AppContentSlot,
  destination: string | null | undefined,
): boolean {
  if (!destination) return true;
  if (
    destination.length > 500 ||
    [...destination].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || c === '\\') ||
    destination.startsWith('//')
  )
    return false;
  if (!destination.startsWith('/')) return false;
  const allowed = SLOT_DESTINATIONS[slot];
  return allowed.some(
    (prefix) =>
      destination === prefix ||
      destination.startsWith(`${prefix}/`) ||
      destination.startsWith(`${prefix}?`),
  );
}

/** Pure write validation (customize2 §3E): audience/slot, text limits,
 * destination allowlist, time ordering, version shape. Media-reference and
 * version-vs-row checks happen in the service (they need the DB). */
export function validateWrite(slot: string, locale: string, input: AppContentWrite): void {
  assertSlot(slot);
  assertLocale(locale);
  if (typeof input?.enabled !== 'boolean') throw new Error('INVALID_INPUT');
  const title = input.title ?? null;
  const body = input.body ?? null;
  if (input.enabled) {
    if (!title?.trim() || title.length > 200) throw new Error('INVALID_INPUT');
    if (!body?.trim() || body.length > 2000) throw new Error('INVALID_INPUT');
  } else {
    if (
      (title !== null && (title.length < 1 || title.length > 200)) ||
      (body !== null && (body.length < 1 || body.length > 2000))
    )
      throw new Error('INVALID_INPUT');
  }
  if (!safeDestination(slot as AppContentSlot, input.destination ?? null))
    throw new Error('INVALID_INPUT');
  if (
    input.imageMediaId !== undefined &&
    input.imageMediaId !== null &&
    !UUID.test(input.imageMediaId)
  )
    throw new Error('INVALID_INPUT');
  const start = input.startAt ? Date.parse(input.startAt) : null;
  const end = input.endAt ? Date.parse(input.endAt) : null;
  if (
    (input.startAt && !Number.isFinite(start as number)) ||
    (input.endAt && !Number.isFinite(end as number))
  )
    throw new Error('INVALID_INPUT');
  if (start !== null && end !== null && end <= (start as number)) throw new Error('INVALID_INPUT');
  if (
    input.expectedVersion !== undefined &&
    (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0)
  )
    throw new Error('INVALID_INPUT');
  // No control characters anywhere in free text.
  for (const value of [title, body, input.destination]) {
    if (value && [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
      throw new Error('INVALID_INPUT');
  }
}

/** Effective state from a resolved row (already locale-fallback resolved). */
export function effectiveState(
  row: { enabled: boolean; start_at: string | null; end_at: string | null } | null,
  now: Date,
): 'UNSET' | 'VISIBLE' | 'DISABLED' | 'INACTIVE' {
  if (!row) return 'UNSET';
  if (!row.enabled) return 'DISABLED';
  const start = row.start_at ? Date.parse(row.start_at) : null;
  const end = row.end_at ? Date.parse(row.end_at) : null;
  if (start !== null && now.getTime() < start) return 'INACTIVE';
  if (end !== null && now.getTime() >= end) return 'INACTIVE';
  return 'VISIBLE';
}
