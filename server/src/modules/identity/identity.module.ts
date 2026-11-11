import { Module } from '@nestjs/common';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { ConfigService as RuntimeConfig } from '../../config/config.service.js';
import { PLATFORM_DATABASE } from '../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../platform/database/database.js';
import { createS3Client } from '../../adapters/storage/s3-client.js';
import { S3PrivateUploads } from '../../adapters/storage/s3-private.js';
import { LocalPrivateUploads } from '../../adapters/storage/local-private.js';
import { APP_CONFIG, type AppConfig } from '../app-config/contracts/config.js';
import { PRIVATE_UPLOADS, RIDER_DOCUMENTS, type PrivateUploadPort } from './contracts/uploads.js';
import { RiderOnboarding } from './infrastructure/rider-onboarding.js';
import { AppConfigModule } from '../app-config/app-config.module.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { APPROVAL_FACTORY, type ApprovalFactory } from '../compliance/contracts/approval.js';
import { IdentityAdminService } from './infrastructure/admin-service.js';
import { IdentityAdministrationService } from './infrastructure/identity-administration.js';
import { CognitoIdentityAdmin, CognitoTokenVerifier } from '../../adapters/auth/cognito.js';
import { ResilientIdentityAdmin } from '../../adapters/auth/resilient.js';
import { LocalIdentityAdmin } from '../../adapters/auth/local-admin.js';
import { LocalTokenAdapter } from '../../adapters/auth/local.js';
import {
  IDENTITY_ACCESS,
  IDENTITY_ADMIN,
  IDENTITY_ADMINISTRATION,
  IDENTITY_AUTHORIZER,
  TOKEN_VERIFIER,
  USER_PROFILES,
  WORKFORCE_PROVISIONER,
  RIDER_PROFILE_ONBOARDING,
  type IdentityAccess,
  type IdentityAdminPort,
} from './contracts/identity.js';
import { IdentityGuard } from './contracts/identity-guard.js';
import { IDENTITY_ROSTER } from './contracts/roster.js';
import { PostgresIdentityRoster } from './infrastructure/roster.js';
import { IdentityService } from './infrastructure/identity-service.js';
import { DatabaseIdentityAccess } from './infrastructure/identity-access.js';
import { DatabaseUserProfiles } from './infrastructure/user-profiles.js';
import { RiderProfileService } from './infrastructure/rider-profile.js';
import { WorkforceProvisioning } from './infrastructure/workforce-provisioning.js';
import { SharedWorkforceProvisioning } from './infrastructure/shared-workforce-provisioning.js';
import { ReferralsModule } from '../referrals/referrals.module.js';
import { REFERRALS, type Referrals } from '../referrals/contracts/referrals.js';

@Module({
  imports: [AppConfigModule, ComplianceModule, ReferralsModule],
  providers: [
    {
      provide: IDENTITY_ACCESS,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new DatabaseIdentityAccess(handle.db),
    },
    {
      provide: IDENTITY_AUTHORIZER,
      inject: [PLATFORM_DATABASE, IDENTITY_ACCESS, REFERRALS],
      useFactory: (handle: DatabaseHandle, access: IdentityAccess, referrals: Referrals) =>
        new IdentityService(handle.db, access, referrals),
    },
    {
      provide: USER_PROFILES,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new DatabaseUserProfiles(handle.db),
    },
    {
      provide: TOKEN_VERIFIER,
      inject: [PLATFORM_DATABASE, RuntimeConfig],
      useFactory: (handle: DatabaseHandle, config: RuntimeConfig) =>
        config.get('AUTH_PROVIDER') === 'local'
          ? new LocalTokenAdapter(config.get('LOCAL_JWT_SECRET'), handle.db)
          : new CognitoTokenVerifier({
              customerPoolId: config.get('COGNITO_CUSTOMER_POOL_ID'),
              customerClientId: config.get('COGNITO_CUSTOMER_CLIENT_ID'),
              workforcePoolId: config.get('COGNITO_WORKFORCE_POOL_ID'),
              riderClientId: config.get('COGNITO_RIDER_CLIENT_ID'),
              storeClientId: config.get('COGNITO_STORE_CLIENT_ID'),
              adminClientId: config.get('COGNITO_ADMIN_CLIENT_ID'),
              region: config.get('AWS_REGION'),
            }),
    },
    {
      provide: IDENTITY_ADMIN,
      inject: [PLATFORM_DATABASE, RuntimeConfig],
      useFactory: (handle: DatabaseHandle, config: RuntimeConfig) =>
        config.get('AUTH_PROVIDER') === 'local'
          ? new LocalIdentityAdmin(handle.db)
          : new ResilientIdentityAdmin(
              new CognitoIdentityAdmin(
                new CognitoIdentityProviderClient({
                  region: config.get('AWS_REGION'),
                  maxAttempts: 1,
                }),
                config.get('COGNITO_WORKFORCE_POOL_ID'),
                config.get('COGNITO_TIMEOUT_MS'),
              ),
              config.get('COGNITO_BREAKER_FAILURES'),
              config.get('COGNITO_BREAKER_COOLDOWN_MS'),
            ),
    },
    {
      provide: WORKFORCE_PROVISIONER,
      inject: [PLATFORM_DATABASE, IDENTITY_ADMIN, RuntimeConfig],
      useFactory: (handle: DatabaseHandle, provider: IdentityAdminPort, config: RuntimeConfig) =>
        config.get('AUTH_PROVIDER') === 'cognito' &&
        config.get('COGNITO_CUSTOMER_POOL_ID') === config.get('COGNITO_WORKFORCE_POOL_ID')
          ? new SharedWorkforceProvisioning(handle.db, provider)
          : new WorkforceProvisioning(handle.db, provider),
    },
    {
      provide: IDENTITY_ADMINISTRATION,
      inject: [PLATFORM_DATABASE, APPROVAL_FACTORY],
      useFactory: (handle: DatabaseHandle, factory: ApprovalFactory) =>
        new IdentityAdministrationService(new IdentityAdminService(handle.db), factory),
    },
    {
      provide: RIDER_PROFILE_ONBOARDING,
      inject: [PLATFORM_DATABASE, APP_CONFIG],
      useFactory: (handle: DatabaseHandle, config: AppConfig) =>
        new RiderProfileService(handle.db, config),
    },
    {
      provide: PRIVATE_UPLOADS,
      inject: [PLATFORM_DATABASE, RuntimeConfig],
      useFactory: (handle: DatabaseHandle, config: RuntimeConfig) =>
        config.get('STORAGE_PROVIDER') === 'local' && config.get('NODE_ENV') !== 'production'
          ? new LocalPrivateUploads(
              handle.db,
              config.get('LOCAL_JWT_SECRET'),
              config.get('LOCAL_PRIVATE_STORAGE_DIR'),
              config.get('PRIVATE_UPLOAD_MAX_BYTES'),
              config.get('PRIVATE_UPLOAD_URL_TTL_SECONDS'),
              config.get('PRIVATE_READ_URL_TTL_SECONDS'),
            )
          : new S3PrivateUploads(
              handle.db,
              createS3Client(config),
              config.get('S3_PRIVATE_BUCKET')!,
              config.get('PRIVATE_UPLOAD_MAX_BYTES'),
              config.get('PRIVATE_UPLOAD_URL_TTL_SECONDS'),
              config.get('PRIVATE_READ_URL_TTL_SECONDS'),
            ),
    },
    {
      provide: RIDER_DOCUMENTS,
      inject: [PLATFORM_DATABASE, PRIVATE_UPLOADS, APP_CONFIG],
      useFactory: (handle: DatabaseHandle, storage: PrivateUploadPort | null, config: AppConfig) =>
        storage ? new RiderOnboarding(handle.db, storage, config) : null,
    },
    {
      provide: IDENTITY_ROSTER,
      inject: [PLATFORM_DATABASE],
      useFactory: (handle: DatabaseHandle) => new PostgresIdentityRoster(handle.db),
    },
    IdentityGuard,
  ],
  exports: [
    IDENTITY_ADMINISTRATION,
    IDENTITY_ACCESS,
    IDENTITY_AUTHORIZER,
    IDENTITY_ROSTER,
    USER_PROFILES,
    AppConfigModule,
    TOKEN_VERIFIER,
    IDENTITY_ADMIN,
    WORKFORCE_PROVISIONER,
    RIDER_PROFILE_ONBOARDING,
    PRIVATE_UPLOADS,
    RIDER_DOCUMENTS,
    ReferralsModule,
    IdentityGuard,
  ],
})
export class IdentityModule {}

import { DevAuthController } from '../../surfaces/customer/identity/dev-auth.controller.js';
import { CustomerIdentityController } from '../../surfaces/customer/identity/customer.controller.js';
import { PrivateMediaController } from '../../surfaces/rider/identity/private-media.controller.js';
import { RiderIdentityController } from '../../surfaces/rider/identity/rider.controller.js';
import { StoreIdentityController } from '../../surfaces/store/identity/store.controller.js';
import { AdminIdentityController } from '../../surfaces/admin/identity/admin.controller.js';
@Module({ imports: [IdentityModule], controllers: [CustomerIdentityController, DevAuthController] })
export class CustomerIdentitySurfaceModule {}
@Module({ imports: [IdentityModule], controllers: [PrivateMediaController] })
export class PrivateMediaSurfaceModule {}
@Module({
  imports: [IdentityModule, PrivateMediaSurfaceModule],
  controllers: [RiderIdentityController],
})
export class RiderIdentitySurfaceModule {}
@Module({ imports: [IdentityModule], controllers: [StoreIdentityController] })
export class StoreIdentitySurfaceModule {}
@Module({
  imports: [IdentityModule, PrivateMediaSurfaceModule],
  controllers: [AdminIdentityController],
})
export class AdminIdentitySurfaceModule {}
