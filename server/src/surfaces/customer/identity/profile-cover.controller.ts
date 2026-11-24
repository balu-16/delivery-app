import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Post,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
} from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  PROFILE_COVER_MAX_BYTES,
  PROFILE_COVER_PRESETS,
  PROFILE_COVERS,
  type CoverPreset,
  type CoverSelection,
  type ProfileCovers,
} from '../../../modules/identity/contracts/profile-covers.js';
import {
  ProblemDto,
  UploadTargetResponseDto,
} from '../../../modules/identity/contracts/swagger.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';

const coverKinds = ['default', 'preset', 'photo'] as const;

class CoverSelectionDto {
  @ApiProperty({ enum: coverKinds }) @IsIn(coverKinds) kind!: CoverSelection['kind'];
  @ApiPropertyOptional({ enum: PROFILE_COVER_PRESETS })
  @IsOptional()
  @IsIn(PROFILE_COVER_PRESETS)
  presetId?: CoverPreset;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() mediaId?: string;
  @ApiProperty({ pattern: '^(0|[1-9][0-9]{0,18})$' })
  @IsString()
  @Matches(/^(0|[1-9][0-9]{0,18})$/)
  expectedVersion!: string;
}

class CoverUploadDto {
  @ApiProperty({ minimum: 1, maximum: PROFILE_COVER_MAX_BYTES })
  @IsInt()
  @Min(1)
  @Max(PROFILE_COVER_MAX_BYTES)
  size!: number;
}

class ProfileCoverView {
  @ApiProperty({ enum: coverKinds }) kind!: CoverSelection['kind'];
  @ApiPropertyOptional({ enum: PROFILE_COVER_PRESETS }) presetId?: CoverPreset;
  @ApiPropertyOptional({ format: 'uuid' }) mediaId?: string;
  @ApiProperty() version!: string;
  @ApiProperty({ type: String, nullable: true }) imageUrl!: string | null;
}

function selectionOf(body: CoverSelectionDto): CoverSelection {
  if (body.kind === 'default' && body.mediaId == null && body.presetId == null)
    return { kind: 'default' };
  if (body.kind === 'preset' && body.presetId && body.mediaId == null)
    return { kind: 'preset', presetId: body.presetId };
  if (body.kind === 'photo' && body.mediaId && body.presetId == null)
    return { kind: 'photo', mediaId: body.mediaId };
  throw new BadRequestException({ code: 'INVALID_INPUT' });
}

@Controller('v1/customer/me/cover')
@ApiBearerAuth()
@ApiResponse({ status: 401, type: ProblemDto })
@ApiResponse({ status: 403, type: ProblemDto })
@AuthPolicy({ audience: 'customer', roles: ['CUSTOMER'] })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class CustomerProfileCoverController {
  constructor(@Inject(PROFILE_COVERS) private readonly covers: ProfileCovers) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ operationId: 'customerGetProfileCover' })
  @ApiOkResponse({ type: ProfileCoverView })
  get(@CurrentPrincipal() principal: Principal) {
    return this.covers.get(principal.userId);
  }

  @Put()
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ operationId: 'customerSetProfileCover' })
  @ApiOkResponse({ type: ProfileCoverView })
  @ApiResponse({ status: 400, type: ProblemDto })
  @ApiResponse({ status: 404, type: ProblemDto })
  @ApiResponse({ status: 409, type: ProblemDto })
  update(@CurrentPrincipal() principal: Principal, @Body() body: CoverSelectionDto) {
    return this.covers.update(principal.userId, selectionOf(body), body.expectedVersion);
  }

  @Post('upload-target')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ operationId: 'customerProfileCoverUploadTarget' })
  @ApiCreatedResponse({ type: UploadTargetResponseDto })
  @ApiResponse({ status: 400, type: ProblemDto })
  uploadTarget(@CurrentPrincipal() principal: Principal, @Body() body: CoverUploadDto) {
    return this.covers.uploadTarget(principal.userId, body.size);
  }
}
