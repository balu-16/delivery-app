import { Module } from '@nestjs/common';
import { DispatchModule } from '../../../modules/dispatch/dispatch.module.js';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { StoreDeliveryReturnsController } from './returns.controller.js';
import { StoreCashController } from './cash.controller.js';
import { RidersModule } from '../../../modules/riders/riders.module.js';
@Module({
  imports: [IdentityModule, DispatchModule, RidersModule],
  controllers: [StoreDeliveryReturnsController, StoreCashController],
})
export class StoreDispatchSurfaceModule {}
