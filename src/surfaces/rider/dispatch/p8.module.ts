import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { DispatchModule } from '../../../modules/dispatch/dispatch.module.js';
import { RidersModule } from '../../../modules/riders/riders.module.js';
import { TrackingModule } from '../../../modules/tracking/tracking.module.js';
import { RiderOffersController } from './rider-offers.controller.js';
import { RiderTasksController } from './rider-tasks.controller.js';
import { RiderOpsController } from '../ops/rider-ops.controller.js';

/**
 * P8 rider surface: offers, custody transitions, COD collection, status/
 * heartbeat/location ingest and earnings/cash reads. The dispatch module's
 * realtime lifecycle registers the /rider namespace on this role.
 */
@Module({
  imports: [IdentityModule, DispatchModule, RidersModule, TrackingModule],
  controllers: [RiderOffersController, RiderTasksController, RiderOpsController],
})
export class RiderDispatchSurfaceModule {}
