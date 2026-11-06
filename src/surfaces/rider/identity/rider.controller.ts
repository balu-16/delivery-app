import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiResponse } from '@nestjs/swagger';
import {
  ProblemDto,
  RiderResponseDto,
  UploadTargetResponseDto,
} from '../../../modules/identity/contracts/swagger.js';
import { IsInt, IsString, IsUUID, Length, Min } from 'class-validator';
import {
  RIDER_DOCUMENTS,
  type RiderDocuments,
} from '../../../modules/identity/contracts/uploads.js';

import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
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
@ApiBearerAuth()
@ApiResponse({ status: 400, type: ProblemDto, description: 'Invalid request' })
@ApiResponse({ status: 401, type: ProblemDto, description: 'Missing or invalid token' })
@ApiResponse({ status: 403, type: ProblemDto, description: 'Account or role not permitted' })
@ApiResponse({ status: 409, type: ProblemDto, description: 'Onboarding state conflict' })
@ApiResponse({ status: 503, type: ProblemDto, description: 'Private storage unavailable' })
@Controller('v1/rider')
@AuthPolicy({ audience: 'rider', allowPendingRider: true })
@UseGuards(IdentityGuard)
export class RiderIdentityController {
  constructor(
    @Inject(USER_PROFILES) private readonly profiles: UserProfiles,
    @Inject(RIDER_PROFILE_ONBOARDING) private readonly onboarding: RiderProfileOnboarding,
    @Inject(RIDER_DOCUMENTS) private readonly documents: RiderDocuments | null,
  ) {}
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
      if (error instanceof Error && error.message === 'INVALID_MEDIA')
        throw new BadRequestException();
      throw error;
    }
  }
  @Post('onboarding/documents')
  @ApiResponse({ status: 201, description: 'Document registered; empty response' })
  async registerDocument(
    @CurrentPrincipal() principal: Principal,
    @Body() body: DocumentDto,
  ): Promise<void> {
    if (!this.documents) throw new ServiceUnavailableException();
    try {
      await this.documents.registerDocument(principal.userId, body.documentType, body.mediaId);
    } catch (error: unknown) {
      if (
        error instanceof Error &&
        ['INVALID_DOCUMENT_TYPE', 'MEDIA_NOT_FOUND'].includes(error.message)
      )
        throw new BadRequestException();
      if (error instanceof Error && error.message === 'RIDER_STATE_INVALID')
        throw new ConflictException();
      if (error instanceof Error && error.message === 'FORBIDDEN') throw new ForbiddenException();
      throw error;
    }
  }
  @Post('onboarding/profile')
  @ApiResponse({ status: 201, description: 'Profile updated; empty response' })
  async profile(
    @CurrentPrincipal() principal: Principal,
    @Body() body: RiderProfileDto,
  ): Promise<void> {
    try {
      await this.onboarding.profile(principal.userId, body.vehicleType, body.vehicleNo);
    } catch (error: unknown) {
      if (error instanceof Error && error.message === 'FORBIDDEN') throw new ForbiddenException();
      if (error instanceof Error && error.message === 'RIDER_STATE_INVALID')
        throw new ConflictException();
      if (error instanceof Error && error.message === 'INVALID_RIDER_PROFILE')
        throw new BadRequestException();
      throw error;
    }
  }
}
