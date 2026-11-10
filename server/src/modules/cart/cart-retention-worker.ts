import { BeforeApplicationShutdown, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { CartCleanup } from './infrastructure/cart-cleanup.js';
/** Database rows remain authoritative; a lost sweep recovers on the next tick. */
@Injectable()
export class CartRetentionWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(private readonly cleanup: CartCleanup) {}
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => this.run(), 3600000);
    this.timer.unref();
  }
  private run(): void {
    if (this.active) return;
    this.active = (async () => {
      try {
        await this.cleanup.deleteIdleCarts();
      } catch {
        process.stderr.write('Cart retention sweep failed; it will retry\n');
      }
    })();
    void this.active.finally(() => {
      this.active = undefined;
    });
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
