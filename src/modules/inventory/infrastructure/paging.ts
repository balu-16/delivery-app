import { createHash } from 'node:crypto';

const scopeHash = (scope: readonly unknown[]) =>
  createHash('sha256').update(JSON.stringify(scope)).digest('base64url');

export function stockCursor(id: string, scope: readonly unknown[]): string {
  return Buffer.from(JSON.stringify([id, scopeHash(scope)])).toString('base64url');
}

/** A cursor is a bounded sort tuple tied to its store and filters. */
export function stockCursorId(
  cursor: string | undefined,
  scope: readonly unknown[],
): string | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('INVALID_PAGE');
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      typeof value[0] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value[0]) ||
      value[1] !== scopeHash(scope)
    )
      throw new Error('INVALID_PAGE');
    return value[0];
  } catch (error) {
    throw new Error('INVALID_PAGE', { cause: error });
  }
}
