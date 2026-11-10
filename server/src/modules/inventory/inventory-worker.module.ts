import { Module } from '@nestjs/common';
import { InventoryModule } from './inventory.module.js';
import { InventoryWorker } from './infrastructure/worker.js';
@Module({ imports: [InventoryModule], providers: [InventoryWorker] })
export class InventoryWorkerModule {}
