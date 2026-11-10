import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import {
  PLATFORM_CONCERN_QUEUES,
  PLATFORM_DATABASE,
  PLATFORM_QUEUE,
} from '../../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../../platform/database/database.js';
import type { DurableQueue } from '../../../platform/queue/queue.js';
import type { ConcernQueues } from '../../../platform/queue/concern-queues.js';
import {
  NOTIFICATIONS_CONSUMER,
  NOTIFICATION_PIPELINE,
  type NotificationPipeline,
} from '../contracts/notifications.js';
import { DlqGrowthAlert } from './dlq-alert.js';

const SCAN_INTERVAL_MS = 30_000;
const ALERT_INTERVAL_MS = 300_000;

/**
 * Worker lifecycle: registers the outbox consumer ('notifications') and the
 * concern-queue deliver handler, then keeps a DB-driven recovery scan
 * running so due (or Redis-lost) deliveries are re-kicked. Provider calls
 * happen only inside the deliver handler, after all producer commits.
 */
@Injectable()
export class NotificationsWorkerLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly alerts: DlqGrowthAlert;
  private readonly logger = new Logger(NotificationsWorkerLifecycle.name);
  private scanTimer?: NodeJS.Timeout;
  private alertTimer?: NodeJS.Timeout;
  private scanActive?: Promise<void>;
  private alertActive?: Promise<void>;
  constructor(
    @Inject(PLATFORM_DATABASE) handle: DatabaseHandle,
    @Inject(PLATFORM_QUEUE) private readonly queue: DurableQueue,
    @Inject(PLATFORM_CONCERN_QUEUES) private readonly concerns: ConcernQueues,
    @Inject(NOTIFICATION_PIPELINE) private readonly pipeline: NotificationPipeline,
  ) {
    this.alerts = new DlqGrowthAlert(handle.db, pipeline);
  }
  onApplicationBootstrap(): void {
    this.queue.registerHandler(NOTIFICATIONS_CONSUMER, (tx, event) =>
      this.pipeline.consume(tx, event),
    );
    this.concerns.register('notifications', 'deliver', async (data) => {
      const deliveryId = (data as { deliveryId?: unknown }).deliveryId;
      if (typeof deliveryId !== 'string') throw new Error('INVALID_INPUT');
      await this.pipeline.deliverOnce(deliveryId);
    });
    this.scanTimer = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    this.scanTimer.unref();
    this.alertTimer = setInterval(() => void this.raiseAlerts(), ALERT_INTERVAL_MS);
    this.alertTimer.unref();
  }
  private scan(): Promise<void> {
    if (this.scanActive) return this.scanActive;
    this.scanActive = this.pipeline
      .enqueueDue(100)
      .then(() => undefined)
      .catch(() => this.logger.error('Notification recovery scan failed; it will retry'))
      .finally(() => {
        this.scanActive = undefined;
      });
    return this.scanActive;
  }
  private raiseAlerts(): Promise<void> {
    if (this.alertActive) return this.alertActive;
    this.alertActive = this.alerts
      .runOnce()
      .then(() => undefined)
      .catch(() => this.logger.error('Notification DLQ alert scan failed; it will retry'))
      .finally(() => {
        this.alertActive = undefined;
      });
    return this.alertActive;
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.alertTimer) clearInterval(this.alertTimer);
    await Promise.allSettled([this.scanActive, this.alertActive]);
  }
}
