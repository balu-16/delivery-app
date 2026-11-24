import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { PLATFORM_CONCERN_QUEUES } from '../../platform/contracts/runtime.js';
import type { ConcernQueues } from '../../platform/queue/concern-queues.js';
import { SubscriptionsModule } from './subscriptions.module.js';
import { SubscriptionGeneration } from './infrastructure/generation.js';
import { subscriptionsRetired } from './retirement.js';

const generationScheduler = 'subscription-generation-recovery';

@Injectable()
class SubscriptionsWorker
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown
{
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private readonly logger = new Logger(SubscriptionsWorker.name);
  constructor(
    @Inject(PLATFORM_CONCERN_QUEUES)
    private readonly queues: Pick<
      ConcernQueues,
      'register' | 'upsertScheduler' | 'disableScheduler'
    >,
    private readonly generation: SubscriptionGeneration,
  ) {}
  async onModuleInit(): Promise<void> {
    if (subscriptionsRetired())
      await this.queues.disableScheduler('subscriptions', generationScheduler);
  }
  async onApplicationBootstrap() {
    // Already-queued jobs still drain through the retirement reconciliation.
    this.queues.register('subscriptions', 'generate', async () => {
      await this.generation.scanStores(200);
      await this.generation.forecast(100);
    });
    if (subscriptionsRetired()) {
      await this.generation.scanStores(100);
      return;
    }
    await this.queues.upsertScheduler(
      'subscriptions',
      generationScheduler,
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
