import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { WALLET_SPENDER, type WalletSpender } from '../wallet/contracts/wallet.js';
import { REFERRALS } from './contracts/referrals.js';
import { PostgresReferrals } from './infrastructure/postgres-referrals.js';
@Module({
  imports: [WalletModule, AppConfigModule],
  providers: [
    {
      provide: REFERRALS,
      inject: [PLATFORM_DATABASE, WALLET_SPENDER, APP_CONFIG],
      useFactory: (db: DatabaseHandle, wallet: WalletSpender, config: AppConfig) =>
        new PostgresReferrals(db.db, wallet, config),
    },
  ],
  exports: [REFERRALS],
})
export class ReferralsModule {}
