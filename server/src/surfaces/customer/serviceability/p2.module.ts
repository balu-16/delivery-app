import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { AddressesModule } from '../../../modules/addresses/addresses.module.js';
import { ServiceabilityModule } from '../../../modules/serviceability/serviceability.module.js';
import { CustomerServiceabilityController } from './customer.controller.js';
@Module({
  imports: [IdentityModule, AddressesModule, ServiceabilityModule],
  controllers: [CustomerServiceabilityController],
})
export class CustomerPlacesSurfaceModule {}
