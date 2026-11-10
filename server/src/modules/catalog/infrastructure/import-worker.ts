import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { StoragePort } from '../../media/contracts/storage.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { ImportRow } from '../domain/import.js';
import { applyImportRow } from './import-apply-row.js';
import { parseImport } from './import-parse.js';
import type { ImportService } from './import-service.js';
import { ImportReports } from './import-reports.js';
interface Job {
  id: string;
  owner_id: string;
  media_id: string;
  fingerprint: string;
  dry_run: boolean;
  options: { storeId: string };
  status: string;
  checkpoint: number;
  lease_token: string;
}
export class CatalogImportWorker {
  private readonly reports: ImportReports;
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly storage: StoragePort,
    private readonly config: AppConfig,
    private readonly imports: ImportService,
  ) {
    this.reports = new ImportReports(db, storage);
  }
  async recoverReport(jobId?: string): Promise<boolean> {
    return this.reports.recoverOne(jobId);
  }
  async runOne(jobId?: string): Promise<boolean> {
    await sql`UPDATE catalog_import_jobs j SET approval_id=NULL,updated_at=clock_timestamp() FROM maker_checker_requests a WHERE j.status='AWAITING_APPROVAL' AND j.approval_id=a.id AND (a.status IN ('REJECTED','EXPIRED') OR (a.status='PENDING' AND a.expires_at<=clock_timestamp())) AND (j.lease_until IS NULL OR j.lease_until<clock_timestamp())`.execute(
      this.db,
    );
    const token = uuidV7();
    const result =
      await sql<Job>`UPDATE catalog_import_jobs j SET lease_token=${token}::uuid,lease_until=clock_timestamp()+interval '5 minutes',status=CASE WHEN status='QUEUED' THEN 'VALIDATING' ELSE status END,updated_at=clock_timestamp()
      WHERE id=(SELECT id FROM catalog_import_jobs WHERE (${jobId ?? null}::uuid IS NULL OR id=${jobId ?? null}::uuid) AND (status IN ('QUEUED','VALIDATING','APPLYING') OR (status='AWAITING_APPROVAL' AND approval_id IS NULL)) AND (lease_until IS NULL OR lease_until<clock_timestamp()) AND next_attempt_at<=clock_timestamp() ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`.execute(
        this.db,
      );
    const job = result.rows[0];
    if (!job) return false;
    try {
      if (job.status === 'VALIDATING') await this.validate(job, token);
      else if (job.status === 'AWAITING_APPROVAL') await this.requestApproval(job, token);
      else await this.apply(job, token);
    } catch (error) {
      const pgCode =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      const code = ['23503', '23505', '23514', '23P01', '22P02'].includes(pgCode)
        ? 'IMPORT_CONFLICT'
        : error instanceof Error
          ? error.message
          : 'IMPORT_FAILED';
      if (code === 'APPROVAL_REQUIRED') {
        await sql`UPDATE catalog_import_jobs SET status='AWAITING_APPROVAL',approval_id=NULL,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=${job.id}::uuid AND lease_token=${token}::uuid AND lease_until>clock_timestamp()`.execute(
          this.db,
        );
      } else if (
        [
          'INVALID_CSV',
          'IMPORT_TOO_LARGE',
          'IMPORT_TOO_MANY_ROWS',
          'FORBIDDEN',
          'RESOURCE_NOT_FOUND',
          'INVALID_GST',
          'IMPORT_CONFLICT',
          'PRODUCT_NOT_PUBLISHABLE',
        ].includes(code)
      ) {
        await sql`UPDATE catalog_import_jobs SET status='FAILED',errors=${JSON.stringify([{ row: 0, code }])}::jsonb,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=${job.id}::uuid AND lease_token=${token}::uuid AND lease_until>clock_timestamp()`.execute(
          this.db,
        );
      } else
        await sql`UPDATE catalog_import_jobs SET attempts=attempts+1,status=CASE WHEN attempts+1>=5 THEN 'FAILED' ELSE status END,errors=CASE WHEN attempts+1>=5 THEN '[{"row":0,"code":"IMPORT_RETRY_EXHAUSTED"}]'::jsonb ELSE errors END,next_attempt_at=clock_timestamp()+least(300,power(2,attempts+1)) * interval '1 second',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=${job.id}::uuid AND lease_token=${token}::uuid AND lease_until>clock_timestamp()`.execute(
          this.db,
        );
    }
    await this.reports.recoverOne(job.id).catch(() => undefined);
    return true;
  }
  private async validate(job: Job, token: string) {
    if (!(await this.identity.hasRole(job.owner_id, ['ADMIN', 'SUPER_ADMIN'])))
      throw new Error('FORBIDDEN');
    const media = await sql<{
      object_key: string;
    }>`SELECT object_key FROM catalog_media WHERE id=${job.media_id}::uuid AND owner_id=${job.owner_id}::uuid AND purpose='CATALOG_IMPORT' AND state='REGISTERED'`.execute(
      this.db,
    );
    if (!media.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    const store = await sql`SELECT id FROM stores WHERE id=${job.options.storeId}::uuid`.execute(
      this.db,
    );
    if (!store.rows.length) throw new Error('RESOURCE_NOT_FOUND');
    const parsed = await parseImport(
      await this.storage.open(media.rows[0].object_key),
      await this.config.get('catalogImportMaxBytes'),
      await this.config.get('catalogImportMaxRows'),
      await this.config.get('catalogAllowedGstBps'),
    );
    const categories = [...new Set(parsed.rows.map((row) => row.categoryId))];
    const valid = await sql<{
        id: string;
      }>`SELECT id FROM catalog_categories WHERE id=ANY(${categories}::uuid[]) AND deleted_at IS NULL`.execute(
        this.db,
      ),
      categorySet = new Set(valid.rows.map((r) => r.id));
    for (const [index, row] of parsed.rows.entries())
      if (!categorySet.has(row.categoryId))
        parsed.errors.push({ row: parsed.rowNumbers[index]!, code: 'INVALID_CATEGORY' });
    const sku = parsed.rows.map((r) => r.sku),
      barcode = parsed.rows.flatMap((r) => (r.barcode ? [r.barcode] : []));
    const existing = await sql<{
      sku: string;
      barcode: string | null;
      deleted_at: Date | null;
      product_deleted_at: Date | null;
      published: boolean;
    }>`SELECT v.sku,v.barcode,v.deleted_at,p.deleted_at AS product_deleted_at,p.published FROM catalog_variants v JOIN catalog_products p ON p.id=v.product_id WHERE v.sku=ANY(${sku}::text[]) OR v.barcode=ANY(${barcode}::text[])`.execute(
      this.db,
    );
    for (const [index, row] of parsed.rows.entries()) {
      const conflict = existing.rows.find(
        (v) =>
          (v.barcode === row.barcode && row.barcode !== null && v.sku !== row.sku) ||
          (v.sku === row.sku && (v.deleted_at !== null || v.product_deleted_at !== null)),
      );
      if (conflict)
        parsed.errors.push({ row: parsed.rowNumbers[index]!, code: 'SKU_OR_BARCODE_CONFLICT' });
    }
    let status = job.dry_run || parsed.errors.length ? 'COMPLETED' : 'APPLYING';
    if (
      status === 'APPLYING' &&
      parsed.rows.length > (await this.config.get('catalogPriceApprovalCount'))
    )
      status = 'AWAITING_APPROVAL';
    if (status === 'APPLYING') {
      const prices = await sql<{
        sku: string;
        selling_paise: string;
      }>`SELECT v.sku,p.selling_paise::text FROM catalog_variants v JOIN catalog_prices p ON p.variant_id=v.id WHERE v.sku=ANY(${sku}::text[]) AND p.store_id=${job.options.storeId}::uuid AND p.valid_from<=clock_timestamp() AND (p.valid_to IS NULL OR p.valid_to>clock_timestamp())`.execute(
        this.db,
      );
      const threshold = await this.config.get('catalogPriceApprovalPercent');
      if (
        parsed.rows.some((row) => {
          const old = prices.rows.find((p) => p.sku === row.sku)?.selling_paise;
          if (!old) return false;
          const before = BigInt(old),
            after = BigInt(row.sellingPaise);
          return before === 0n
            ? after > 0n
            : (after > before ? after - before : before - after) * 100n >
                before * BigInt(threshold);
        })
      )
        status = 'AWAITING_APPROVAL';
    }
    await this.db.transaction().execute(async (tx) => {
      const locked =
        await sql`SELECT id FROM catalog_import_jobs WHERE id=${job.id}::uuid AND lease_token=${token}::uuid AND lease_until>clock_timestamp() FOR UPDATE`.execute(
          tx,
        );
      if (!locked.rows.length) throw new Error('IMPORT_LEASE_LOST');
      await sql`DELETE FROM catalog_import_rows WHERE job_id=${job.id}::uuid`.execute(tx);
      if (!parsed.errors.length && !job.dry_run)
        for (const [i, row] of parsed.rows.entries())
          await sql`INSERT INTO catalog_import_rows(job_id,row_number,data) VALUES(${job.id}::uuid,${i + 1},${JSON.stringify(row)}::jsonb)`.execute(
            tx,
          );
      const saved =
        await sql`UPDATE catalog_import_jobs SET status=${status},rows_total=${parsed.total},errors=${JSON.stringify(parsed.errors)}::jsonb,lease_token=NULL,lease_until=NULL,attempts=0,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${job.id}::uuid AND lease_token=${token}::uuid AND lease_until>clock_timestamp() RETURNING id`.execute(
          tx,
        );
      if (!saved.rows.length) throw new Error('IMPORT_LEASE_LOST');
    });
  }
  private async requestApproval(job: Job, token: string) {
    const action = (await this.identity.hasRole(job.owner_id, ['ADMIN']))
      ? 'CATALOG_IMPORT'
      : 'CATALOG_IMPORT_SUPER';
    const id = await this.imports.approvals.request(job.owner_id, action, {
      jobId: job.id,
      fingerprint: job.fingerprint,
    });
    await sql`UPDATE catalog_import_jobs SET approval_id=${id}::uuid,lease_token=NULL,lease_until=NULL WHERE id=${job.id}::uuid AND status='AWAITING_APPROVAL' AND approval_id IS NULL AND lease_token=${token}::uuid AND lease_until>clock_timestamp()`.execute(
      this.db,
    );
  }
  private async apply(job: Job, token: string) {
    const size = await this.config.get('catalogImportBatchSize');
    await this.db.transaction().execute(async (tx) => {
      const locked = await sql<{
        checkpoint: number;
        approval_id: string | null;
        approved: boolean;
      }>`SELECT checkpoint,approval_id,EXISTS (SELECT 1 FROM maker_checker_requests a WHERE a.id=catalog_import_jobs.approval_id AND a.status='EXECUTED' AND a.action IN ('CATALOG_IMPORT','CATALOG_IMPORT_SUPER') AND a.payload->>'jobId'=catalog_import_jobs.id::text AND a.payload->>'fingerprint'=catalog_import_jobs.fingerprint) AS approved FROM catalog_import_jobs WHERE id=${job.id}::uuid AND lease_token=${token}::uuid AND lease_until>clock_timestamp() AND status='APPLYING' FOR UPDATE`.execute(
        tx,
      );
      if (!locked.rows[0]) throw new Error('IMPORT_LEASE_LOST');
      if (!(await this.identity.hasRole(job.owner_id, ['ADMIN', 'SUPER_ADMIN'], tx)))
        throw new Error('FORBIDDEN');
      const rows = await sql<{
        row_number: number;
        data: ImportRow;
      }>`SELECT row_number,data FROM catalog_import_rows WHERE job_id=${job.id}::uuid AND row_number>${locked.rows[0].checkpoint} ORDER BY row_number LIMIT ${size}`.execute(
        tx,
      );
      for (const row of rows.rows)
        await applyImportRow(tx, job, row.data, locked.rows[0].approved, this.config);
      const checkpoint = rows.rows.at(-1)?.row_number ?? locked.rows[0].checkpoint;
      const saved =
        await sql`UPDATE catalog_import_jobs SET checkpoint=${checkpoint},status=${rows.rows.length < size ? 'COMPLETED' : 'APPLYING'},lease_token=NULL,lease_until=NULL,attempts=0,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${job.id}::uuid AND lease_token=${token}::uuid AND lease_until>clock_timestamp() RETURNING id`.execute(
          tx,
        );
      if (!saved.rows.length) throw new Error('IMPORT_LEASE_LOST');
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()}::uuid,${job.owner_id}::uuid,'CATALOG_IMPORT_BATCH','catalog_import',${job.id},${JSON.stringify({ checkpoint })}::jsonb)`.execute(
        tx,
      );
    });
  }
}
