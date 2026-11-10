import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { PLATFORM_CONCERN_QUEUES } from '../../platform/contracts/runtime.js';
import type { ConcernQueues } from '../../platform/queue/concern-queues.js';
import { SubscriptionsModule } from './subscriptions.module.js';
import { SubscriptionGeneration } from './infrastructure/generation.js';

@Injectable()
class SubscriptionsWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private readonly logger = new Logger(SubscriptionsWorker.name);
  constructor(
    @Inject(PLATFORM_CONCERN_QUEUES) private readonly queues: ConcernQueues,
    private readonly generation: SubscriptionGeneration,
  ) {}
  async onApplicationBootstrap() {
    this.queues.register('subscriptions', 'generate', async () => {
      await this.generation.scanStores(200);
      await this.generation.forecast(100);
    });
    await this.queues.upsertScheduler(
      'subscriptions',
      'subscription-generation-recovery',
      'generate',
      {},
      { everyMs: 30000 },
    );
    this.timer = setInterval(() => void this.scan(), 30000);
    this.timer.unref();
    void this.scan();
  }
  private scan(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.generation
      .scanStores(100)
      .then(() => undefined)
      .catch(() => this.logger.error('Subscription recovery scan failed'))
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
  async beforeApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
@Module({ imports: [SubscriptionsModule], providers: [SubscriptionsWorker] })
export class SubscriptionsWorkerModule {}
