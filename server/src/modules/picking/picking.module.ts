import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { InventoryShortfallConsumer } from './infrastructure/inventory-shortfall-consumer.js';
import { PLATFORM_DATABASE, PLATFORM_QUEUE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import type { DurableQueue } from '../../platform/queue/queue.js';
import { IdentityModule } from '../identity/identity.module.js';
import { IDENTITY_ACCESS, type IdentityAccess } from '../identity/contracts/identity.js';
import { IDENTITY_ROSTER, type IdentityRoster } from '../identity/contracts/roster.js';
import { StoresModule } from '../stores/stores.module.js';
import { STORE_SIGNALS, type StoreSignals } from '../stores/contracts/signals.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import {
  ADMIN_CONFIG,
  APP_CONFIG,
  type AdminConfig,
  type AppConfig,
} from '../app-config/contracts/config.js';
import { InventoryModule } from '../inventory/inventory.module.js';
import {
  INVENTORY_PICK_GUIDANCE,
  type InventoryPickGuidance,
} from '../inventory/contracts/pick-guidance.js';
import {
  INVENTORY_SUBSTITUTION_SWAPS,
  type InventorySubstitutionSwaps,
} from '../inventory/contracts/substitution.js';
import {
  INVENTORY_RESERVATIONS,
  type InventoryReservations,
} from '../inventory/contracts/inventory.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CATALOG_LOOKUP, type CatalogLookup } from '../catalog/contracts/lookup.js';
import { ConfigService } from '../../config/config.service.js';
import {
  FINANCIAL_ADJUSTMENTS,
  ORDER_CANCELLATION,
  ORDER_FULFILLMENT,
  ORDER_FULFILLMENT_READS,
  type FinancialAdjustments,
  type OrderCancellation,
  type OrderFulfillment,
  type OrderFulfillmentReads,
} from './contracts/fulfillment.js';
import { HANDOVER_CODES, HANDOVER_STATUS, PICK_PACKING } from './contracts/packing.js';
import { PICK_CANCELLATION, PICK_TASKS } from './contracts/tasks.js';
import { OrderConfirmedConsumer } from './infrastructure/confirmation-consumer.js';
import { PickingSlaWorker } from './infrastructure/sla-worker.js';
import { PostgresPickTasks } from './infrastructure/postgres-pick-tasks.js';
import { PostgresPickActions } from './infrastructure/postgres-pick-actions.js';
import { PostgresPickViews } from './infrastructure/postgres-pick-views.js';
import { PostgresPickCancellation } from './infrastructure/postgres-pick-cancellation.js';
import { PostgresPacking } from './infrastructure/postgres-packing.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ORDER_PICKING_INTEGRATION } from '../orders/contracts/orders.js';
import { recoverDisconnected } from './infrastructure/presence.js';

/** Outbox consumer name: P6 routes ORDER_CONFIRMED deliveries to 'picking'. */
export const PICKING_CONSUMER = 'picking';

/**
 * Store fulfillment module. The order-side ports (ORDER_FULFILLMENT,
 * FINANCIAL_ADJUSTMENTS, ORDER_CANCELLATION, ORDER_FULFILLMENT_READS) are
 * bound to the real order integration provider; stock and financial changes
 * share the fulfillment transaction.
 */
@Module({
  imports: [
    IdentityModule,
    AppConfigModule,
    StoresModule,
    InventoryModule,
    CatalogModule,
    OrdersModule,
  ],
  providers: [
    { provide: ORDER_FULFILLMENT, useExisting: ORDER_PICKING_INTEGRATION },
    { provide: FINANCIAL_ADJUSTMENTS, useExisting: ORDER_PICKING_INTEGRATION },
    { provide: ORDER_CANCELLATION, useExisting: ORDER_PICKING_INTEGRATION },
    { provide: ORDER_FULFILLMENT_READS, useExisting: ORDER_PICKING_INTEGRATION },
    {
      provide: PostgresPickViews,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresPickViews(handle.db),
    },
    {
      provide: PostgresPickActions,
      inject: [
        PLATFORM_DATABASE,
        IDENTITY_ACCESS,
        ADMIN_CONFIG,
        CATALOG_LOOKUP,
        INVENTORY_SUBSTITUTION_SWAPS,
        INVENTORY_RESERVATIONS,
        FINANCIAL_ADJUSTMENTS,
        ORDER_CANCELLATION,
      ],
      useFactory: (
        handle: DatabaseHandle,
        identity: IdentityAccess,
        admin: AdminConfig,
        lookup: CatalogLookup,
        swaps: InventorySubstitutionSwaps,
        reservations: InventoryReservations,
        adjustments: FinancialAdjustments,
        cancellation: OrderCancellation,
      ) =>
        new PostgresPickActions(
          handle.db,
          identity,
          admin,
          lookup,
          swaps,
          reservations,
          adjustments,
          cancellation,
        ),
    },
    {
      provide: PostgresPickTasks,
      inject: [
        PLATFORM_DATABASE,
        IDENTITY_ACCESS,
        APP_CONFIG,
        INVENTORY_PICK_GUIDANCE,
        PostgresPickActions,
        PostgresPickViews,
        IDENTITY_ROSTER,
        ORDER_FULFILLMENT_READS,
        ORDER_FULFILLMENT,
      ],
      useFactory: (
        handle: DatabaseHandle,
        identity: IdentityAccess,
        config: AppConfig,
        guidance: InventoryPickGuidance,
        actions: PostgresPickActions,
        views: PostgresPickViews,
        roster: IdentityRoster,
        reads: OrderFulfillmentReads,
        fulfillment: OrderFulfillment,
      ) =>
        new PostgresPickTasks(
          handle.db,
          identity,
          config,
          guidance,
          actions,
          views,
          roster,
          reads,
          fulfillment,
        ),
    },
    { provide: PICK_TASKS, useExisting: PostgresPickTasks },
    {
      provide: PostgresPickCancellation,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresPickCancellation(handle.db),
    },
    { provide: PICK_CANCELLATION, useExisting: PostgresPickCancellation },
    {
      provide: PostgresPacking,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS, APP_CONFIG, ConfigService, ORDER_FULFILLMENT],
      useFactory: (
        handle: DatabaseHandle,
        identity: IdentityAccess,
        config: AppConfig,
        runtime: ConfigService,
        fulfillment: OrderFulfillment,
      ) => new PostgresPacking(handle.db, identity, config, runtime, fulfillment),
    },
    { provide: PICK_PACKING, useExisting: PostgresPacking },
    { provide: HANDOVER_CODES, useExisting: PostgresPacking },
    { provide: HANDOVER_STATUS, useExisting: PostgresPacking },
  ],
  exports: [
    PICK_TASKS,
    PICK_CANCELLATION,
    PICK_PACKING,
    HANDOVER_CODES,
    HANDOVER_STATUS,
    ORDER_FULFILLMENT,
    FINANCIAL_ADJUSTMENTS,
    ORDER_CANCELLATION,
    ORDER_FULFILLMENT_READS,
  ],
})
export class PickingModule {}

/** Database rows remain authoritative and recover after worker restarts. */
@Injectable()
class PickingWorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private readonly consumer: OrderConfirmedConsumer;
  private readonly sla: PickingSlaWorker;
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly handle: DatabaseHandle,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(STORE_SIGNALS) signals: StoreSignals,
    @Inject(PLATFORM_QUEUE) private readonly queue: DurableQueue,
    @Inject(PICK_CANCELLATION) private readonly cancellation: PostgresPickCancellation,
    @Inject(ORDER_CANCELLATION) private readonly orders: OrderCancellation,
  ) {
    this.consumer = new OrderConfirmedConsumer(config);
    this.sla = new PickingSlaWorker(handle.db, signals);
  }
  onApplicationBootstrap(): void {
    this.queue.registerHandler(PICKING_CONSUMER, async (tx, event) => {
      if (event.eventType === 'ORDER_CANCELLED') {
        const payload = event.payload as { orderId?: string; reason?: string };
        if (!payload.orderId) throw new Error('UNPARSEABLE_EVENT');
        await this.cancellation.cancel(payload.orderId, payload.reason ?? 'ORDER_CANCELLED', tx);
      } else await this.consumer.handle(tx, event);
    });
    const shortfalls = new InventoryShortfallConsumer(this.orders, this.cancellation);
    this.queue.registerHandler('inventory-shortfalls', (tx, event) => shortfalls.handle(tx, event));
    this.run();
    this.timer = setInterval(() => this.run(), 60000);
    this.timer.unref();
  }
  private run(): void {
    if (this.active) return;
    this.active = (async () => {
      await this.sla.runOnce();
      await recoverDisconnected(this.handle.db, this.config);
    })()
      .catch(() => {
        process.stderr.write('Picking maintenance failed; it will retry\n');
      })
      .finally(() => {
        this.active = undefined;
      });
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}

@Module({
  imports: [PickingModule, AppConfigModule, StoresModule, OrdersModule],
  providers: [PickingWorkerLifecycle],
})
export class PickingWorkerModule {}
