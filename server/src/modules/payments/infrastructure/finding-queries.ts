import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { PaymentFindings } from '../contracts/payments.js';
export class FindingQueries implements PaymentFindings {
  constructor(private readonly db: Database) {}
  async list(limit: number, cursor?: string) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (cursor && !/^[0-9a-f-]{36}$/i.test(cursor))
    )
      throw new Error('INVALID_PAGE');
    const rows = await sql<{
      id: string;
      kind: string;
      severity: string;
      status: string;
      created_at: Date;
      details: Record<string, unknown>;
    }>`SELECT id,kind,severity,status,aggregate_type,aggregate_id,reference,details,created_at
   FROM reconciliation_findings WHERE ${cursor ? sql`id<${cursor}::uuid` : sql`true`} ORDER BY id DESC LIMIT ${limit + 1}`.execute(
      this.db,
    );
    const items = rows.rows.slice(0, limit);
    return {
      items: items.map((row) => ({ ...row, created_at: row.created_at.toISOString() })),
      nextCursor: rows.rows.length > limit ? items.at(-1)!.id : null,
    };
  }
}
