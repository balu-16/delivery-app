/**
 * Inbox keyset cursor: base64url(created_at_iso|id). The id tiebreaker makes
 * the order total and stable at millisecond-equal timestamps.
 */
export function encodeCursor(createdAt: Date | string, id: string): string {
  const value = typeof createdAt === 'string' ? createdAt : createdAt.toISOString();
  if (Number.isNaN(new Date(value).getTime()) || !id) throw new Error('INVALID_CURSOR');
  return Buffer.from(`${value}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const { timestamp, id } = decodeCursorExact(cursor);
  return { createdAt: new Date(timestamp), id };
}

/** Preserve PostgreSQL microseconds when resuming a keyset page. */
export function decodeCursorExact(cursor: string): { timestamp: string; id: string } {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new Error('INVALID_CURSOR');
  }
  const separator = decoded.lastIndexOf('|');
  if (separator <= 0 || separator === decoded.length - 1) throw new Error('INVALID_CURSOR');
  const timestamp = decoded.slice(0, separator);
  const createdAt = new Date(timestamp);
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id))
    throw new Error('INVALID_CURSOR');
  return { timestamp, id };
}

/** Bounded fan-out batches (source limit: multicast ≤ 500). */
export function chunkBounded<T>(items: readonly T[], size = 500): T[][] {
  if (!Number.isSafeInteger(size) || size < 1 || size > 500) throw new Error('INVALID_BATCH_SIZE');
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    batches.push(items.slice(index, index + size));
  return batches;
}
