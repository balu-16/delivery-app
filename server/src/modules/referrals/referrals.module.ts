import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { WALLET_SPENDER, type WalletSpender } from '../wallet/contracts/wallet.js';
import { REFERRALS } from './contracts/referrals.js';
import { PostgresReferrals } from './infrastructure/postgres-referrals.js';
@Module({
  imports: [WalletModule],
  providers: [
    {
      provide: REFERRALS,
      inject: [PLATFORM_DATABASE, WALLET_SPENDER],
      useFactory: (db: DatabaseHandle, wallet: WalletSpender) =>
        new PostgresReferrals(db.db, wallet),
    },
  ],
  exports: [REFERRALS],
})
export class ReferralsModule {}
