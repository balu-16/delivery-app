import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { parseMoney } from '../../../common/money/money.js';
import {
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type {
  EarningPage,
  EarningTaskInput,
  EarningView,
  RiderEarnings,
} from '../contracts/riders.js';
import { computeEarnings, type EarningsConfig } from '../domain/earnings.js';

interface EarningRow {
  task_id: string;
  order_id: string;
  base_paise: string;
  distance_paise: string;
  detention_paise: string;
  incentive_paise: string;
  tip_paise: string;
  adjustment_paise: string;
  total_paise: string;
  distance_metres: number;
  detention_minutes: number;
  computed_at: Date;
}

function mapEarning(row: EarningRow): EarningView {
  return {
    taskId: row.task_id,
    orderId: row.order_id,
    basePaise: row.base_paise,
    distancePaise: row.distance_paise,
    detentionPaise: row.detention_paise,
    incentivePaise: row.incentive_paise,
    tipPaise: row.tip_paise,
    adjustmentPaise: row.adjustment_paise,
    totalPaise: row.total_paise,
    distanceMetres: row.distance_metres,
    detentionMinutes: row.detention_minutes,
    computedAt: row.computed_at.toISOString(),
  };
}

/** Earnings are written exactly once per task and never mutated afterwards. */
export class PostgresRiderEarnings implements RiderEarnings {
  constructor(
    private readonly db: Database,
    private readonly config: EarningsConfig | (() => Promise<EarningsConfig>),
  ) {}
  private run<T>(fn: (tx: TransactionContext) => Promise<T>, tx?: TransactionContext): Promise<T> {
    return tx ? fn(tx) : transactionWithRetry(this.db, fn);
  }

  async recordForTask(input: EarningTaskInput, outer?: TransactionContext): Promise<EarningView> {
    parseMoney(input.tipPaise);
    return this.run(async (tx) => {
      const existing =
        await sql<EarningRow>`SELECT task_id,order_id,base_paise,distance_paise,detention_paise,incentive_paise,tip_paise,adjustment_paise,total_paise,distance_metres,detention_minutes,computed_at
        FROM rider_earnings WHERE task_id=${input.taskId}::uuid`.execute(tx);
      if (existing.rows[0]) return mapEarning(existing.rows[0]);
      const computed = computeEarnings(
        input,
        typeof this.config === 'function' ? await this.config() : this.config,
      );
      await sql`INSERT INTO rider_earnings(id,task_id,rider_id,order_id,base_paise,distance_paise,detention_paise,incentive_paise,tip_paise,adjustment_paise,total_paise,distance_metres,detention_minutes)
        VALUES(${uuidV7()}::uuid,${input.taskId}::uuid,${input.riderId}::uuid,${input.orderId}::uuid,${computed.basePaise},${computed.distancePaise},${computed.detentionPaise},${computed.incentivePaise},${computed.tipPaise},${computed.adjustmentPaise},${computed.totalPaise},${computed.distanceMetres},${computed.detentionMinutes})
        ON CONFLICT (task_id) DO NOTHING`.execute(tx);
      const rows =
        await sql<EarningRow>`SELECT task_id,order_id,base_paise,distance_paise,detention_paise,incentive_paise,tip_paise,adjustment_paise,total_paise,distance_metres,detention_minutes,computed_at
        FROM rider_earnings WHERE task_id=${input.taskId}::uuid`.execute(tx);
      return mapEarning(rows.rows[0]!);
    }, outer);
  }

  async forRider(riderId: string, cursor?: string, limit?: number): Promise<EarningPage> {
    const pageLimit = Math.min(Math.max(limit ?? 50, 1), 100);
    const before = decodeEarningCursor(cursor);
    const rows = before
      ? await sql<EarningRow>`SELECT task_id,order_id,base_paise,distance_paise,detention_paise,incentive_paise,tip_paise,adjustment_paise,total_paise,distance_metres,detention_minutes,computed_at
          FROM rider_earnings WHERE rider_id=${riderId}::uuid AND (computed_at, task_id) < (${before.computedAt}::timestamptz, ${before.taskId}::uuid)
          ORDER BY computed_at DESC, task_id LIMIT ${pageLimit}`.execute(this.db)
      : await sql<EarningRow>`SELECT task_id,order_id,base_paise,distance_paise,detention_paise,incentive_paise,tip_paise,adjustment_paise,total_paise,distance_metres,detention_minutes,computed_at
          FROM rider_earnings WHERE rider_id=${riderId}::uuid ORDER BY computed_at DESC, task_id LIMIT ${pageLimit}`.execute(
          this.db,
        );
    const items = rows.rows.map(mapEarning);
    const last = rows.rows.at(-1);
    return {
      items,
      nextCursor:
        rows.rows.length === pageLimit && last
          ? encodeEarningCursor(last.computed_at.toISOString(), last.task_id)
          : null,
    };
  }
}

function encodeEarningCursor(computedAt: string, taskId: string): string {
  return Buffer.from(JSON.stringify([computedAt, taskId])).toString('base64url');
}
function decodeEarningCursor(cursor?: string): { computedAt: string; taskId: string } | null {
  if (!cursor) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string'
    )
      return null;
    return { computedAt: parsed[0], taskId: parsed[1] };
  } catch {
    return null;
  }
}
