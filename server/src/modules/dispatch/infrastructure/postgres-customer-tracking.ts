import { sql } from 'kysely';
import type { Database, Json } from '../../../platform/database/database.js';
import type { EtaProvider, RiderLocationReads } from '../../tracking/contracts/tracking.js';
import { haversineMetres } from '../domain/geo.js';
import type { CustomerTracking, DeliveryCodes, OrderTrackingView } from '../contracts/tasks.js';

function parseSnapshot(snapshot: Json | null): { lat: number; lng: number } | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const raw = snapshot as Record<string, unknown>;
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

/**
 * Customer tracking reads (23.4): ownership via the task's customer binding,
 * live visibility only inside the custody window (ASSIGNED..ARRIVED keeps a
 * live location; DELIVERED/FAILED/CANCELLED revoke it), ETA as a range.
 */
export class PostgresCustomerTracking implements CustomerTracking {
  constructor(
    private readonly db: Database,
    private readonly locations: RiderLocationReads,
    private readonly eta: EtaProvider,
    private readonly codes: DeliveryCodes,
  ) {}

  async tracking(orderId: string, customerId: string): Promise<OrderTrackingView | null> {
    const rows = await sql<{
      id: string;
      status: string;
      attempt_no: number;
      rider_id: string | null;
      store_id: string;
      customer_user_id: string | null;
      eta_min_minutes: number | null;
      eta_max_minutes: number | null;
    }>`SELECT id,status,attempt_no,rider_id,store_id,customer_user_id,eta_min_minutes,eta_max_minutes
      FROM delivery_tasks WHERE order_id=${orderId}::uuid ORDER BY created_at DESC LIMIT 1`.execute(
      this.db,
    );
    const task = rows.rows[0];
    if (!task || task.customer_user_id !== customerId) return null;
    const live =
      task.rider_id && ['ASSIGNED', 'AT_STORE', 'PICKED_UP', 'ARRIVED'].includes(task.status);
    const location =
      live && task.rider_id ? await this.locations.lastLocation(task.rider_id) : null;
    let eta: OrderTrackingView['eta'] = null;
    if (task.eta_min_minutes !== null && task.eta_max_minutes !== null) {
      eta = { minMinutes: task.eta_min_minutes, maxMinutes: task.eta_max_minutes };
    } else if (live) {
      eta = await this.computeEta(orderId, task.store_id);
    }
    return {
      orderId,
      taskStatus: task.status as OrderTrackingView['taskStatus'],
      attemptNo: task.attempt_no,
      riderLocation:
        location && live
          ? { lat: location.location.lat, lng: location.location.lng, at: location.at }
          : null,
      eta,
    };
  }

  async deliveryCode(
    orderId: string,
    customerId: string,
  ): Promise<{ code: string; keyVersion: number }> {
    // Authorization happens inside the port; ownership is re-checked here.
    const rows = await sql<{
      customer_user_id: string | null;
    }>`SELECT customer_user_id FROM delivery_tasks
      WHERE order_id=${orderId}::uuid ORDER BY created_at DESC LIMIT 1`.execute(this.db);
    if (rows.rows[0]?.customer_user_id !== customerId) throw new Error('RESOURCE_NOT_FOUND');
    return this.codes.present(orderId, customerId, 'CUSTOMER');
  }

  private async computeEta(orderId: string, storeId: string): Promise<OrderTrackingView['eta']> {
    const [storeRows, destRows] = await Promise.all([
      sql<{
        lat: string;
        lng: string;
      }>`SELECT ST_Y(location::geometry)::text AS lat,ST_X(location::geometry)::text AS lng FROM stores WHERE id=${storeId}::uuid`.execute(
        this.db,
      ),
      sql<{
        address_snapshot: Json;
      }>`SELECT address_snapshot FROM orders WHERE id=${orderId}::uuid`.execute(this.db),
    ]);
    const store = storeRows.rows[0];
    const destination = parseSnapshot(destRows.rows[0]?.address_snapshot ?? null);
    if (!store || !destination) return null;
    const metres = haversineMetres(
      { lat: Number(store.lat), lng: Number(store.lng) },
      { lat: destination.lat, lng: destination.lng },
    );
    return this.eta.eta({ storeToCustomerMetres: metres, pickedUp: false });
  }
}
