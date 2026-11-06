import {
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { CognitoIdentityAdmin } from '../../adapters/auth/cognito.js';
import { ResilientIdentityAdmin } from '../../adapters/auth/resilient.js';
import { LocalIdentityAdmin } from '../../adapters/auth/local-admin.js';
import { ConfigService } from '../../config/config.service.js';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { IDENTITY_ADMIN, type IdentityAdminPort } from './contracts/identity.js';
import { IdentityModule } from './identity.module.js';
import { IdentitySyncWorker } from './infrastructure/identity-sync-worker.js';
const SYNC_WORKER = Symbol('SYNC_WORKER');
@Injectable()
class IdentitySyncLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  constructor(@Inject(SYNC_WORKER) private readonly worker: IdentitySyncWorker) {}
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = this.worker
        .compensateOne()
        .then(() => this.worker.runOne())
        .then(
          () => undefined,
          () => undefined,
        )
        .finally(() => {
          this.active = undefined;
        });
    }, 1000);
    this.timer.unref();
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
@Module({
  imports: [IdentityModule],
  providers: [
    {
      provide: SYNC_WORKER,
      inject: [PLATFORM_DATABASE, ConfigService, IDENTITY_ADMIN],
      useFactory: (handle: DatabaseHandle, config: ConfigService, workforce: IdentityAdminPort) => {
        const customer =
          config.get('AUTH_PROVIDER') === 'local'
            ? new LocalIdentityAdmin(handle.db, 'CUSTOMER')
            : new ResilientIdentityAdmin(
                new CognitoIdentityAdmin(
                  new CognitoIdentityProviderClient({
                    region: config.get('AWS_REGION'),
                    maxAttempts: 1,
                  }),
                  config.get('COGNITO_CUSTOMER_POOL_ID'),
                  config.get('COGNITO_TIMEOUT_MS'),
                ),
                config.get('COGNITO_BREAKER_FAILURES'),
                config.get('COGNITO_BREAKER_COOLDOWN_MS'),
              );
        return new IdentitySyncWorker(handle.db, { CUSTOMER: customer, WORKFORCE: workforce });
      },
    },
    IdentitySyncLifecycle,
  ],
})
export class IdentitySyncWorkerModule {}
