import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE, PLATFORM_CONCERN_QUEUES } from '../../platform/contracts/runtime.js';
import type { ConcernQueues } from '../../platform/queue/concern-queues.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { ADMIN_COMPLIANCE_OPERATIONS, ADMIN_QUEUE_OPERATIONS } from './contracts/operations.js';
import { AdminComplianceOperations } from './infrastructure/admin-operations.js';
import { AdminQueueOperations } from './infrastructure/admin-queue-operations.js';
import { ComplianceModule } from './compliance.module.js';
import { APPROVAL_FACTORY, type ApprovalFactory } from './contracts/approval.js';
import { PRIVACY_OPERATIONS } from './contracts/privacy.js';
import { PrivacyRequests } from './infrastructure/privacy-requests.js';

@Module({
  imports: [ComplianceModule],
  providers: [
    {
      provide: ADMIN_COMPLIANCE_OPERATIONS,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => new AdminComplianceOperations(db.db),
    },
    {
      provide: PRIVACY_OPERATIONS,
      inject: [PLATFORM_DATABASE, APPROVAL_FACTORY],
      useFactory: (db: DatabaseHandle, approvals: ApprovalFactory) =>
        new PrivacyRequests(db.db, approvals),
    },
    {
      provide: ADMIN_QUEUE_OPERATIONS,
      inject: [PLATFORM_DATABASE, { token: PLATFORM_CONCERN_QUEUES, optional: true }],
      useFactory: (db: DatabaseHandle, queues?: ConcernQueues) =>
        new AdminQueueOperations(db.db, queues),
    },
  ],
  exports: [ADMIN_COMPLIANCE_OPERATIONS, PRIVACY_OPERATIONS, ADMIN_QUEUE_OPERATIONS],
})
export class ComplianceOperationsModule {}
