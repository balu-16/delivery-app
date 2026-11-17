import {
  Inject,
  Injectable,
  Logger,
  Module,
  type BeforeApplicationShutdown,
  type DynamicModule,
  type ModuleMetadata,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { AddressesModule } from '../addresses/addresses.module.js';
import type { AddressOperations } from '../addresses/contracts/addresses.js';
import { ADDRESSES } from '../addresses/contracts/tokens.js';
import { CartModule } from '../cart/cart.module.js';
import { CART_SERVICE, type CartService } from '../cart/contracts/cart.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CATALOG_QUERY, type CatalogQuery } from '../catalog/contracts/catalog.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ORDERS, type OrderOperations } from '../orders/contracts/orders.js';
import { AgentNudges } from './infrastructure/nudges.js';

const AGENT_NUDGES = Symbol('AGENT_NUDGES');
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Worker lifecycle: runs the reorder nudge sweep on a fixed interval. The
 * sweep itself is bounded (global flag, per-user weekly budget, 50 users per
 * pass) and failures are logged and retried on the next tick.
 */
@Injectable()
class NudgeSweepLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(NudgeSweepLifecycle.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  constructor(@Inject(AGENT_NUDGES) private readonly nudges: AgentNudges) {}
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }
  private sweep(): Promise<void> {
    if (this.active) return this.active;
    this.active = this.nudges
      .runSweep(new Date())
      .then(() => undefined)
      .catch(() => this.logger.error('Reorder nudge sweep failed; it will retry'))
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}

/**
 * Worker-only composition: provides AgentNudges (the preference write used by
 * the agent tools and the scheduled sweep) and the sweep lifecycle. Wired by
 * the composition root for APP_ROLE worker/all (see app-roles/roles.ts).
 */
@Module({})
export class AgentNudgesModule {
  static register(imports: ModuleMetadata['imports']): DynamicModule {
    return {
      module: AgentNudgesModule,
      imports: [
        ...(imports ?? []),
        AppConfigModule,
        AddressesModule,
        CartModule,
        CatalogModule,
        OrdersModule,
      ],
      providers: [
        {
          provide: AGENT_NUDGES,
          inject: [PLATFORM_DATABASE, ORDERS, CART_SERVICE, CATALOG_QUERY, ADDRESSES, APP_CONFIG],
          useFactory: (
            handle: DatabaseHandle,
            orders: OrderOperations,
            cart: CartService,
            catalog: CatalogQuery,
            addresses: AddressOperations,
            config: AppConfig,
          ) => new AgentNudges(handle.db, orders, cart, catalog, addresses, config),
        },
        NudgeSweepLifecycle,
      ],
      exports: [AGENT_NUDGES],
    };
  }
}
