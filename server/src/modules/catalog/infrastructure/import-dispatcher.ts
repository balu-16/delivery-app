import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json } from '../../../platform/database/database.js';
import type { ConcernQueues } from '../../../platform/queue/concern-queues.js';
import type { CatalogImportWorker } from './import-worker.js';
/** BullMQ carries hints only; periodic DB scans recreate hints after transport loss. */
export class CatalogImportDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private closing = false;
  private recovery: Promise<void> | undefined;
  private readonly active = new Set<Promise<void>>();
  constructor(
    private readonly db: Database,
    private readonly queue: Pick<ConcernQueues, 'register' | 'enqueue'>,
    private readonly worker: CatalogImportWorker,
  ) {}
  start(): void {
    this.queue.register('imports', 'catalog-import', async (data: Json) => {
      if (
        this.closing ||
        !data ||
        typeof data !== 'object' ||
        Array.isArray(data) ||
        typeof data.jobId !== 'string' ||
        !/^[0-9a-f-]{36}$/i.test(data.jobId)
      )
        return;
      const id = data.jobId;
      const task = (async () => {
        for (let n = 0; n < 100 && !this.closing; n++) if (!(await this.worker.runOne(id))) break;
      })();
      this.active.add(task);
      try {
        await task;
      } finally {
        this.active.delete(task);
      }
    });
    this.timer = setInterval(() => void this.tick(), 5000);
    this.timer.unref();
    void this.tick();
  }
  async tick(): Promise<void> {
    if (this.closing || this.recovery) return;
    this.recovery = this.recover().catch(() => undefined);
    try {
      await this.recovery;
    } finally {
      this.recovery = undefined;
    }
  }
  async recover(): Promise<void> {
    await sql`UPDATE catalog_import_jobs j SET approval_id=NULL,updated_at=clock_timestamp() FROM maker_checker_requests a WHERE j.status='AWAITING_APPROVAL' AND j.approval_id=a.id AND (a.status IN ('REJECTED','EXPIRED') OR (a.status='PENDING' AND a.expires_at<=clock_timestamp())) AND (j.lease_until IS NULL OR j.lease_until<clock_timestamp())`.execute(
      this.db,
    );
    for (let n = 0; n < 20 && !this.closing; n++) {
      try {
        if (!(await this.worker.recoverReport())) break;
      } catch {
        break;
      }
    }
    const due = await sql<{
      id: string;
    }>`SELECT id FROM catalog_import_jobs WHERE (status IN ('QUEUED','VALIDATING','APPLYING') OR (status='AWAITING_APPROVAL' AND approval_id IS NULL)) AND (lease_until IS NULL OR lease_until<clock_timestamp()) AND next_attempt_at<=clock_timestamp() ORDER BY created_at,id LIMIT 50`.execute(
      this.db,
    );
    for (const job of due.rows) {
      if (this.closing) break;
      await this.queue.enqueue(
        'imports',
        'catalog-import',
        { jobId: job.id },
        `${job.id}-${uuidV7()}`,
      );
    }
  }
  async stop(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.recovery;
    await Promise.allSettled([...this.active]);
  }
}
