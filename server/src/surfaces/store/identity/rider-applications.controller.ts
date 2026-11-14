import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiResponse } from '@nestjs/swagger';
import { IsBoolean, IsString, Length } from 'class-validator';
import {
  RIDER_APPLICATIONS,
  type RiderApplications,
} from '../../../modules/identity/contracts/rider-applications.js';
import {
  RIDER_DOCUMENTS,
  type RiderDocuments,
} from '../../../modules/identity/contracts/uploads.js';
import {
  RiderApplicationDto,
  RiderApplicationPageDto,
  UrlResponseDto,
} from '../../../modules/identity/contracts/swagger.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';

class ReviewDto {
  @ApiProperty() @IsBoolean() approved!: boolean;
  @ApiProperty({ maxLength: 500 }) @IsString() @Length(0, 500) reason!: string;
}

@Controller('v1/store')
@ApiBearerAuth()
@AuthPolicy({ audience: 'store', roles: ['STORE_MANAGER'] })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class StoreRiderApplicationsController {
  constructor(
    @Inject(RIDER_APPLICATIONS) private readonly applications: RiderApplications,
    @Inject(RIDER_DOCUMENTS) private readonly documents: RiderDocuments | null,
  ) {}

  @Get('rider-applications')
  @ApiOperation({ operationId: 'storeListRiderApplications' })
  @ApiResponse({ status: 200, type: RiderApplicationPageDto })
  list(
    @CurrentPrincipal() principal: Principal,
    @Query('storeId', ParseUUIDPipe) storeId: string,
    @Query('before') before?: string,
    @Query('status') status?: string,
  ) {
    return this.applications.listForStore(principal.userId, storeId, before, status);
  }

  @Get('rider-applications/:userId')
  @ApiOperation({ operationId: 'storeGetRiderApplication' })
  @ApiResponse({ status: 200, type: RiderApplicationDto })
  get(@CurrentPrincipal() principal: Principal, @Param('userId', ParseUUIDPipe) userId: string) {
    return this.applications.getForStore(principal.userId, userId);
  }

  @Get('rider-documents/:documentId/read-url')
  @ApiOperation({ operationId: 'storeReadRiderDocument' })
  @ApiResponse({ status: 200, type: UrlResponseDto })
  async read(
    @CurrentPrincipal() principal: Principal,
    @Param('documentId', ParseUUIDPipe) documentId: string,
  ) {
    if (!this.documents) throw new ServiceUnavailableException();
    return { url: await this.documents.reviewUrl(principal.userId, documentId) };
  }

  @Post('rider-documents/:documentId/review')
  @ApiOperation({ operationId: 'storeReviewRiderDocument' })
  @ApiResponse({ status: 201, description: 'Document reviewed' })
  async review(
    @CurrentPrincipal() principal: Principal,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() body: ReviewDto,
  ) {
    if (!this.documents) throw new ServiceUnavailableException();
    await this.documents.review(principal.userId, documentId, body.approved, body.reason);
    return { reviewed: true };
  }
}
