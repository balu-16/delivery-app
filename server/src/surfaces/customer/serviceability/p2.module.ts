import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { AddressesModule } from '../../../modules/addresses/addresses.module.js';
import { ServiceabilityModule } from '../../../modules/serviceability/serviceability.module.js';
import { CustomerServiceabilityController } from './customer.controller.js';
import { AppConfigModule } from '../../../modules/app-config/app-config.module.js';
@Module({
  imports: [IdentityModule, AddressesModule, ServiceabilityModule, AppConfigModule],
  controllers: [CustomerServiceabilityController],
})
export class CustomerPlacesSurfaceModule {}
