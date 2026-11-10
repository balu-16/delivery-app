import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { KpiSummary, SlaTask, SlaTaskPage } from '../contracts/tasks.js';

/** Manager board metrics computed from picking-owned data only. */
export class PostgresPickViews {
  constructor(private readonly db: Database) {}
  async kpis(storeId: string): Promise<KpiSummary> {
    if (!storeId) throw new Error('INVALID_INPUT');
    const tasks = await sql<{
      open_tasks: string;
      completed_today: string;
      avg_seconds: string | null;
    }>`SELECT count(*) FILTER (WHERE status IN ('PENDING','ASSIGNED','IN_PROGRESS'))::text AS open_tasks,count(*) FILTER (WHERE status='COMPLETED' AND (completed_at AT TIME ZONE 'Asia/Kolkata')::date=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date)::text AS completed_today,avg(extract(epoch from (completed_at-started_at))) FILTER (WHERE status='COMPLETED' AND started_at IS NOT NULL AND (completed_at AT TIME ZONE 'Asia/Kolkata')::date=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date)::text AS avg_seconds FROM pick_tasks WHERE store_id=${storeId}::uuid`.execute(
      this.db,
    );
    const breaches = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM picking_sla_breaches WHERE store_id=${storeId}::uuid AND (breached_at AT TIME ZONE 'Asia/Kolkata')::date=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date`.execute(
      this.db,
    );
    const shorts = await sql<{
      short_bps: string;
    }>`SELECT COALESCE(round(10000.0 * count(*) FILTER (WHERE i.status IN ('SHORT','SUBSTITUTED')) / GREATEST(count(*),1)),0)::text AS short_bps FROM pick_items i JOIN pick_tasks t ON t.id=i.task_id WHERE t.store_id=${storeId}::uuid AND (t.completed_at AT TIME ZONE 'Asia/Kolkata')::date=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date`.execute(
      this.db,
    );
    const row = tasks.rows[0]!;
    return {
      openTasks: Number(row.open_tasks),
      completedToday: Number(row.completed_today),
      slaBreachesToday: Number(breaches.rows[0]!.count),
      avgPickSeconds: row.avg_seconds ? String(Math.round(Number(row.avg_seconds))) : '0',
      shortRateBps: shorts.rows[0]!.short_bps,
      backlog: Number(row.open_tasks),
    };
  }

  async slaBoard(storeId: string, cursor?: string, limit = 50): Promise<SlaTaskPage> {
    if (!storeId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('INVALID_INPUT');
    let after: { sla: string; id: string } | null = null;
    if (cursor) {
      try {
        const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (
          Array.isArray(parsed) &&
          parsed.length === 2 &&
          typeof parsed[0] === 'string' &&
          typeof parsed[1] === 'string'
        )
          after = { sla: parsed[0], id: parsed[1] };
      } catch {
        after = null;
      }
      if (!after) throw new Error('INVALID_CURSOR');
    }
    const rows = await sql<{
      id: string;
      order_id: string;
      status: 'PENDING' | 'ASSIGNED' | 'IN_PROGRESS';
      assigned_to: string | null;
      sla_due_at: Date;
    }>`SELECT id,order_id,status,assigned_to,sla_due_at FROM pick_tasks WHERE store_id=${storeId}::uuid AND status IN ('PENDING','ASSIGNED','IN_PROGRESS') AND (${after ? sql`(sla_due_at,id) > (${after.sla}::timestamptz,${after.id}::uuid)` : sql`true`}) ORDER BY sla_due_at,id LIMIT ${limit + 1}`.execute(
      this.db,
    );
    const page = rows.rows.slice(0, limit);
    const items: SlaTask[] = page.map((row) => ({
      id: row.id,
      orderId: row.order_id,
      status: row.status,
      assignedTo: row.assigned_to,
      slaDueAt: row.sla_due_at.toISOString(),
      breached: row.sla_due_at.getTime() < Date.now(),
    }));
    const last = page.at(-1);
    return {
      items,
      nextCursor:
        rows.rows.length > limit && last
          ? Buffer.from(JSON.stringify([last.sla_due_at.toISOString(), last.id])).toString(
              'base64url',
            )
          : null,
    };
  }
}
