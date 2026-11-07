import {
  Inject,
  Injectable,
  Module,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '../../config/config.service.js';
import type { Redis } from 'ioredis';
import {
  PLATFORM_REDIS,
  PLATFORM_DATABASE,
  PLATFORM_CONCERN_QUEUES,
} from '../../platform/contracts/runtime.js';
import type { ConcernQueues } from '../../platform/queue/concern-queues.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { IDENTITY_ACCESS, type IdentityAccess } from '../identity/contracts/identity.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { APPROVAL_FACTORY, type ApprovalFactory } from '../compliance/contracts/approval.js';
import { MediaModule } from '../media/media.module.js';
import { MEDIA_STORAGE, type StoragePort } from '../media/contracts/storage.js';
import { CATALOG_IMPORTS } from './contracts/imports.js';
import { ImportService } from './infrastructure/import-service.js';
import { CatalogImportDispatcher } from './infrastructure/import-dispatcher.js';
import { CatalogImportWorker } from './infrastructure/import-worker.js';
import { SEARCH_PORT } from './contracts/search.js';
import { CATALOG_ADMIN, CATALOG_QUERY } from './contracts/catalog.js';
import { CATALOG_LOOKUP } from './contracts/lookup.js';
import { PostgresCatalogAdmin } from './infrastructure/catalog-admin.js';
import { PostgresCatalogQuery } from './infrastructure/catalog-query.js';
import { PostgresCatalogLookup } from './infrastructure/lookup.js';
@Module({
  imports: [IdentityModule, AppConfigModule, ComplianceModule],
  providers: [
    {
      provide: CATALOG_LOOKUP,
      inject: [PLATFORM_DATABASE],
      useFactory: (db: DatabaseHandle) => new PostgresCatalogLookup(db.db),
    },
    {
      provide: CATALOG_ADMIN,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS, APP_CONFIG, APPROVAL_FACTORY],
      useFactory: (
        db: DatabaseHandle,
        identity: IdentityAccess,
        config: AppConfig,
        approvals: ApprovalFactory,
      ) => new PostgresCatalogAdmin(db.db, identity, config, approvals),
    },
    {
      provide: CATALOG_QUERY,
      inject: [PLATFORM_DATABASE, APP_CONFIG, ConfigService, PLATFORM_REDIS],
      useFactory: (db: DatabaseHandle, config: AppConfig, runtime: ConfigService, redis: Redis) =>
        new PostgresCatalogQuery(
          db.db,
          config,
          runtime.get('STORAGE_PROVIDER') === 's3' ? runtime.get('CDN_BASE_URL') : undefined,
          redis,
        ),
    },
    { provide: SEARCH_PORT, useExisting: CATALOG_QUERY },
  ],
  exports: [CATALOG_ADMIN, CATALOG_QUERY, CATALOG_LOOKUP, SEARCH_PORT],
})
export class CatalogModule {}

@Module({
  imports: [IdentityModule, AppConfigModule, ComplianceModule, MediaModule],
  providers: [
    {
      provide: CATALOG_IMPORTS,
      inject: [
        PLATFORM_DATABASE,
        IDENTITY_ACCESS,
        MEDIA_STORAGE,
        APP_CONFIG,
        APPROVAL_FACTORY,
        { token: PLATFORM_CONCERN_QUEUES, optional: true },
      ],
      useFactory: (
        db: DatabaseHandle,
        identity: IdentityAccess,
        storage: StoragePort,
        config: AppConfig,
        factory: ApprovalFactory,
        queue: ConcernQueues | undefined,
      ) => new ImportService(db.db, identity, storage, config, factory, queue),
    },
  ],
  exports: [CATALOG_IMPORTS],
})
export class CatalogImportsModule {}
const WORKER = Symbol('CATALOG_IMPORT_WORKER');
@Injectable()
class ImportLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly dispatcher: CatalogImportDispatcher;
  constructor(
    @Inject(WORKER) worker: CatalogImportWorker,
    @Inject(PLATFORM_DATABASE) db: DatabaseHandle,
    @Inject(PLATFORM_CONCERN_QUEUES) queue: ConcernQueues,
  ) {
    this.dispatcher = new CatalogImportDispatcher(db.db, queue, worker);
  }
  onApplicationBootstrap() {
    this.dispatcher.start();
  }
  async beforeApplicationShutdown() {
    await this.dispatcher.stop();
  }
}

@Module({
  imports: [IdentityModule, AppConfigModule, MediaModule, CatalogImportsModule],
  providers: [
    {
      provide: WORKER,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS, MEDIA_STORAGE, APP_CONFIG, CATALOG_IMPORTS],
      useFactory: (
        db: DatabaseHandle,
        identity: IdentityAccess,
        storage: StoragePort,
        config: AppConfig,
        imports: ImportService,
      ) => new CatalogImportWorker(db.db, identity, storage, config, imports),
    },
    ImportLifecycle,
  ],
})
export class CatalogImportWorkerModule {}
