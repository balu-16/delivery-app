/** Cursor is bound to its collection and filter to prevent accidental reuse. */
export function decodePage(
  cursor: string | undefined,
  scope: string,
  limit: number | undefined,
): { after: string | null; limit: number } {
  const size = limit ?? 50;
  if (!Number.isInteger(size) || size < 1 || size > 100) throw new Error('INVALID_PAGE');
  if (!cursor) return { after: null, limit: size };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      scope?: unknown;
      after?: unknown;
    };
    if (parsed.scope !== scope || typeof parsed.after !== 'string' || parsed.after.length > 128)
      throw new Error();
    return { after: parsed.after, limit: size };
  } catch {
    throw new Error('INVALID_PAGE');
  }
}
export function pageResult<T>(rows: T[], limit: number, scope: string, key: (row: T) => string) {
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor:
      rows.length > limit && items.length
        ? Buffer.from(JSON.stringify({ scope, after: key(items[items.length - 1]!) })).toString(
            'base64url',
          )
        : null,
  };
}
