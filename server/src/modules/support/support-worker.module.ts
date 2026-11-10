import { Module } from '@nestjs/common';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { PayoutsModule } from '../payouts/payouts.module.js';
import { P11Worker } from './infrastructure/p11-worker.js';
@Module({ imports: [AppConfigModule, PayoutsModule], providers: [P11Worker] })
export class P11WorkerModule {}
