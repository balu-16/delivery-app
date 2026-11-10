import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { uuidV7 } from '../common/ids/ids.js';
import { STORE_SIGNALS, type StoreSignals } from '../modules/stores/contracts/signals.js';

/** Database state is the durable schedule; any worker can safely retry each poll. */
@Injectable()
export class StoreSignalsScheduler implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(@Inject(STORE_SIGNALS) private readonly signals: StoreSignals) {}
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      this.tick();
    }, 60000);
    this.timer.unref();
    this.tick();
  }
  private tick(): void {
    if (this.running) return;
    this.running = this.signals
      .evaluateDue(uuidV7())
      .then(
        () => undefined,
        () => {
          process.stderr.write('{"level":"error","msg":"Store signal evaluation failed"}\n');
        },
      )
      .finally(() => {
        this.running = undefined;
      });
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
