import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { SupportModule } from '../../../modules/support/support.module.js';
import { RatingsModule } from '../../../modules/ratings/ratings.module.js';
import { CustomerP11Controller } from './p11.controller.js';
@Module({
  imports: [IdentityModule, SupportModule, RatingsModule],
  controllers: [CustomerP11Controller],
})
export class CustomerP11Module {}
