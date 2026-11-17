import { Module } from '@nestjs/common';
import { ConfigService } from '../../config/config.service.js';
import { PLATFORM_DATABASE, PLATFORM_REDIS } from '../../platform/contracts/runtime.js';
import type { Redis } from 'ioredis';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { ADMIN_CONFIG, type AdminConfig } from '../app-config/contracts/config.js';
import { IdentityModule } from '../identity/identity.module.js';
import { IDENTITY_AUTHORIZER, type IdentityAuthorizer } from '../identity/contracts/identity.js';
import { AGENT_OPERATIONS } from './contracts/agent.js';
import { AgentConfiguration } from './infrastructure/config.js';
import { AgentThreads } from './infrastructure/threads.js';
import { CustomerAgentService } from './infrastructure/agent-service.js';
import { AgentRuntime } from './infrastructure/runtime.js';
import { AgentRuns } from './infrastructure/runs.js';
import { AddressesModule } from '../addresses/addresses.module.js';
import { ADDRESSES } from '../addresses/contracts/tokens.js';
import type { AddressOperations } from '../addresses/contracts/addresses.js';
import { CartModule } from '../cart/cart.module.js';
import { CART_SERVICE, type CartService } from '../cart/contracts/cart.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CATALOG_QUERY, type CatalogQuery } from '../catalog/contracts/catalog.js';
import { OrdersModule } from '../orders/orders.module.js';
import { ORDERS, type OrderOperations } from '../orders/contracts/orders.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { WALLET_VIEWS, type WalletViews } from '../wallet/contracts/wallet.js';
import { SupportModule } from '../support/support.module.js';
import { SUPPORT, type Support } from '../support/contracts/support.js';
import { AgentPrivacyModule } from './agent-privacy.module.js';
import { AGENT_PRIVACY, type AgentPrivacy } from './contracts/privacy.js';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { CHECKOUT, type CheckoutOperations } from '../checkout/contracts/checkout.js';

@Module({
  imports: [
    AppConfigModule,
    IdentityModule,
    AddressesModule,
    CartModule,
    CatalogModule,
    OrdersModule,
    WalletModule,
    SupportModule,
    AgentPrivacyModule,
    CheckoutModule,
  ],
  providers: [
    {
      provide: AGENT_OPERATIONS,
      inject: [
        ConfigService,
        ADMIN_CONFIG,
        IDENTITY_AUTHORIZER,
        PLATFORM_DATABASE,
        PLATFORM_REDIS,
        ADDRESSES,
        CART_SERVICE,
        CATALOG_QUERY,
        ORDERS,
        WALLET_VIEWS,
        SUPPORT,
        AGENT_PRIVACY,
        CHECKOUT,
      ],
      useFactory: (
        runtime: ConfigService,
        config: AdminConfig,
        identity: IdentityAuthorizer,
        handle: DatabaseHandle,
        redis: Redis,
        addresses: AddressOperations,
        cart: CartService,
        catalog: CatalogQuery,
        orders: OrderOperations,
        wallet: WalletViews,
        support: Support,
        privacy: AgentPrivacy,
        checkout: CheckoutOperations,
      ) => {
        const threads = new AgentThreads(handle.db);
        const graph = new AgentRuntime(runtime, config, redis, new AgentRuns(handle.db), threads, {
          db: handle.db,
          addresses,
          cart,
          catalog,
          orders,
          wallet,
          support,
          checkout,
        });
        return new CustomerAgentService(
          new AgentConfiguration(runtime, config),
          identity,
          threads,
          graph,
          privacy,
        );
      },
    },
  ],
  exports: [AGENT_OPERATIONS],
})
export class AgentModule {}
