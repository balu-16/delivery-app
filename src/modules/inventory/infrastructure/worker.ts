import { BeforeApplicationShutdown, Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { InventoryExpiry } from './expiry.js';

/** Database rows remain authoritative and recover after worker restarts. */
@Injectable()
export class InventoryWorker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(private readonly expiry: InventoryExpiry) {}
  onApplicationBootstrap(): void {
    this.run();
    this.timer = setInterval(() => this.run(), 60000);
    this.timer.unref();
  }
  private run(): void {
    if (this.active) return;
    this.active = (async () => {
      await this.expiry.expireHolds();
      await this.expiry.writeOffExpired();
      await this.expiry.emitDueAlerts();
    })()
      .catch(() => {
        process.stderr.write('Inventory maintenance failed; it will retry\n');
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
