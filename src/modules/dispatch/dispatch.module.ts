import { InventoryModule } from '../inventory/inventory.module.js';
import { publishOfferRevocation } from './infrastructure/revocation-realtime.js';
import { PostgresWrongAddress } from './infrastructure/wrong-address.js';
import { INVENTORY_RETURNS, type InventoryReturns } from '../inventory/contracts/returns.js';
import { IDENTITY_ACCESS, type IdentityAccess } from '../identity/contracts/identity.js';
import { DELIVERY_RETURN } from './contracts/tasks.js';
import { ReturnToStore } from './infrastructure/return-to-store.js';
import { PRIVATE_UPLOADS, type PrivateUploadPort } from '../identity/contracts/uploads.js';
import { DeliveryPodMedia } from './infrastructure/pod-media.js';
import { DELIVERY_POD } from './contracts/tasks.js';
import { ServiceabilityModule } from '../serviceability/serviceability.module.js';
import { MAPS } from '../serviceability/contracts/tokens.js';
import type { MapsPort } from '../serviceability/contracts/maps.js';
import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { PLATFORM_DATABASE, PLATFORM_QUEUE } from '../../platform/contracts/runtime.js';

import {
  transactionWithRetry,
  type Database,
  type DatabaseHandle,
  type TransactionContext,
} from '../../platform/database/database.js';
import type { DurableQueue } from '../../platform/queue/queue.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PickingModule } from '../picking/picking.module.js';
import {
  HANDOVER_CODES,
  HANDOVER_STATUS,
  type HandoverCodes,
  type HandoverStatus,
} from '../picking/contracts/packing.js';
import { RidersModule } from '../riders/riders.module.js';
import {
  COD_COLLECTIONS,
  RIDER_ELIGIBILITY,
  RIDER_EARNINGS,
  type CodCollections,
  type RiderEarnings,
  type RiderEligibility,
} from '../riders/contracts/riders.js';
import { TrackingModule } from '../tracking/tracking.module.js';
import {
  ETA_PROVIDER,
  REALTIME_BROADCASTS,
  RIDER_GEO,
  RIDER_LOCATION_READS,
} from '../tracking/contracts/tokens.js';
import type {
  EtaProvider,
  RealtimeBroadcasts,
  RiderGeo,
  RiderLocationReads,
} from '../tracking/contracts/tracking.js';
import {
  ORDER_DELIVERY,
  ORDER_DELIVERY_READS,
  ORDER_SYSTEM_CANCEL,
  type OrderDelivery,
  type OrderDeliveryReads,
  type OrderSystemCancel,
} from './contracts/dependencies.js';
import {
  CUSTOMER_TRACKING,
  DELIVERY_CODES,
  DELIVERY_TASK_CANCELLATION,
  DELIVERY_TASKS,
  type DeliveryCodes,
  type DeliveryTaskCancellation,
} from './contracts/tasks.js';
import { OrderConfirmedConsumer, PickTriggerConsumer } from './infrastructure/consumers.js';
import { DispatchEngine } from './infrastructure/dispatch-engine.js';
import { DispatchMaintenance } from './infrastructure/maintenance.js';
import { PostgresCustomerTracking } from './infrastructure/postgres-customer-tracking.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ORDER_CODES, ORDER_INTEGRATION, type OrderCodes } from '../orders/contracts/orders.js';
import { PostgresDeliveryTaskCancellation } from './infrastructure/postgres-cancellation.js';
import {
  PostgresDeliveryTasks,
  type TaskOutcome,
  type TaskRunner,
} from './infrastructure/postgres-delivery-tasks.js';
import { DeliveryTasksFacade } from './infrastructure/delivery-tasks-facade.js';
import { PostgresTaskActions } from './infrastructure/postgres-task-actions.js';
import { DispatchRealtimeLifecycle } from './infrastructure/realtime.js';
import { DispatchSettings } from './infrastructure/settings.js';
import { ManualAssignment } from './infrastructure/manual-assignment.js';
import { CanonicalDeliveryCodes } from './infrastructure/canonical-codes.js';
import { DELIVERY_ASSIGNMENT, WRONG_ADDRESS } from './contracts/tasks.js';

/** Outbox consumer name: P6 routes ORDER_CONFIRMED deliveries to 'dispatch'. */
export const DISPATCH_CONSUMER = 'dispatch';
/** Secondary consumer for the configured dispatch trigger events. */
export const PICK_TRIGGER_CONSUMER = 'dispatch-trigger';

/**
 * Shared transaction runner: domain effects (realtime emissions, follow-up
 * dispatch rounds) execute only after the transaction commits.
 */
export function taskRunner(db: Database) {
  return async function run<T>(
    fn: (tx: TransactionContext) => Promise<TaskOutcome<T>>,
  ): Promise<T> {
    const outcome = await transactionWithRetry(db, fn);
    for (const effect of outcome.effects ?? [])
      try {
        effect();
      } catch {
        // emissions never break order flow; polling is the fallback
      }
    return outcome.result;
  };
}

export const TASK_RUNNER = Symbol('DISPATCH_TASK_RUNNER');

@Module({
  imports: [
    AppConfigModule,
    IdentityModule,
    PickingModule,
    RidersModule,
    TrackingModule,
    OrdersModule,
    ServiceabilityModule,
    InventoryModule,
  ],
  providers: [
    {
      provide: WRONG_ADDRESS,
      inject: [TASK_RUNNER, DispatchSettings, ORDER_DELIVERY, REALTIME_BROADCASTS],
      useFactory: (
        run: TaskRunner,
        settings: DispatchSettings,
        orders: OrderDelivery,
        broadcasts: RealtimeBroadcasts,
      ) => new PostgresWrongAddress(run, settings, orders, broadcasts),
    },
    {
      provide: DELIVERY_RETURN,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS, INVENTORY_RETURNS, ORDER_DELIVERY],
      useFactory: (
        handle: DatabaseHandle,
        identity: IdentityAccess,
        inventory: InventoryReturns,
        orders: OrderDelivery,
      ) => new ReturnToStore(handle.db, identity, inventory, orders),
    },
    {
      provide: DELIVERY_POD,
      inject: [PLATFORM_DATABASE, PRIVATE_UPLOADS],
      useFactory: (handle: DatabaseHandle, uploads: PrivateUploadPort) =>
        new DeliveryPodMedia(handle.db, uploads),
    },
    {
      provide: DispatchSettings,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new DispatchSettings(config),
    },
    { provide: ORDER_DELIVERY, useExisting: ORDER_INTEGRATION },
    { provide: ORDER_DELIVERY_READS, useExisting: ORDER_INTEGRATION },
    { provide: ORDER_SYSTEM_CANCEL, useExisting: ORDER_INTEGRATION },
    {
      provide: DELIVERY_CODES,
      inject: [ORDER_CODES],
      useFactory: (codes: OrderCodes): DeliveryCodes => new CanonicalDeliveryCodes(codes),
    },
    {
      provide: PostgresDeliveryTaskCancellation,
      inject: [PLATFORM_DATABASE, REALTIME_BROADCASTS],
      useFactory: (handle: DatabaseHandle, broadcasts: RealtimeBroadcasts) =>
        new PostgresDeliveryTaskCancellation(handle.db, broadcasts),
    },
    { provide: DELIVERY_TASK_CANCELLATION, useExisting: PostgresDeliveryTaskCancellation },
    {
      provide: DispatchEngine,
      inject: [
        PLATFORM_DATABASE,
        DispatchSettings,
        APP_CONFIG,
        REALTIME_BROADCASTS,
        RIDER_GEO,
        RIDER_ELIGIBILITY,
        ORDER_SYSTEM_CANCEL,
        DELIVERY_TASK_CANCELLATION,
        MAPS,
      ],
      useFactory: (
        handle: DatabaseHandle,
        settings: DispatchSettings,
        config: AppConfig,
        broadcasts: RealtimeBroadcasts,
        riderGeo: RiderGeo,
        eligibility: RiderEligibility,
        orderSystemCancel: OrderSystemCancel,
        cancellation: DeliveryTaskCancellation,
        maps: MapsPort,
      ) =>
        new DispatchEngine(
          handle.db,
          settings,
          config,
          broadcasts,
          riderGeo,
          eligibility,
          orderSystemCancel,
          cancellation,
          maps,
        ),
    },
    {
      provide: PostgresDeliveryTasks,
      inject: [PLATFORM_DATABASE, DispatchSettings, REALTIME_BROADCASTS, HANDOVER_CODES],
      useFactory: (
        handle: DatabaseHandle,
        settings: DispatchSettings,
        broadcasts: RealtimeBroadcasts,
        handoverCodes: HandoverCodes,
      ) => new PostgresDeliveryTasks(handle.db, settings, broadcasts, handoverCodes),
    },
    { provide: DELIVERY_TASKS, useExisting: DeliveryTasksFacade },
    {
      provide: DeliveryTasksFacade,
      inject: [PostgresDeliveryTasks, PostgresTaskActions],
      useFactory: (tasks: PostgresDeliveryTasks, actions: PostgresTaskActions) =>
        new DeliveryTasksFacade(tasks, actions),
    },
    {
      provide: TASK_RUNNER,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => taskRunner(handle.db),
    },
    {
      provide: PostgresCustomerTracking,
      inject: [PLATFORM_DATABASE, RIDER_LOCATION_READS, ETA_PROVIDER, DELIVERY_CODES],
      useFactory: (
        handle: DatabaseHandle,
        locations: RiderLocationReads,
        eta: EtaProvider,
        codes: DeliveryCodes,
      ) => new PostgresCustomerTracking(handle.db, locations, eta, codes),
    },
    { provide: CUSTOMER_TRACKING, useExisting: PostgresCustomerTracking },
    {
      provide: PostgresTaskActions,
      inject: [
        PLATFORM_DATABASE,
        DispatchSettings,
        REALTIME_BROADCASTS,
        HANDOVER_STATUS,
        ORDER_DELIVERY,
        ORDER_DELIVERY_READS,
        COD_COLLECTIONS,
        RIDER_EARNINGS,
        DELIVERY_CODES,
        ETA_PROVIDER,
        DispatchEngine,
        TASK_RUNNER,
      ],
      useFactory: (
        handle: DatabaseHandle,
        settings: DispatchSettings,
        broadcasts: RealtimeBroadcasts,
        handoverStatus: HandoverStatus,
        orderDelivery: OrderDelivery,
        orderReads: OrderDeliveryReads,
        cod: CodCollections,
        earnings: RiderEarnings,
        codes: DeliveryCodes,
        eta: EtaProvider,
        engine: DispatchEngine,
        runner: TaskRunner,
      ) =>
        new PostgresTaskActions(
          handle.db,
          settings,
          broadcasts,
          handoverStatus,
          orderDelivery,
          orderReads,
          cod,
          earnings,
          codes,
          eta,
          (orderId) => engine.dispatchOne(orderId).then(() => undefined),
          runner,
        ),
    },
    DispatchRealtimeLifecycle,
    {
      provide: DELIVERY_ASSIGNMENT,
      inject: [PostgresDeliveryTasks],
      useFactory: (tasks: PostgresDeliveryTasks) => new ManualAssignment(tasks),
    },
  ],
  exports: [
    WRONG_ADDRESS,
    DELIVERY_ASSIGNMENT,
    DELIVERY_RETURN,
    DELIVERY_POD,
    DELIVERY_TASKS,
    DELIVERY_TASK_CANCELLATION,
    DELIVERY_CODES,
    CUSTOMER_TRACKING,
    ORDER_DELIVERY,
    ORDER_DELIVERY_READS,
    ORDER_SYSTEM_CANCEL,
    DispatchEngine,
    DispatchSettings,
  ],
})
export class DispatchModule {}

/** Worker composition: outbox consumers plus the dispatch/custody sweeps. */
@Injectable()
class DispatchWorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private active?: Promise<unknown>;
  private readonly maintenance: DispatchMaintenance;
  private readonly consumer: OrderConfirmedConsumer;
  private readonly trigger: PickTriggerConsumer;
  constructor(
    @Inject(PLATFORM_DATABASE) handle: DatabaseHandle,
    @Inject(PLATFORM_QUEUE) private readonly queue: DurableQueue,
    @Inject(APP_CONFIG) config: AppConfig,
    settings: DispatchSettings,
    engine: DispatchEngine,
    @Inject(DELIVERY_CODES) codes: DeliveryCodes,
    @Inject(REALTIME_BROADCASTS) private readonly broadcasts: RealtimeBroadcasts,
    @Inject(DELIVERY_TASK_CANCELLATION) private readonly cancellation: DeliveryTaskCancellation,
  ) {
    this.maintenance = new DispatchMaintenance(handle.db, settings, engine, broadcasts);
    this.consumer = new OrderConfirmedConsumer(config, codes);
    this.trigger = new PickTriggerConsumer(
      () => settings.trigger(),
      (orderId) => engine.dispatchOne(orderId).then(() => undefined),
    );
  }
  onApplicationBootstrap(): void {
    this.queue.registerHandler(DISPATCH_CONSUMER, (tx, event) =>
      event.eventType === 'ORDER_CANCELLED'
        ? this.cancellation.cancel(event.aggregateId, 'ORDER_CANCELLED', tx)
        : this.consumer.handle(tx, event),
    );
    this.queue.registerHandler(PICK_TRIGGER_CONSUMER, (tx, event) =>
      this.trigger.handle(tx, event),
    );
    this.queue.registerHandler('dispatch-realtime', (_tx, event) =>
      publishOfferRevocation(event, this.broadcasts),
    );
    this.run();
    this.timer = setInterval(() => this.run(), 10000);
    this.timer.unref();
  }
  private run(): void {
    if (this.active) return;
    this.active = this.maintenance
      .runOnce()
      .then(
        () => undefined,
        () => process.stderr.write('Dispatch maintenance failed; it will retry\n'),
      )
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
  imports: [DispatchModule, AppConfigModule, TrackingModule],
  providers: [DispatchWorkerLifecycle],
})
export class DispatchWorkerModule {}
