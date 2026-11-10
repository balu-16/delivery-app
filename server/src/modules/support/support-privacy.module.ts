import { Module } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { P11_PRIVACY } from './contracts/privacy.js';
import { PostgresP11Privacy } from './infrastructure/privacy.js';
@Module({
  providers: [
    {
      provide: P11_PRIVACY,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresP11Privacy(handle.db),
    },
  ],
  exports: [P11_PRIVACY],
})
export class P11PrivacyModule {}
