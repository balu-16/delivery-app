import { Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { ConfigService } from '../../config/config.service.js';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { IDENTITY_ACCESS, type IdentityAccess } from '../identity/contracts/identity.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { CATALOG_MEDIA, MEDIA_STORAGE, type StoragePort } from './contracts/storage.js';
import { CatalogMediaService } from './infrastructure/catalog-media.js';
import { LocalStorage } from './infrastructure/local-storage.js';
import { S3Storage } from './infrastructure/s3-storage.js';
@Module({
  imports: [IdentityModule, AppConfigModule],
  providers: [
    {
      provide: MEDIA_STORAGE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StoragePort =>
        config.get('STORAGE_PROVIDER') === 'local'
          ? new LocalStorage(
              config.get('LOCAL_CATALOG_STORAGE_DIR'),
              config.get('LOCAL_JWT_SECRET'),
            )
          : new S3Storage(
              new S3Client({
                region: config.get('AWS_REGION'),
                ...(config.get('S3_ENDPOINT')
                  ? { endpoint: config.get('S3_ENDPOINT'), forcePathStyle: true }
                  : {}),
              }),
              config.get('S3_MEDIA_BUCKET')!,
              config.get('S3_PRIVATE_BUCKET')!,
            ),
    },
    {
      provide: CATALOG_MEDIA,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS, MEDIA_STORAGE, APP_CONFIG, ConfigService],
      useFactory: (
        db: DatabaseHandle,
        identity: IdentityAccess,
        storage: StoragePort,
        config: AppConfig,
        runtime: ConfigService,
      ) =>
        new CatalogMediaService(
          db.db,
          identity,
          storage,
          config,
          runtime.get('PRIVATE_UPLOAD_URL_TTL_SECONDS'),
        ),
    },
  ],
  exports: [CATALOG_MEDIA, MEDIA_STORAGE],
})
export class MediaModule {}
