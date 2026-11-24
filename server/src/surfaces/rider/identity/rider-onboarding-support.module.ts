import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { SupportModule } from '../../../modules/support/support.module.js';
import { SUPPORT } from '../../../modules/support/contracts/support.js';
import {
  RIDER_ONBOARDING_SUPPORT,
  RiderOnboardingSupport,
} from './rider-onboarding-support.service.js';
import { RiderOnboardingSupportController } from './rider-onboarding-support.controller.js';

@Module({
  imports: [IdentityModule, SupportModule],
  controllers: [RiderOnboardingSupportController],
  providers: [
    {
      provide: RIDER_ONBOARDING_SUPPORT,
      inject: [SUPPORT],
      useFactory: (support) => new RiderOnboardingSupport(support),
    },
  ],
  exports: [RIDER_ONBOARDING_SUPPORT],
})
export class RiderOnboardingSupportModule {}
