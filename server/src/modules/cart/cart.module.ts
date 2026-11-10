import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { CouponsModule } from '../coupons/coupons.module.js';
import { COUPONS, type CouponValidation } from '../coupons/contracts/coupons.js';
import { CART_INTENTS } from './contracts/intent.js';
import { CART_PREVIEWS, CART_QUOTES } from './contracts/quote.js';
import { CART_SERVICE } from './contracts/cart.js';
import { PostgresCartService } from './infrastructure/postgres-carts.js';
import { PostgresQuotes, PostgresPreviews } from './infrastructure/postgres-quotes.js';
import { PostgresCartIntents } from './infrastructure/postgres-intents.js';
import { CartCleanup } from './infrastructure/cart-cleanup.js';
@Module({
  imports: [AppConfigModule, CouponsModule],
  providers: [
    {
      provide: CART_SERVICE,
      inject: [PLATFORM_DATABASE, APP_CONFIG, COUPONS],
      useFactory: (db: DatabaseHandle, config: AppConfig, coupons: CouponValidation) =>
        new PostgresCartService(db.db, config, coupons),
    },
    {
      provide: CART_PREVIEWS,
      inject: [PLATFORM_DATABASE, APP_CONFIG, COUPONS],
      useFactory: (db: DatabaseHandle, config: AppConfig, coupons: CouponValidation) =>
        new PostgresPreviews(db.db, config, coupons),
    },
    {
      provide: CART_QUOTES,
      inject: [PLATFORM_DATABASE, APP_CONFIG, COUPONS],
      useFactory: (db: DatabaseHandle, config: AppConfig, coupons: CouponValidation) =>
        new PostgresQuotes(db.db, config, coupons),
    },
    {
      provide: CART_INTENTS,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => new PostgresCartIntents(db.db),
    },
    {
      provide: CartCleanup,
      inject: [PLATFORM_DATABASE, APP_CONFIG],
      useFactory: (db: DatabaseHandle, config: AppConfig) => new CartCleanup(db.db, config),
    },
  ],
  exports: [CART_SERVICE, CART_PREVIEWS, CART_QUOTES, CART_INTENTS, CartCleanup],
})
export class CartModule {}
