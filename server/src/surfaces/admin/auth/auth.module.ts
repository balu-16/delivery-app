import { Module } from '@nestjs/common';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { AdminAuthController } from './auth.controller.js';

/** Admin portal session routes (P14): provider auth + cookie session lifecycle. */
@Module({
  imports: [IdentityModule],
  controllers: [AdminAuthController],
})
export class AdminAuthSurfaceModule {}
