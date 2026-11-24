import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { TaskRow } from './primitives.js';
import type { PostgresDeliveryTasks } from './postgres-delivery-tasks.js';

type Address = {
  line1?: string;
  line2?: string;
  landmark?: string;
  pincode?: string;
  contactName?: string;
  lat?: number;
  lng?: number;
};
type ActiveRow = TaskRow & {
  order_number: string;
  address_snapshot: Address;
  store_name: string;
  store_lat: number;
  store_lng: number;
  cod_collected_paise: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateHistoryDetailInput(taskId: string, attemptNo?: number): void {
  if (!UUID_RE.test(taskId)) throw new Error('INVALID_INPUT');
  if (attemptNo !== undefined && (!Number.isInteger(attemptNo) || attemptNo < 0))
    throw new Error('INVALID_INPUT');
}

export function resolveHistoryStatus(
  riderId: string,
  attemptNo: number,
  taskAttempt: number,
  taskStatus: string,
  currentRiderId: string | null,
): string {
  if (attemptNo !== taskAttempt || (currentRiderId !== null && currentRiderId !== riderId))
    return 'REASSIGNED';
  return taskStatus;
}

/** Rider-scoped projections never expose customer contact outside live custody. */
export class RiderTaskReads {
  constructor(
    private readonly db: Database,
    private readonly tasks: PostgresDeliveryTasks,
  ) {}

  private async activeRows(riderId: string, taskId?: string): Promise<ActiveRow[]> {
    const result =
      await sql<ActiveRow>`SELECT t.*,o.order_number,o.address_snapshot,s.name AS store_name,
        (SELECT amount_paise::text FROM cod_collections WHERE order_id=t.order_id AND state='COLLECTED') AS cod_collected_paise,
        ST_Y(s.location::geometry) AS store_lat,ST_X(s.location::geometry) AS store_lng
      FROM delivery_tasks t JOIN orders o ON o.id=t.order_id JOIN stores s ON s.id=t.store_id
      WHERE t.rider_id=${riderId}::uuid AND t.status IN ('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')
        AND (${taskId ?? null}::uuid IS NULL OR t.id=${taskId ?? null}::uuid)
      ORDER BY t.created_at DESC,t.id DESC`.execute(this.db);
    return result.rows;
  }

  private async project(row: ActiveRow) {
    const task = await this.tasks.viewFor(row);
    const address = row.address_snapshot ?? {};
    const items = await sql<{ name_snapshot: string; fulfilled_qty: string }>`
      SELECT name_snapshot,(CASE WHEN ${row.status} IN ('ASSIGNED','AT_STORE') THEN ordered_qty ELSE fulfilled_qty END)::text AS fulfilled_qty
      FROM order_items WHERE order_id=${row.order_id}::uuid ORDER BY id`.execute(this.db);
    return {
      ...task,
      orderNumber: row.order_number,
      codCollectedPaise: row.cod_collected_paise,
      store: { name: row.store_name, lat: Number(row.store_lat), lng: Number(row.store_lng) },
      destination: {
        name: address.contactName ?? null,
        line1: address.line1 ?? null,
        line2: address.line2 ?? null,
        landmark: address.landmark ?? null,
        pincode: address.pincode ?? null,
        lat: address.lat ?? null,
        lng: address.lng ?? null,
      },
      items: items.rows.map((item) => ({ name: item.name_snapshot, quantity: item.fulfilled_qty })),
    };
  }

  async active(riderId: string) {
    return {
      items: await Promise.all((await this.activeRows(riderId)).map((row) => this.project(row))),
      nextCursor: null,
    };
  }

  async detail(riderId: string, taskId: string) {
    const row = (await this.activeRows(riderId, taskId))[0];
    if (!row) throw new Error('RESOURCE_NOT_FOUND');
    return this.project(row);
  }

  async history(riderId: string, before?: string) {
    if (before && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(before))
      throw new Error('INVALID_PAGE');
    const result = await sql<{
      history_id: string;
      task_id: string;
      order_id: string;
      order_number: string;
      attempt_no: number;
      task_attempt: number;
      status: string;
      rider_id: string | null;
      assigned_at: Date;
      total_paise: string | null;
    }>`
      SELECT h.id AS history_id,h.task_id,t.order_id,o.order_number,h.attempt_no,t.attempt_no AS task_attempt,
        t.status,t.rider_id,h.created_at AS assigned_at,(e.total_paise + COALESCE(a.amount_paise,0))::text AS total_paise
      FROM task_assignment_history h JOIN delivery_tasks t ON t.id=h.task_id JOIN orders o ON o.id=t.order_id
      LEFT JOIN rider_earnings e ON e.task_id=t.id AND e.rider_id=${riderId}::uuid
      LEFT JOIN rider_distance_adjustments a ON a.earning_id=e.id
      WHERE h.rider_id=${riderId}::uuid AND h.action IN ('ASSIGNED','REASSIGNED')
        AND (${before ?? null}::uuid IS NULL OR h.id<${before ?? null}::uuid)
      ORDER BY h.id DESC LIMIT 51`.execute(this.db);
    const page = result.rows.slice(0, 50);
    return {
      items: page.map((r) => ({
        id: r.task_id,
        orderId: r.order_id,
        orderNumber: r.order_number,
        attemptNo: r.attempt_no,
        assignedAt: r.assigned_at.toISOString(),
        status:
          r.attempt_no !== r.task_attempt || (r.rider_id !== null && r.rider_id !== riderId)
            ? 'REASSIGNED'
            : r.status,
        totalPaise: r.attempt_no === r.task_attempt ? r.total_paise : null,
      })),
      nextCursor: result.rows.length > 50 ? page.at(-1)!.history_id : null,
    };
  }

  async historyDetail(riderId: string, taskId: string, attemptNo?: number) {
    validateHistoryDetailInput(taskId, attemptNo);

    const history = await sql<{
      history_id: string;
      task_id: string;
      order_id: string;
      order_number: string;
      attempt_no: number;
      task_attempt: number;
      task_status: string;
      current_rider_id: string | null;
      assigned_at: Date;
      pickup_at: Date | null;
      arrived_store_at: Date | null;
      arrived_customer_at: Date | null;
      delivered_at: Date | null;
      failure_reason: string | null;
    }>`
      SELECT h.id AS history_id,h.task_id,t.order_id,o.order_number,h.attempt_no,
        t.attempt_no AS task_attempt,t.status AS task_status,t.rider_id AS current_rider_id,
        h.created_at AS assigned_at,t.pickup_at,t.arrived_store_at,t.arrived_customer_at,
        t.delivered_at,t.failure_reason
      FROM task_assignment_history h
        JOIN delivery_tasks t ON t.id=h.task_id
        JOIN orders o ON o.id=t.order_id
      WHERE h.rider_id=${riderId}::uuid
        AND h.task_id=${taskId}::uuid
        AND h.action IN ('ASSIGNED','REASSIGNED')
        AND (${attemptNo ?? null}::int IS NULL OR h.attempt_no=(${attemptNo ?? null}::int))
      ORDER BY h.attempt_no DESC,h.id DESC
      LIMIT 1`.execute(this.db);

    const row = history.rows[0];
    if (!row) throw new Error('RESOURCE_NOT_FOUND');

    const earning = await sql<{
      base_paise: string;
      distance_paise: string;
      incentive_paise: string;
      tip_paise: string;
      total_paise: string;
      distance_metres: number | null;
      computed_at: Date | null;
      amount_paise: string | null;
    }>`
      SELECT e.base_paise::text AS base_paise,
        e.distance_paise::text AS distance_paise,
        e.incentive_paise::text AS incentive_paise,
        e.tip_paise::text AS tip_paise,
        (e.total_paise + COALESCE(a.amount_paise,0))::text AS total_paise,
        e.distance_metres,
        e.computed_at,
        a.amount_paise::text AS amount_paise
      FROM rider_earnings e
      LEFT JOIN rider_distance_adjustments a ON a.earning_id=e.id
      WHERE e.task_id=${taskId}::uuid AND e.rider_id=${riderId}::uuid
      LIMIT 1`.execute(this.db);

    const e = earning.rows[0];
    const isCurrentAttempt = row.attempt_no === row.task_attempt;
    const showEarnings = isCurrentAttempt && e !== undefined;
    const distancePending =
      e !== undefined && e.distance_metres === null && e.amount_paise === null;

    return {
      id: row.task_id,
      taskId: row.task_id,
      orderId: row.order_id,
      orderNumber: row.order_number,
      attemptNo: row.attempt_no,
      assignedAt: row.assigned_at.toISOString(),
      status: resolveHistoryStatus(
        riderId,
        row.attempt_no,
        row.task_attempt,
        row.task_status,
        row.current_rider_id,
      ),
      pickupAt: row.pickup_at?.toISOString() ?? null,
      arrivedStoreAt: row.arrived_store_at?.toISOString() ?? null,
      arrivedCustomerAt: row.arrived_customer_at?.toISOString() ?? null,
      deliveredAt: row.delivered_at?.toISOString() ?? null,
      failureReason: row.failure_reason,
      earnings: {
        totalPaise: showEarnings ? e.total_paise : null,
        basePaise: showEarnings ? e.base_paise : null,
        distancePaise: showEarnings ? e.distance_paise : null,
        incentivePaise: showEarnings ? e.incentive_paise : null,
        tipPaise: showEarnings ? e.tip_paise : null,
        distanceMetres: showEarnings ? e.distance_metres : null,
        distancePending: showEarnings ? distancePending : false,
        computedAt: showEarnings && e.computed_at ? e.computed_at.toISOString() : null,
      },
    };
  }

  async dashboard(riderId: string) {
    const result = await sql<{ deliveries: string; total_paise: string }>`SELECT
      (SELECT count(DISTINCT task_id)::text FROM delivery_task_history WHERE actor_id=${riderId}::uuid AND status='DELIVERED'
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date) AS deliveries,
      ((SELECT COALESCE(sum(total_paise),0) FROM rider_earnings WHERE rider_id=${riderId}::uuid
        AND (computed_at AT TIME ZONE 'Asia/Kolkata')::date=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date)
       + (SELECT COALESCE(sum(amount_paise),0) FROM rider_distance_adjustments WHERE rider_id=${riderId}::uuid
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date))::text AS total_paise`.execute(
      this.db,
    );
    return {
      todayDeliveries: Number(result.rows[0]?.deliveries ?? 0),
      todayEarningsPaise: result.rows[0]?.total_paise ?? '0',
    };
  }
}
