import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { AGENT_PRIVACY } from './contracts/privacy.js';
import { PostgresAgentPrivacy } from './infrastructure/privacy.js';

@Module({
  providers: [
    {
      provide: AGENT_PRIVACY,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => new PostgresAgentPrivacy(db.db),
    },
  ],
  exports: [AGENT_PRIVACY],
})
export class AgentPrivacyModule {}
