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
        t.status,t.rider_id,h.created_at AS assigned_at,e.total_paise::text
      FROM task_assignment_history h JOIN delivery_tasks t ON t.id=h.task_id JOIN orders o ON o.id=t.order_id
      LEFT JOIN rider_earnings e ON e.task_id=t.id AND e.rider_id=${riderId}::uuid
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

  async dashboard(riderId: string) {
    const result = await sql<{ deliveries: string; total_paise: string }>`SELECT
      (SELECT count(DISTINCT task_id)::text FROM delivery_task_history WHERE actor_id=${riderId}::uuid AND status='DELIVERED'
        AND (created_at AT TIME ZONE 'Asia/Kolkata')::date=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date) AS deliveries,
      (SELECT COALESCE(sum(total_paise),0)::text FROM rider_earnings WHERE rider_id=${riderId}::uuid
        AND (computed_at AT TIME ZONE 'Asia/Kolkata')::date=(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date) AS total_paise`.execute(
      this.db,
    );
    return {
      todayDeliveries: Number(result.rows[0]?.deliveries ?? 0),
      todayEarningsPaise: result.rows[0]?.total_paise ?? '0',
    };
  }
}
