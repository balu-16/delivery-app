import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import {
  REPORT_KINDS,
  type ReportData,
  type ReportFilters,
  type ReportKind,
} from '../contracts/report-data.js';
import { REPORT_SOURCES } from './report-sources.js';

function normalized(filters: ReportFilters): ReportFilters {
  if (Object.keys(filters).some((key) => !['storeId', 'from', 'to'].includes(key)))
    throw new Error('INVALID_REPORT_FILTER');
  if (
    filters.storeId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filters.storeId)
  )
    throw new Error('INVALID_REPORT_FILTER');
  const date = (value?: string) => {
    if (value === undefined) return undefined;
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
      !Number.isFinite(Date.parse(value))
    )
      throw new Error('INVALID_REPORT_FILTER');
    return new Date(value).toISOString();
  };
  const result = {
    storeId: filters.storeId?.toLowerCase(),
    from: date(filters.from),
    to: date(filters.to),
  };
  if (result.from && result.to && result.from >= result.to)
    throw new Error('INVALID_REPORT_FILTER');
  return result;
}
export class PostgresReportData implements ReportData {
  async page(
    kind: ReportKind,
    cursor: string | null,
    limit: number,
    tx: TransactionContext,
    input: ReportFilters = {},
  ) {
    if (!REPORT_KINDS.includes(kind) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('INVALID_REPORT_REQUEST');
    const filters = normalized(input);
    if (['catalog', 'stock'].includes(kind) && (filters.from || filters.to))
      throw new Error('INVALID_REPORT_FILTER');
    const scope = createHash('sha256').update(JSON.stringify({ kind, filters })).digest('hex');
    let after = '';
    if (cursor) {
      try {
        if (cursor.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString()) as {
          version?: unknown;
          scope?: unknown;
          key?: unknown;
        };
        if (
          parsed.version !== 1 ||
          parsed.scope !== scope ||
          typeof parsed.key !== 'string' ||
          parsed.key.length > 200
        )
          throw new Error();
        after = parsed.key;
      } catch {
        throw new Error('INVALID_CURSOR');
      }
    }
    const result = await sql<
      Record<string, unknown>
    >`SELECT * FROM (${sql.raw(REPORT_SOURCES[kind])}) r WHERE r.row_key>${after}
      AND (${filters.storeId ?? null}::uuid IS NULL OR r.store_id=${filters.storeId ?? null}::uuid)
      AND (${filters.from ?? null}::timestamptz IS NULL OR r.event_at>=${filters.from ?? null}::timestamptz)
      AND (${filters.to ?? null}::timestamptz IS NULL OR r.event_at<${filters.to ?? null}::timestamptz)
      ORDER BY r.row_key LIMIT ${limit + 1}`.execute(tx);
    const more = result.rows.length > limit;
    const rows = result.rows
      .slice(0, limit)
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value instanceof Date ? value.toISOString() : value,
          ]),
        ),
      );
    const last = rows.at(-1);
    return {
      rows,
      nextCursor:
        more && last
          ? Buffer.from(JSON.stringify({ version: 1, scope, key: last['row_key'] })).toString(
              'base64url',
            )
          : null,
    };
  }
}
