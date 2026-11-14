import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json, TransactionContext } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { ApprovalFactory, ApprovalExecutor } from '../../compliance/contracts/approval.js';
import type { StoragePort } from '../../media/contracts/storage.js';
import type { ConcernQueues } from '../../../platform/queue/concern-queues.js';
import type { CatalogImports } from '../contracts/imports.js';
export class ImportService implements CatalogImports {
  readonly approvals: ApprovalExecutor;
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
    private readonly storage: StoragePort,
    private readonly config: AppConfig,
    factory: ApprovalFactory,
    private readonly queue?: Pick<ConcernQueues, 'enqueue'>,
  ) {
    const action = (makerRole: 'SUPER_ADMIN') => ({
      version: 1,
      makerRole,
      checkerRole: 'SUPER_ADMIN',
      ttlSeconds: 86400,
      validate: (p: Json) =>
        Boolean(
          p &&
          typeof p === 'object' &&
          !Array.isArray(p) &&
          typeof p.jobId === 'string' &&
          typeof p.fingerprint === 'string',
        ),
      execute: async (tx: TransactionContext, p: Json, executionKey: string) => {
        if (
          !p ||
          typeof p !== 'object' ||
          Array.isArray(p) ||
          typeof p.jobId !== 'string' ||
          typeof p.fingerprint !== 'string'
        )
          throw new Error('INVALID_APPROVAL');
        const result =
          await sql`UPDATE catalog_import_jobs SET status='APPLYING',updated_at=clock_timestamp(),lease_until=NULL,lease_token=NULL WHERE id=${p.jobId}::uuid AND fingerprint=${p.fingerprint} AND status='AWAITING_APPROVAL' AND approval_id=(SELECT id FROM maker_checker_requests WHERE execution_key=${executionKey}::uuid) RETURNING id`.execute(
            tx,
          );
        if (!result.rows.length) throw new Error('APPROVAL_INVALID');
      },
    });
    this.approvals = factory.create({
      CATALOG_IMPORT: action('SUPER_ADMIN'),
      CATALOG_IMPORT_SUPER: action('SUPER_ADMIN'),
    });
  }
  async create(owner: string, mediaId: string, storeId: string, dryRun: boolean) {
    if (!(await this.identity.hasRole(owner, ['SUPER_ADMIN']))) throw new Error('FORBIDDEN');
    const media = await sql<{
      object_key: string;
      size_bytes: string;
    }>`SELECT object_key,size_bytes::text FROM catalog_media WHERE id=${mediaId}::uuid AND owner_id=${owner}::uuid AND purpose='CATALOG_IMPORT' AND state='REGISTERED'`.execute(
      this.db,
    );
    if (!media.rows[0]) throw new Error('MEDIA_NOT_FOUND');
    const max = await this.config.get('catalogImportMaxBytes'),
      hash = createHash('sha256');
    let bytes = 0;
    const input = await this.storage.open(media.rows[0].object_key);
    for await (const chunk of input) {
      const data = Buffer.from(chunk as Uint8Array);
      bytes += data.length;
      if (bytes > max) {
        input.destroy();
        throw new Error('IMPORT_TOO_LARGE');
      }
      hash.update(data);
    }
    if (bytes.toString() !== media.rows[0].size_bytes) throw new Error('INVALID_MEDIA');
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([hash.digest('hex'), storeId, dryRun]))
      .digest('hex');
    const id = uuidV7();
    const job = await this.db.transaction().execute(async (tx) => {
      if (!(await this.identity.hasRole(owner, ['SUPER_ADMIN'], tx))) throw new Error('FORBIDDEN');
      const inserted = await sql<{
        id: string;
      }>`INSERT INTO catalog_import_jobs(id,owner_id,media_id,fingerprint,dry_run,options,status) VALUES(${id}::uuid,${owner}::uuid,${mediaId}::uuid,${fingerprint},${dryRun},${JSON.stringify({ storeId })}::jsonb,'QUEUED') ON CONFLICT(fingerprint) DO UPDATE SET fingerprint=EXCLUDED.fingerprint RETURNING id`.execute(
        tx,
      );
      return { id: inserted.rows[0]!.id };
    });
    await this.hint(job.id);
    return job;
  }
  async get(owner: string, id: string) {
    if (!(await this.identity.hasRole(owner, ['SUPER_ADMIN']))) throw new Error('FORBIDDEN');
    const rows =
      await sql`SELECT id,status,dry_run AS "dryRun",rows_total AS "rowsTotal",checkpoint,errors,approval_id AS "approvalId",created_at AS "createdAt",updated_at AS "updatedAt" FROM catalog_import_jobs WHERE id=${id}::uuid`.execute(
        this.db,
      );
    if (!rows.rows[0]) throw new Error('RESOURCE_NOT_FOUND');
    return rows.rows[0];
  }
  async report(owner: string, id: string) {
    await this.get(owner, id);
    const job = await sql<{
      report_key: string | null;
      current: boolean;
    }>`SELECT report_key,report_errors=errors AS current FROM catalog_import_jobs WHERE id=${id}::uuid`.execute(
      this.db,
    );
    if (!job.rows[0]?.report_key || !job.rows[0].current) throw new Error('REPORT_NOT_READY');
    const stream = await this.storage.open(job.rows[0].report_key),
      chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks).toString('utf8');
  }
  async approve(checker: string, id: string) {
    await this.approvals.approve(checker, id);
    const result = await sql<{
      job_id: string;
    }>`SELECT payload->>'jobId' AS job_id FROM maker_checker_requests WHERE id=${id}::uuid`.execute(
      this.db,
    );
    if (result.rows[0]?.job_id) await this.hint(result.rows[0].job_id);
  }
  private async hint(id: string): Promise<void> {
    await this.queue
      ?.enqueue('imports', 'catalog-import', { jobId: id }, `${id}-${uuidV7()}`)
      .catch(() => undefined);
  }
}
