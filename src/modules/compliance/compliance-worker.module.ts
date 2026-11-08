import {
  Inject,
  Injectable,
  Logger,
  Module,
  type DynamicModule,
  type ModuleMetadata,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { PRIVATE_UPLOADS, type PrivateMediaErasure } from '../identity/contracts/uploads.js';
import {
  SUBSCRIPTION_OBLIGATIONS,
  type SubscriptionObligations,
} from '../subscriptions/contracts/subscriptions.js';
import { PAYOUTS, type Payouts } from '../payouts/contracts/payouts.js';
import { P11_PRIVACY, type P11Privacy } from '../support/contracts/privacy.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { MEDIA_STORAGE, type StoragePort } from '../media/contracts/storage.js';
import { REPORT_DATA, type ReportData } from './contracts/report-data.js';
import { TRACKING_PRIVACY, type TrackingPrivacy } from '../tracking/contracts/privacy.js';
import { FraudReviewScanner } from './infrastructure/fraud-review.js';
import { ComplianceRetention } from './infrastructure/retention.js';
import { ExportWorker } from './infrastructure/export-worker.js';
import { ErasureProcessor } from './infrastructure/erasure-processor.js';
const ERASURE_PROCESSOR = Symbol('ERASURE_PROCESSOR');
const EXPORT_WORKER = Symbol('EXPORT_WORKER');
const RETENTION = Symbol('RETENTION');
const FRAUD_SCANNER = Symbol('FRAUD_SCANNER');
@Injectable()
class ErasureLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(ErasureLifecycle.name);
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private lastFraudScan = 0;
  constructor(
    @Inject(ERASURE_PROCESSOR) private readonly processor: ErasureProcessor,
    @Inject(EXPORT_WORKER) private readonly exports: ExportWorker,
    @Inject(RETENTION) private readonly retention: ComplianceRetention,
    @Inject(FRAUD_SCANNER) private readonly fraud: FraudReviewScanner,
  ) {}
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.active) return;
      this.active = this.processor
        .runOne()
        .catch(() => {
          this.logger.error('Erasure processing failed; retry scheduled');
          return false;
        })
        .then(() =>
          this.exports.runOne().catch(() => {
            this.logger.error('Export processing failed; retry scheduled');
            return false;
          }),
        )
        .then(() =>
          this.exports.cleanup().catch(() => {
            this.logger.error('Export cleanup failed; retry scheduled');
          }),
        )
        .then(() =>
          this.retention.runOnce().catch(() => {
            this.logger.error('Retention processing failed; retry scheduled');
          }),
        )
        .then(async () => {
          if (Date.now() - this.lastFraudScan >= 300000) {
            this.lastFraudScan = Date.now();
            await this.fraud.runOnce().catch(() => {
              this.logger.error('Fraud scan failed; retry scheduled');
            });
          }
        })
        .finally(() => {
          this.active = undefined;
        });
    }, 1000);
    this.timer.unref();
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
}
@Module({})
export class ComplianceWorkerModule {
  static register(imports: ModuleMetadata['imports']): DynamicModule {
    return {
      module: ComplianceWorkerModule,
      imports,
      providers: [
        {
          provide: ERASURE_PROCESSOR,
          inject: [
            PLATFORM_DATABASE,
            SUBSCRIPTION_OBLIGATIONS,
            PAYOUTS,
            P11_PRIVACY,
            PRIVATE_UPLOADS,
            TRACKING_PRIVACY,
          ],
          useFactory: (
            db: DatabaseHandle,
            subscriptions: SubscriptionObligations,
            payouts: Payouts,
            support: P11Privacy,
            media: PrivateMediaErasure,
            tracking: TrackingPrivacy,
          ) => new ErasureProcessor(db.db, subscriptions, payouts, support, media, tracking),
        },
        {
          provide: EXPORT_WORKER,
          inject: [PLATFORM_DATABASE, MEDIA_STORAGE, APP_CONFIG, REPORT_DATA],
          useFactory: (
            db: DatabaseHandle,
            storage: StoragePort,
            config: AppConfig,
            reports: ReportData,
          ) => new ExportWorker(db.db, storage, config, reports),
        },
        {
          provide: RETENTION,
          inject: [PLATFORM_DATABASE, APP_CONFIG],
          useFactory: (db: DatabaseHandle, config: AppConfig) =>
            new ComplianceRetention(db.db, config),
        },
        {
          provide: FRAUD_SCANNER,
          inject: [PLATFORM_DATABASE, APP_CONFIG],
          useFactory: (db: DatabaseHandle, config: AppConfig) =>
            new FraudReviewScanner(db.db, config),
        },
        ErasureLifecycle,
      ],
    };
  }
}
