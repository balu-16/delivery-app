import { Inject, Injectable, Optional } from '@nestjs/common';
import { sql } from 'kysely';
import {
  IDENTITY_AUTHORIZER,
  TOKEN_VERIFIER,
  type IdentityAuthorizer,
  type TokenVerifier,
} from '../../identity/contracts/identity.js';
import { PLATFORM_DATABASE, REALTIME_GATEWAY } from '../../../platform/contracts/runtime.js';
import type { Database, DatabaseHandle, Json } from '../../../platform/database/database.js';
import type {
  ActiveOrderResolver,
  EtaProvider,
  NamespaceRegistryPort,
  RiderLocationReads,
} from '../../tracking/contracts/tracking.js';
import {
  ACTIVE_ORDER_RESOLVER_HOLDER,
  ETA_PROVIDER,
  NAMESPACE_REGISTRY,
  RIDER_LOCATION_READS,
} from '../../tracking/contracts/tokens.js';
import type { ActiveOrderResolverHolder } from '../../tracking/contracts/tracking.js';
import { ConfigService } from '../../../config/config.service.js';
import type {
  RealtimeGateway,
  RealtimeIdentity,
  RealtimeNamespace,
} from '../../../platform/realtime/realtime.js';
import { DELIVERY_TASKS, type DeliveryTasks } from '../contracts/tasks.js';

/**
 * Realtime registration (P8): the /rider namespace (offers, task updates) on
 * rider/all roles and the /customer namespace (per-order rooms) on
 * customer/all roles. Room authorization is re-checked on every join; riders
 * may join an order room only inside their active custody window and
 * customers only their own active orders. Terminal states revoke live
 * location visibility because publishers stop and snapshots exclude them.
 */
@Injectable()
export class DispatchRealtimeLifecycle {
  private registered = new Set<string>();
  private readonly db: Database;
  constructor(
    @Inject(PLATFORM_DATABASE) handle: DatabaseHandle,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(IDENTITY_AUTHORIZER) private readonly identities: IdentityAuthorizer,
    private readonly env: ConfigService,
    @Inject(NAMESPACE_REGISTRY) private readonly registry: NamespaceRegistryPort,
    @Inject(DELIVERY_TASKS) private readonly tasks: DeliveryTasks,
    @Inject(RIDER_LOCATION_READS) private readonly locations: RiderLocationReads,
    @Inject(ETA_PROVIDER) private readonly eta: EtaProvider,
    @Optional() @Inject(REALTIME_GATEWAY) private readonly gateway?: RealtimeGateway,
    @Optional()
    @Inject(ACTIVE_ORDER_RESOLVER_HOLDER)
    private readonly resolverHolder?: ActiveOrderResolverHolder,
  ) {
    this.db = handle.db;
  }

  onApplicationBootstrap(): void {
    // Dependency inversion: tracking's location publisher resolves the
    // rider's active custody task through this resolver (no module cycle).
    const resolver: ActiveOrderResolver = {
      activeOrderForRider: async (riderId: string) => {
        const rows = await sql<{
          order_id: string;
          customer_user_id: string | null;
          status: string;
        }>`SELECT order_id,customer_user_id,status FROM delivery_tasks
          WHERE rider_id=${riderId}::uuid AND status IN ('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')
          ORDER BY created_at DESC LIMIT 1`.execute(this.db);
        const row = rows.rows[0];
        return row
          ? { orderId: row.order_id, customerUserId: row.customer_user_id, taskStatus: row.status }
          : null;
      },
      activeOrdersForRider: async (riderId: string) => {
        const rows = await sql<{
          order_id: string;
          customer_user_id: string | null;
          status: string;
        }>`
          SELECT order_id,customer_user_id,status FROM delivery_tasks
          WHERE rider_id=${riderId}::uuid AND status IN ('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')`.execute(
          this.db,
        );
        return rows.rows.map((row) => ({
          orderId: row.order_id,
          customerUserId: row.customer_user_id,
          taskStatus: row.status,
        }));
      },
    };
    this.resolverHolder?.register(resolver);
    if (!this.gateway) return; // metadata composition / worker-only roles
    const role = this.env.get('APP_ROLE');
    if ((role === 'rider' || role === 'all') && !this.registered.has('/rider')) {
      const handle: RealtimeNamespace = this.gateway.register(this.riderSpec());
      this.registered.add('/rider');
      this.registry.register(handle);
    }
    if ((role === 'customer' || role === 'all') && !this.registered.has('/customer')) {
      const handle: RealtimeNamespace = this.gateway.register(this.customerSpec());
      this.registered.add('/customer');
      this.registry.register(handle);
    }
  }

  private riderSpec() {
    return {
      name: '/rider',
      authenticate: async (token: string | undefined): Promise<RealtimeIdentity | null> => {
        if (!token) return null;
        try {
          const identity = await this.verifier.verify(token, 'rider', 'access');
          const principal = await this.identities.authorize(identity, 'rider', false);
          return { userId: principal.userId, pool: 'WORKFORCE', roles: principal.roles };
        } catch {
          return null;
        }
      },
      authorizeRoom: async (identity: RealtimeIdentity, room: string): Promise<boolean> => {
        const orderId = /^order:(.+)$/.exec(room)?.[1];
        if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) return false;
        const rows = await sql<{ status: string }>`SELECT status FROM delivery_tasks
          WHERE order_id=${orderId}::uuid AND rider_id=${identity.userId}::uuid
          AND status IN ('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')`.execute(this.db);
        return rows.rows.length > 0;
      },
      snapshot: async (identity: RealtimeIdentity): Promise<Json> => {
        const [offers, current, active] = await Promise.all([
          this.tasks.offers(identity.userId),
          this.tasks.currentTask(identity.userId),
          sql<{
            id: string;
            status: string;
            order_id: string;
          }>`SELECT id,status,order_id FROM delivery_tasks
            WHERE rider_id=${identity.userId}::uuid AND status IN ('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')
            ORDER BY created_at DESC`.execute(this.db),
        ]);
        return JSON.parse(
          JSON.stringify({
            offers: offers.items,
            currentTask: current,
            activeTasks: active.rows.map((row) => ({
              id: row.id,
              status: row.status,
              orderId: row.order_id,
            })),
          }),
        ) as Json;
      },
    };
  }

  private customerSpec() {
    return {
      name: '/customer',
      authenticate: async (token: string | undefined): Promise<RealtimeIdentity | null> => {
        if (!token) return null;
        try {
          const identity = await this.verifier.verify(token, 'customer', 'access');
          const principal = await this.identities.authorize(identity, 'customer', false);
          return { userId: principal.userId, pool: 'CUSTOMER', roles: principal.roles };
        } catch {
          return null;
        }
      },
      authorizeRoom: async (identity: RealtimeIdentity, room: string): Promise<boolean> => {
        const orderId = /^order:(.+)$/.exec(room)?.[1];
        if (!orderId || !/^[0-9a-f-]{36}$/i.test(orderId)) return false;
        const rows = await sql<{
          customer_user_id: string | null;
          status: string;
        }>`SELECT customer_user_id,status FROM delivery_tasks
          WHERE order_id=${orderId}::uuid ORDER BY created_at DESC LIMIT 1`.execute(this.db);
        const row = rows.rows[0];
        if (!row || row.customer_user_id !== identity.userId) return false;
        // Active orders only: terminal states stop the room entirely.
        return !['DELIVERED', 'FAILED', 'CANCELLED'].includes(row.status);
      },
      snapshot: async (identity: RealtimeIdentity): Promise<Json> => {
        const rows = await sql<{
          order_id: string;
          status: string;
          rider_id: string | null;
        }>`SELECT order_id,status,rider_id FROM delivery_tasks
          WHERE customer_user_id=${identity.userId}::uuid
            AND status IN ('ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')
          ORDER BY created_at DESC LIMIT 20`.execute(this.db);
        const orders = await Promise.all(
          rows.rows.map(async (row) => {
            const location = row.rider_id ? await this.locations.lastLocation(row.rider_id) : null;
            const eta = row.rider_id
              ? await this.etaForOrder(row.order_id, row.rider_id, row.status)
              : null;
            return {
              orderId: row.order_id,
              status: row.status,
              riderLocation: location
                ? { lat: location.location.lat, lng: location.location.lng, at: location.at }
                : null,
              eta,
            };
          }),
        );
        return JSON.parse(JSON.stringify({ orders })) as Json;
      },
    };
  }

  private async etaForOrder(orderId: string, riderId: string, status: string) {
    const task = await sql<{
      store_id: string;
    }>`SELECT store_id FROM delivery_tasks WHERE order_id=${orderId}::uuid ORDER BY created_at DESC LIMIT 1`.execute(
      this.db,
    );
    const storeId = task.rows[0]?.store_id;
    if (!storeId) return null;
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
    const snapshot = destRows.rows[0]?.address_snapshot as
      { lat?: number; lng?: number } | undefined;
    if (!store || !snapshot?.lat || !snapshot?.lng) return null;
    const metres = haversine(Number(store.lat), Number(store.lng), snapshot.lat, snapshot.lng);
    const range = await this.eta.eta({
      storeToCustomerMetres: metres,
      pickedUp: status === 'PICKED_UP' || status === 'ARRIVED',
      riderToStoreMetres: undefined,
    });
    void riderId;
    return range;
  }
}

function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_008.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.min(1, Math.sqrt(h))));
}
