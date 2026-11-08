import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { ADDRESSES } from './contracts/tokens.js';
import { Addresses } from './application/addresses.js';
import { PostgresAddresses } from './infrastructure/postgres-addresses.js';
import { ServiceabilityModule } from '../serviceability/serviceability.module.js';
import { MAPS } from '../serviceability/contracts/tokens.js';
import type { MapsPort } from '../serviceability/contracts/maps.js';
import { SubscriptionObligationsModule } from '../subscriptions/subscriptions-obligations.module.js';
import {
  ADDRESS_SUBSCRIPTIONS,
  type AddressSubscriptions,
} from '../subscriptions/contracts/subscriptions.js';
@Module({
  imports: [AppConfigModule, ServiceabilityModule, SubscriptionObligationsModule],
  providers: [
    {
      provide: ADDRESSES,
      inject: [PLATFORM_DATABASE, APP_CONFIG, MAPS, ADDRESS_SUBSCRIPTIONS],
      useFactory: (
        db: DatabaseHandle,
        config: AppConfig,
        maps: MapsPort,
        subscriptions: AddressSubscriptions,
      ) =>
        new Addresses(
          new PostgresAddresses(db.db, subscriptions),
          () => config.get('addressMaxPerUser'),
          maps,
          () => config.get('addressPinMismatchMetres'),
        ),
    },
  ],
  exports: [ADDRESSES],
})
export class AddressesModule {}
