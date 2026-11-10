import { sql } from 'kysely';
import { createHash } from 'node:crypto';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { StoragePort } from '../../media/contracts/storage.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { ReportData, ReportKind } from '../contracts/report-data.js';
import type { ComplianceExports, ExportAudience, ExportFilters } from '../contracts/exports.js';
const kinds = [
  'catalog',
  'stock',
  'financial',
  'picking',
  'rider',
  'subscription',
  'support',
] as const;
export function validateReportKind(kind: string): asserts kind is ReportKind {
  if (!(kinds as readonly string[]).includes(kind)) throw new Error('INVALID_REPORT_KIND');
}
export class ExportService implements ComplianceExports {
  constructor(
    private readonly db: Database,
    private readonly storage: StoragePort,
    private readonly config: AppConfig,
    private readonly reports: ReportData,
  ) {}
  async create(
    owner: string,
    audience: ExportAudience,
    kind: string,
    filters: ExportFilters,
    key: string,
  ): Promise<string> {
    if (audience === 'ADMIN') validateReportKind(kind);
    else if (kind !== 'personal') throw new Error('INVALID_REPORT_KIND');
    if (!/^[A-Za-z0-9._:-]{1,150}$/.test(key)) throw new Error('INVALID_IDEMPOTENCY_KEY');
    const canonical = JSON.stringify({
      kind,
      filters: {
        ...(filters.storeId ? { storeId: filters.storeId } : {}),
        ...(filters.from ? { from: filters.from } : {}),
        ...(filters.to ? { to: filters.to } : {}),
      },
    });
    const hash = createHash('sha256').update(canonical).digest('hex');
    return this.db.transaction().execute(async (tx) => {
      const account =
        await sql`SELECT id FROM users WHERE id=${owner}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
          tx,
        );
      if (!account.rows.length) throw new Error('ACCOUNT_DISABLED');
      if (audience === 'ADMIN') await this.reports.page(kind as ReportKind, null, 1, tx, filters);
      const id = uuidV7();
      const inserted = await sql<{
        id: string;
      }>`INSERT INTO compliance_export_jobs(id,owner_id,audience,kind,filters,request_key,request_hash,status)
        VALUES (${id}::uuid,${owner}::uuid,${audience},${kind},${canonical}::jsonb->'filters',${key},${hash},'QUEUED') ON CONFLICT(owner_id,audience,request_key) DO NOTHING RETURNING id`.execute(
        tx,
      );
      if (inserted.rows[0]) return inserted.rows[0].id;
      const old = await sql<{
        id: string;
        request_hash: string;
      }>`SELECT id,request_hash FROM compliance_export_jobs WHERE owner_id=${owner}::uuid AND audience=${audience} AND request_key=${key}`.execute(
        tx,
      );
      if (old.rows[0]?.request_hash !== hash) throw new Error('IDEMPOTENCY_KEY_REUSED');
      return old.rows[0].id;
    });
  }
  async list(owner: string, audience: ExportAudience, cursor: string | undefined, limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
    const result = await sql<{
      id: string;
    }>`SELECT id,kind,status,row_count,created_at,updated_at,expires_at FROM compliance_export_jobs WHERE owner_id=${owner}::uuid AND audience=${audience} AND (${cursor ?? null}::uuid IS NULL OR id<${cursor ?? null}::uuid) ORDER BY id DESC LIMIT ${limit + 1}`.execute(
      this.db,
    );
    const items = result.rows.slice(0, limit);
    return { items, nextCursor: result.rows.length > limit ? (items.at(-1)?.id ?? null) : null };
  }
  async detail(owner: string, audience: ExportAudience, id: string) {
    const row = (
      await sql`SELECT id,kind,status,row_count,created_at,updated_at,expires_at FROM compliance_export_jobs WHERE id=${id}::uuid AND owner_id=${owner}::uuid AND audience=${audience}`.execute(
        this.db,
      )
    ).rows[0];
    if (!row) throw new Error('RESOURCE_NOT_FOUND');
    return row;
  }
  async download(owner: string, audience: ExportAudience, id: string): Promise<{ url: string }> {
    const result = await sql<{
      object_key: string | null;
      status: string;
      live: boolean;
    }>`SELECT j.object_key,j.status,j.expires_at>clock_timestamp() AS live FROM compliance_export_jobs j JOIN users u ON u.id=j.owner_id WHERE j.id=${id}::uuid AND j.owner_id=${owner}::uuid AND j.audience=${audience} AND u.status='ACTIVE'`.execute(
      this.db,
    );
    const row = result.rows[0];
    if (!row) throw new Error('RESOURCE_NOT_FOUND');
    if (row.status !== 'COMPLETE' || !row.object_key || !row.live)
      throw new Error('REPORT_NOT_READY');
    return {
      url: await this.storage.signedRead(
        row.object_key,
        await this.config.get('reportDownloadTtlSeconds'),
      ),
    };
  }
  async preview(kind: string, cursor: string | undefined, limit: number, filters: ExportFilters) {
    validateReportKind(kind);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
    return this.db.transaction().execute(async (tx) => {
      await sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`.execute(tx);
      return this.reports.page(kind, cursor ?? null, limit, tx, filters);
    });
  }
}
