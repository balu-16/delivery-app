import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { SupportModule } from '../../../modules/support/support.module.js';
import { RiderP11Controller } from './p11.controller.js';
@Module({ imports: [IdentityModule, SupportModule], controllers: [RiderP11Controller] })
export class RiderP11Module {}
