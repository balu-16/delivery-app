import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { PLATFORM_DATABASE } from '../../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../../platform/database/database.js';
import { IdempotencyStore } from '../../../common/idempotency/idempotency.js';
import { WalletModule } from '../../../modules/wallet/wallet.module.js';
import { CustomerWalletController } from './wallet.controller.js';
import { WALLET_IDEMPOTENCY } from './wallet.tokens.js';

@Module({
  imports: [WalletModule, IdentityModule],
  controllers: [CustomerWalletController],
  providers: [
    {
      provide: WALLET_IDEMPOTENCY,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new IdempotencyStore(handle.db),
    },
  ],
})
export class CustomerWalletSurfaceModule {}
