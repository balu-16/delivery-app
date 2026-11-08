import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { APPROVAL_FACTORY, type ApprovalFactory } from '../compliance/contracts/approval.js';
import { PAYOUTS } from './contracts/payouts.js';
import { PostgresPayouts } from './infrastructure/postgres-payouts.js';
@Module({
  imports: [ComplianceModule],
  providers: [
    {
      provide: PAYOUTS,
      inject: [PLATFORM_DATABASE, APPROVAL_FACTORY],
      useFactory: (handle: DatabaseHandle, factory: ApprovalFactory) =>
        new PostgresPayouts(handle.db, factory),
    },
  ],
  exports: [PAYOUTS],
})
export class PayoutsModule {}
