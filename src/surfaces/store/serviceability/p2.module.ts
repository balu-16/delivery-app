import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { StoresModule } from '../../../modules/stores/stores.module.js';
import { StoreStatusController } from './store.controller.js';
@Module({ imports: [IdentityModule, StoresModule], controllers: [StoreStatusController] })
export class StoreStatusSurfaceModule {}
