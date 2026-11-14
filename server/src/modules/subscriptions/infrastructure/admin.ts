import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import { decodePage, pageResult } from '../domain/page.js';
import { addDays } from '../domain/schedule.js';
import type { SubscriptionAdmin } from '../contracts/subscriptions.js';
export class PostgresSubscriptionAdmin implements SubscriptionAdmin {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly identity: IdentityAccess,
  ) {}
  private run<T>(
    outer: TransactionContext | undefined,
    fn: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    return outer ? fn(outer) : transactionWithRetry(this.db, fn);
  }
  async plans(limit?: number, cursor?: string) {
    const page = decodePage(cursor, 'plans', limit);
    if (page.after && !/^[0-9a-f-]{36}$/i.test(page.after)) throw new Error('INVALID_PAGE');
    const rows = await sql<{
      id: string;
    }>`SELECT p.*,v.name FROM subscription_plans p JOIN catalog_variants v ON v.id=p.variant_id WHERE (${page.after}::uuid IS NULL OR p.id>${page.after}::uuid) ORDER BY p.id LIMIT ${page.limit + 1}`.execute(
      this.db,
    );
    return pageResult(rows.rows, page.limit, 'plans', (r) => r.id);
  }
  private async audit(tx: TransactionContext, actor: string, action: string, id: string) {
    await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES(${uuidV7()}::uuid,${actor}::uuid,${action},'subscription',${id})`.execute(
      tx,
    );
  }
  async savePlan(actor: string, variantId: string, active: boolean, outer?: TransactionContext) {
    return this.run(outer, async (tx) => {
      if (!(await this.identity.hasRole(actor, ['SUPER_ADMIN'], tx))) throw new Error('FORBIDDEN');
      const result = await sql<{
        id: string;
      }>`INSERT INTO subscription_plans(id,variant_id,active) VALUES(${uuidV7()}::uuid,${variantId}::uuid,${active}) ON CONFLICT(variant_id) DO UPDATE SET active=EXCLUDED.active RETURNING id::text`.execute(
        tx,
      );
      const id = result.rows[0]!.id;
      await this.audit(tx, actor, 'SUBSCRIPTION_PLAN_UPDATED', id);
      return { id };
    });
  }
  async slots(storeId: string, limit?: number, cursor?: string) {
    const scope = `slots:${storeId}`,
      page = decodePage(cursor, scope, limit);
    if (page.after && !/^[0-9a-f-]{36}$/i.test(page.after)) throw new Error('INVALID_PAGE');
    const rows = await sql<{
      id: string;
    }>`SELECT * FROM subscription_slots WHERE store_id=${storeId}::uuid AND (${page.after}::uuid IS NULL OR id>${page.after}::uuid) ORDER BY id LIMIT ${page.limit + 1}`.execute(
      this.db,
    );
    return pageResult(rows.rows, page.limit, scope, (r) => r.id);
  }
  async saveSlot(
    actor: string,
    input: {
      id?: string;
      storeId: string;
      name: string;
      startTime: string;
      endTime: string;
      active: boolean;
    },
    outer?: TransactionContext,
  ) {
    if (
      !input.name.trim() ||
      input.name.length > 100 ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.startTime) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.endTime) ||
      input.startTime >= input.endTime
    )
      throw new Error('INVALID_SLOT');
    return this.run(outer, async (tx) => {
      // Shared with ConfigService: serialize slot constraints before actor/config locks.
      await sql`SELECT pg_advisory_xact_lock(701001)`.execute(tx);
      if (!(await this.identity.hasRole(actor, ['SUPER_ADMIN'], tx))) throw new Error('FORBIDDEN');
      const deadline = await this.config.get('subscriptionGraceDeadlineTime', tx),
        lead = await this.config.get('subscriptionDispatchLeadMinutes', tx);
      const mins = (s: string) => {
        const [h, m] = s.split(':').map(Number);
        return h! * 60 + m!;
      };
      if (mins(input.startTime) - lead <= mins(deadline)) throw new Error('INVALID_SLOT_TIMING');
      const id = input.id ?? uuidV7();
      const row =
        await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time,active) VALUES(${id}::uuid,${input.storeId}::uuid,${input.name.trim()},${input.startTime}::time,${input.endTime}::time,${input.active}) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,start_time=EXCLUDED.start_time,end_time=EXCLUDED.end_time,active=EXCLUDED.active WHERE subscription_slots.store_id=EXCLUDED.store_id RETURNING id`.execute(
          tx,
        );
      if (!row.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      await this.audit(tx, actor, 'SUBSCRIPTION_SLOT_UPDATED', id);
      return { id };
    });
  }
  async holidays(storeId: string, limit?: number, cursor?: string) {
    const scope = `holidays:${storeId}`,
      page = decodePage(cursor, scope, limit);
    if (page.after && !/^\d{4}-\d{2}-\d{2}$/.test(page.after)) throw new Error('INVALID_PAGE');
    const rows = await sql<{
      holiday_date: string;
    }>`SELECT store_id::text,holiday_date::text,reason FROM subscription_holidays WHERE store_id=${storeId}::uuid AND (${page.after}::date IS NULL OR holiday_date>${page.after}::date) ORDER BY holiday_date LIMIT ${page.limit + 1}`.execute(
      this.db,
    );
    return pageResult(rows.rows, page.limit, scope, (r) => r.holiday_date);
  }
  async saveHoliday(
    actor: string,
    storeId: string,
    date: string,
    reason: string | null,
    remove: boolean,
    outer?: TransactionContext,
  ) {
    addDays(date, 0);
    if (reason && reason.length > 200) throw new Error('INVALID_INPUT');
    return this.run(outer, async (tx) => {
      if (!(await this.identity.hasRole(actor, ['SUPER_ADMIN'], tx))) throw new Error('FORBIDDEN');
      if (remove)
        await sql`DELETE FROM subscription_holidays WHERE store_id=${storeId}::uuid AND holiday_date=${date}::date`.execute(
          tx,
        );
      else
        await sql`INSERT INTO subscription_holidays(store_id,holiday_date,reason) VALUES(${storeId}::uuid,${date}::date,${reason}) ON CONFLICT(store_id,holiday_date) DO UPDATE SET reason=EXCLUDED.reason`.execute(
          tx,
        );
      await this.audit(tx, actor, 'SUBSCRIPTION_HOLIDAY_UPDATED', storeId);
      return { storeId, date };
    });
  }
  async runs(storeId?: string, limit?: number, cursor?: string) {
    const scope = `runs:${storeId ?? ''}`,
      page = decodePage(cursor, scope, limit);
    if (page.after && !/^[0-9a-f-]{36}$/i.test(page.after)) throw new Error('INVALID_PAGE');
    const rows = await sql<{
      id: string;
    }>`SELECT * FROM subscription_generation_runs WHERE (${storeId ?? null}::uuid IS NULL OR store_id=${storeId ?? null}::uuid) AND (${page.after}::uuid IS NULL OR id>${page.after}::uuid) ORDER BY id LIMIT ${page.limit + 1}`.execute(
      this.db,
    );
    return pageResult(rows.rows, page.limit, scope, (r) => r.id);
  }
  async retryRun(actor: string, id: string, outer?: TransactionContext) {
    return this.run(outer, async (tx) => {
      if (!(await this.identity.hasRole(actor, ['SUPER_ADMIN'], tx))) throw new Error('FORBIDDEN');
      const run =
        await sql`UPDATE subscription_generation_runs SET status='PENDING',updated_at=clock_timestamp() WHERE id=${id}::uuid AND status<>'COMPLETE' RETURNING id`.execute(
          tx,
        );
      if (!run.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      await sql`UPDATE subscription_occurrences SET retry_at=clock_timestamp() WHERE run_id=${id}::uuid AND state='RETRYABLE' AND retry_deadline>clock_timestamp()`.execute(
        tx,
      );
      await this.audit(tx, actor, 'SUBSCRIPTION_RUN_RETRY', id);
      return { id };
    });
  }
}
