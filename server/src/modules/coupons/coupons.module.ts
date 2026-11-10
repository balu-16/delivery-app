import type { Redis } from 'ioredis';
import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE, PLATFORM_REDIS } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { IDENTITY_ACCESS, type IdentityAccess } from '../identity/contracts/identity.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import {
  COUPONS,
  COUPON_ADMINISTRATION,
  COUPON_ATTEMPT_LIMITER,
  COUPON_REDEMPTIONS,
  FIRST_ORDER_CHECK,
  type FirstOrderCheck,
} from './contracts/coupons.js';
import { RedisCouponAttemptLimiter } from './infrastructure/coupon-attempt-limiter.js';
import { PostgresFirstOrderCheck } from './infrastructure/first-order-check.js';
import { PostgresCoupons } from './infrastructure/postgres-coupons.js';
import { PostgresCouponRedemptions } from './infrastructure/postgres-redemptions.js';
import { PostgresCouponAdministration } from './infrastructure/postgres-coupon-admin.js';
@Module({
  imports: [IdentityModule, AppConfigModule],
  providers: [
    {
      provide: FIRST_ORDER_CHECK,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => new PostgresFirstOrderCheck(db.db),
    },
    {
      provide: COUPONS,
      inject: [PLATFORM_DATABASE, FIRST_ORDER_CHECK],
      useFactory: (db: DatabaseHandle, firstOrder: FirstOrderCheck) =>
        new PostgresCoupons(db.db, firstOrder),
    },
    {
      provide: COUPON_REDEMPTIONS,
      inject: [PLATFORM_DATABASE, FIRST_ORDER_CHECK],
      useFactory: (db: DatabaseHandle, firstOrder: FirstOrderCheck) =>
        new PostgresCouponRedemptions(db.db, firstOrder),
    },
    {
      provide: COUPON_ADMINISTRATION,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS],
      useFactory: (db: DatabaseHandle, identity: IdentityAccess) =>
        new PostgresCouponAdministration(db.db, identity),
    },
    {
      provide: COUPON_ATTEMPT_LIMITER,
      inject: [PLATFORM_REDIS, APP_CONFIG],
      useFactory: (redis: Redis, config: AppConfig) => new RedisCouponAttemptLimiter(redis, config),
    },
  ],
  exports: [
    COUPONS,
    COUPON_REDEMPTIONS,
    COUPON_ADMINISTRATION,
    FIRST_ORDER_CHECK,
    COUPON_ATTEMPT_LIMITER,
  ],
})
export class CouponsModule {}
