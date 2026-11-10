import { Module } from '@nestjs/common';
import { CartModule } from './cart.module.js';
import { CartRetentionWorker } from './cart-retention-worker.js';
/** Registered only in the worker role; sweeps carts idle beyond cartRetentionDays. */
@Module({ imports: [CartModule], providers: [CartRetentionWorker] })
export class CartWorkerModule {}
