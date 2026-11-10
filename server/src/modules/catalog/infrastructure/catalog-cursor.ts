import { createHash } from 'node:crypto';
export interface CursorRow {
  stock_rank: number;
  match_rank: number;
  similarity_rank: number;
  popularity_rank: number;
  sort_name: string;
  product_id: string;
  variant_id: string;
}
type Tuple = [number, number, number, number, string, string, string];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function cursorScope(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('base64url');
}
export function encodeCursor(scope: string, row: CursorRow): string {
  const tuple: Tuple = [
    row.stock_rank,
    row.match_rank,
    row.similarity_rank,
    row.popularity_rank,
    row.sort_name,
    row.product_id,
    row.variant_id,
  ];
  return Buffer.from(JSON.stringify({ v: 1, scope, tuple })).toString('base64url');
}
export function decodeCursor(cursor: string | undefined, scope: string): Tuple | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('v' in parsed) ||
      parsed.v !== 1 ||
      !('scope' in parsed) ||
      parsed.scope !== scope ||
      !('tuple' in parsed) ||
      !Array.isArray(parsed.tuple) ||
      parsed.tuple.length !== 7
    )
      throw new Error();
    const t = parsed.tuple as unknown[];
    if (
      !t.slice(0, 4).every((n) => typeof n === 'number' && Number.isSafeInteger(n)) ||
      !(t[0] === 0 || t[0] === 1) ||
      typeof t[1] !== 'number' ||
      t[1] < 0 ||
      t[1] > 5 ||
      typeof t[2] !== 'number' ||
      t[2] > 0 ||
      t[2] < -1000000 ||
      typeof t[3] !== 'number' ||
      t[3] > 0 ||
      t[3] < -2147483647 ||
      typeof t[4] !== 'string' ||
      t[4].length > 1000 ||
      typeof t[5] !== 'string' ||
      !uuid.test(t[5]) ||
      typeof t[6] !== 'string' ||
      !uuid.test(t[6])
    )
      throw new Error();
    return t as Tuple;
  } catch {
    throw new Error('INVALID_PAGE');
  }
}
