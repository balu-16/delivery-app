import {
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { MEDIA_STORAGE, type StoragePort } from './contracts/storage.js';
import { MediaModule } from './media.module.js';
import { MediaOrphanCleanup } from './infrastructure/orphan-cleanup.js';
const CLEANUP = Symbol('MEDIA_ORPHAN_CLEANUP');
@Injectable()
class CleanupLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private closing = false;
  constructor(@Inject(CLEANUP) private readonly cleanup: MediaOrphanCleanup) {}
  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), 30000);
    this.timer.unref();
    void this.tick();
  }
  private async tick() {
    if (this.active || this.closing) return;
    this.active = (async () => {
      try {
        for (let i = 0; i < 50 && !this.closing; i++) if (!(await this.cleanup.runOne())) break;
      } catch {
        /* retry on next scan */
      }
    })();
    try {
      await this.active;
    } finally {
      this.active = undefined;
    }
  }
  async beforeApplicationShutdown() {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
@Module({
  imports: [MediaModule],
  providers: [
    {
      provide: CLEANUP,
      inject: [PLATFORM_DATABASE, MEDIA_STORAGE],
      useFactory: (db: DatabaseHandle, storage: StoragePort) =>
        new MediaOrphanCleanup(db.db, storage),
    },
    CleanupLifecycle,
  ],
})
export class MediaWorkerModule {}
