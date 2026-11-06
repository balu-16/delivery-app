import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { APPROVAL_FACTORY, type ApprovalAction } from './contracts/approval.js';
import { MakerChecker } from './infrastructure/maker-checker.js';
@Module({
  providers: [
    {
      provide: APPROVAL_FACTORY,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => ({
        create: (actions: Readonly<Record<string, ApprovalAction>>) =>
          new MakerChecker(db.db, actions),
      }),
    },
  ],
  exports: [APPROVAL_FACTORY],
})
export class ComplianceModule {}
