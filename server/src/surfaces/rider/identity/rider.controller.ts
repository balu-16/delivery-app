import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Logger,
  NotFoundException,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiResponse } from '@nestjs/swagger';
import {
  ProblemDto,
  RiderResponseDto,
  RiderBootstrapResponseDto,
  RiderOnboardingDto,
  RiderOnboardingUpdatedDto,
  RiderOnboardingStoreDto,
  UploadTargetResponseDto,
} from '../../../modules/identity/contracts/swagger.js';
import { IsInt, IsString, IsUUID, Length, Min } from 'class-validator';
import type { FastifyRequest } from 'fastify';
import {
  RIDER_DOCUMENTS,
  type RiderDocuments,
} from '../../../modules/identity/contracts/uploads.js';
import { ConfigService } from '../../../config/config.service.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';

import {
  AuthPolicy,
  CurrentPrincipal,
  type AuthenticatedRequest,
} from '../../../modules/identity/contracts/http.js';
import {
  RIDER_APPLICATIONS,
  projectRiderApplication,
  type RiderApplications,
} from '../../../modules/identity/contracts/rider-applications.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import {
  RIDER_PROFILE_ONBOARDING,
  USER_PROFILES,
  type Principal,
  type RiderProfileOnboarding,
  type UserProfiles,
} from '../../../modules/identity/contracts/identity.js';
class UploadDto {
  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'application/pdf'] })
  @IsString()
  @Length(1, 100)
  contentType!: string;
  @ApiProperty({ minimum: 1, type: Number }) @IsInt() @Min(1) size!: number;
}
class DocumentDto {
  @ApiProperty({ minLength: 1, maxLength: 80 }) @IsString() @Length(1, 80) documentType!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() mediaId!: string;
}
class RiderProfileDto {
  @ApiProperty({ minLength: 1, maxLength: 40 }) @IsString() @Length(1, 40) vehicleType!: string;
  @ApiProperty({ minLength: 1, maxLength: 40 }) @IsString() @Length(1, 40) vehicleNo!: string;
}
class SelectStoreDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
}
@ApiBearerAuth()
@ApiResponse({ status: 400, type: ProblemDto, description: 'Invalid request' })
@ApiResponse({ status: 401, type: ProblemDto, description: 'Missing or invalid token' })
@ApiResponse({ status: 403, type: ProblemDto, description: 'Account or role not permitted' })
@ApiResponse({ status: 409, type: ProblemDto, description: 'Onboarding state conflict' })
@ApiResponse({ status: 503, type: ProblemDto, description: 'Private storage unavailable' })
@Controller('v1/rider')
@AuthPolicy({ audience: 'rider', allowPendingRider: true })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class RiderIdentityController {
  private readonly logger = new Logger(RiderIdentityController.name);
  constructor(
    @Inject(ConfigService) private readonly env: ConfigService,
    @Inject(USER_PROFILES) private readonly profiles: UserProfiles,
    @Inject(RIDER_PROFILE_ONBOARDING) private readonly onboarding: RiderProfileOnboarding,
    @Inject(RIDER_DOCUMENTS) private readonly documents: RiderDocuments | null,
    @Inject(RIDER_APPLICATIONS) private readonly applications: RiderApplications,
  ) {}
  @Post('auth/bootstrap')
  @ApiOperation({ operationId: 'riderBootstrap' })
  @ApiResponse({ status: 201, type: RiderBootstrapResponseDto })
  @AuthPolicy({ audience: 'rider', tokenUse: 'id', bootstrap: true })
  async bootstrap(@Req() request: AuthenticatedRequest & Pick<FastifyRequest, 'id'>) {
    try {
      return await this.applications.bootstrap(request.identity!);
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'INVALID_BOOTSTRAP_IDENTITY' || code === 'INVALID_EMAIL')
        throw new BadRequestException({ code });
      if (code === 'EMAIL_NOT_VERIFIED' || code === 'ACCOUNT_DISABLED' || code === 'ROLE_CONFLICT')
        throw new ForbiddenException({ code });
      if (code === 'RIDER_ENROLLMENT_REQUIRES_REVIEW') {
        this.logger.warn(`Rider enrollment identity conflict (request ${request.id})`);
        throw new ConflictException({ code });
      }
      throw error;
    }
  }
  @Get('onboarding')
  @ApiOperation({ operationId: 'riderGetOnboarding' })
  @ApiResponse({ status: 200, type: RiderOnboardingDto })
  async onboardingStatus(@CurrentPrincipal() principal: Principal) {
    return {
      ...projectRiderApplication(await this.applications.get(principal.userId)),
      maxDocumentBytes: this.env.get('PRIVATE_UPLOAD_MAX_BYTES'),
    };
  }
  @Get('onboarding/stores')
  @ApiOperation({ operationId: 'riderListOnboardingStores' })
  @ApiResponse({ status: 200, type: [RiderOnboardingStoreDto] })
  stores() {
    return this.applications.stores();
  }
  @Post('onboarding/store')
  @ApiOperation({ operationId: 'riderSelectOnboardingStore' })
  @ApiResponse({ status: 201, type: RiderOnboardingUpdatedDto })
  async selectStore(@CurrentPrincipal() principal: Principal, @Body() body: SelectStoreDto) {
    try {
      const application = projectRiderApplication(
        await this.applications.selectStore(principal.userId, body.storeId),
      );
      return { updated: true, application };
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'STORE_NOT_FOUND') throw new NotFoundException({ code });
      if (code === 'INVALID_INPUT') throw new BadRequestException({ code });
      if (code === 'RIDER_STATE_INVALID') throw new ConflictException({ code });
      if (code === 'FORBIDDEN') throw new ForbiddenException({ code });
      throw error;
    }
  }
  @Get('me') @ApiResponse({ status: 200, type: RiderResponseDto }) async me(
    @CurrentPrincipal() principal: Principal,
  ) {
    return { ...(await this.profiles.get(principal.userId)), riderStatus: principal.riderStatus };
  }
  @Post('onboarding/documents/upload-url')
  @ApiResponse({ status: 201, type: UploadTargetResponseDto })
  async uploadTarget(@CurrentPrincipal() principal: Principal, @Body() body: UploadDto) {
    if (!this.documents) throw new ServiceUnavailableException();
    try {
      return await this.documents.uploadTarget(principal.userId, body.contentType, body.size);
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'INVALID_MEDIA') throw new BadRequestException({ code });
      if (code === 'FORBIDDEN') throw new ForbiddenException({ code });
      throw error;
    }
  }
  @Post('onboarding/documents')
  @ApiResponse({ status: 201, type: RiderOnboardingUpdatedDto })
  @ApiResponse({ status: 404, type: ProblemDto, description: 'Media not found' })
  @ApiResponse({ status: 410, type: ProblemDto, description: 'Upload expired' })
  async registerDocument(@CurrentPrincipal() principal: Principal, @Body() body: DocumentDto) {
    if (!this.documents) throw new ServiceUnavailableException();
    try {
      const application = projectRiderApplication(
        await this.documents.registerDocument(principal.userId, body.documentType, body.mediaId),
      );
      return { updated: true, application };
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : '';
      if (['INVALID_DOCUMENT_TYPE', 'INVALID_INPUT'].includes(code))
        throw new BadRequestException({ code });
      if (code === 'MEDIA_NOT_FOUND') throw new NotFoundException({ code });
      if (code === 'RIDER_STATE_INVALID') throw new ConflictException({ code });
      if (code === 'FORBIDDEN') throw new ForbiddenException({ code });
      throw error;
    }
  }
  @Post('onboarding/profile')
  @ApiResponse({ status: 201, type: RiderOnboardingUpdatedDto })
  async profile(@CurrentPrincipal() principal: Principal, @Body() body: RiderProfileDto) {
    try {
      const application = projectRiderApplication(
        await this.onboarding.profile(principal.userId, body.vehicleType, body.vehicleNo),
      );
      return { updated: true, application };
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'FORBIDDEN') throw new ForbiddenException({ code });
      if (code === 'RIDER_STATE_INVALID') throw new ConflictException({ code });
      if (code === 'INVALID_RIDER_PROFILE') throw new BadRequestException({ code });
      throw error;
    }
  }
}
