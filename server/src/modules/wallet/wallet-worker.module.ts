import {
  Inject,
  Injectable,
  Module,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PLATFORM_QUEUE } from '../../platform/contracts/runtime.js';
import type { DurableQueue } from '../../platform/queue/queue.js';
import { WalletModule } from './wallet.module.js';
import { WalletEventConsumer, WalletExpiryService } from './infrastructure/wallet-effects.js';

/**
 * Worker-only wallet effects. The `wallet` outbox consumer credits top-ups and
 * settles refunds exactly once (processed_events plus ledger uniqueness); the
 * promo expiry sweep runs every minute. HTTP roles never register consumers.
 */
@Injectable()
export class WalletWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(
    private readonly consumer: WalletEventConsumer,
    private readonly expiry: WalletExpiryService,
    @Inject(PLATFORM_QUEUE) private readonly queue: DurableQueue,
  ) {}
  onApplicationBootstrap(): void {
    this.queue.registerHandler(WalletEventConsumer.CONSUMER, (tx, event) =>
      this.consumer.handle(tx, event),
    );
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = this.expiry
        .expirePromoLots()
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          this.active = undefined;
        });
    }, 60000);
    this.timer.unref();
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}

/** Wired by the composition root only for APP_ROLE all|worker. */
@Module({
  imports: [WalletModule],
  providers: [WalletWorker],
})
export class WalletWorkerModule {}
