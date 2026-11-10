import { Module, type DynamicModule, type ModuleMetadata } from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { MEDIA_STORAGE, type StoragePort } from '../media/contracts/storage.js';
import { COMPLIANCE_EXPORTS } from './contracts/exports.js';
import { REPORT_DATA, type ReportData } from './contracts/report-data.js';
import { ExportService } from './infrastructure/export-service.js';
@Module({})
export class ComplianceExportsModule {
  static register(imports: ModuleMetadata['imports']): DynamicModule {
    return {
      module: ComplianceExportsModule,
      imports,
      providers: [
        {
          provide: COMPLIANCE_EXPORTS,
          inject: [PLATFORM_DATABASE, MEDIA_STORAGE, APP_CONFIG, REPORT_DATA],
          useFactory: (
            db: DatabaseHandle,
            storage: StoragePort,
            config: AppConfig,
            reports: ReportData,
          ) => new ExportService(db.db, storage, config, reports),
        },
      ],
      exports: [COMPLIANCE_EXPORTS],
    };
  }
}
