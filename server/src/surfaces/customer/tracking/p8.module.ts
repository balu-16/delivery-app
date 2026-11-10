import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { DispatchModule } from '../../../modules/dispatch/dispatch.module.js';
import { TrackingModule } from '../../../modules/tracking/tracking.module.js';
import { CustomerTrackingController } from './customer-tracking.controller.js';

/**
 * P8 customer tracking surface: ownership-checked tracking snapshots and the
 * D20 delivery-code retrieval. The dispatch module's realtime lifecycle
 * registers the /customer namespace on this role.
 */
@Module({
  imports: [IdentityModule, DispatchModule, TrackingModule],
  controllers: [CustomerTrackingController],
})
export class CustomerTrackingSurfaceModule {}
