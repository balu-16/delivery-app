import { Module } from '@nestjs/common';
import { WalletModule } from '../../../modules/wallet/wallet.module.js';
import { AdminWalletController } from './admin.controller.js';
import { IdentityModule } from '../../../modules/identity/identity.module.js';

/** Admin wallet surface: maker-checker adjustments and the ledger viewer. */
@Module({
  imports: [WalletModule, IdentityModule],
  controllers: [AdminWalletController],
})
export class AdminWalletSurfaceModule {}
