import {
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { AppConfigModule } from '../../../modules/app-config/app-config.module.js';
import { MediaModule } from '../../../modules/media/media.module.js';
import { ReportDataModule } from '../../../modules/compliance/compliance-report-data.module.js';
import { ComplianceExportsModule } from '../../../modules/compliance/compliance-exports.module.js';
import {
  COMPLIANCE_EXPORTS,
  type ComplianceExports,
} from '../../../modules/compliance/contracts/exports.js';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { ComplianceOperationsModule } from '../../../modules/compliance/compliance-operations.module.js';
import {
  PRIVACY_OPERATIONS,
  type PrivacyOperations,
} from '../../../modules/compliance/contracts/privacy.js';
import { ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import {
  ExportIdView,
  ExportJobView,
  ExportPageView,
  ExportUrlView,
  ErasureView,
} from '../../../modules/compliance/contracts/swagger.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
class PageDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
@Controller('v1/customer/me')
@ApiBearerAuth()
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'customer', roles: ['CUSTOMER'] })
export class CustomerPrivacyController {
  constructor(
    @Inject(PRIVACY_OPERATIONS) private readonly privacy: PrivacyOperations,
    @Inject(COMPLIANCE_EXPORTS) private readonly exports: ComplianceExports,
  ) {}
  @Post('data-exports')
  @ApiOperation({ operationId: 'customerDataExportCreate' })
  @ApiCreatedResponse({ type: ExportIdView })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(@CurrentPrincipal() p: Principal, @Headers('idempotency-key') key?: string) {
    if (!key) throw new HttpException({ code: 'IDEMPOTENCY_KEY_REQUIRED' }, 400);
    return { id: await this.exports.create(p.userId, 'CUSTOMER', 'personal', {}, key) };
  }
  @Get('data-exports')
  @ApiOperation({ operationId: 'customerDataExportsList' })
  @ApiOkResponse({ type: ExportPageView })
  list(@CurrentPrincipal() p: Principal, @Query() q: PageDto) {
    return this.exports.list(p.userId, 'CUSTOMER', q.cursor, q.limit ?? 50);
  }
  @Get('data-exports/:id')
  @ApiOperation({ operationId: 'customerDataExportDetail' })
  @ApiOkResponse({ type: ExportJobView })
  detail(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.exports.detail(p.userId, 'CUSTOMER', id);
  }
  @Get('data-exports/:id/download')
  @ApiOperation({ operationId: 'customerDataExportDownload' })
  @ApiOkResponse({ type: ExportUrlView })
  download(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.exports.download(p.userId, 'CUSTOMER', id);
  }
  @Get('erasure')
  @ApiOperation({ operationId: 'customerErasureStatus' })
  @ApiOkResponse({ type: ErasureView })
  status(@CurrentPrincipal() p: Principal) {
    return this.privacy.statusForCustomer(p.userId);
  }
}
@Module({
  imports: [
    IdentityModule,
    ComplianceOperationsModule,
    ComplianceExportsModule.register([MediaModule, AppConfigModule, ReportDataModule]),
  ],
  controllers: [CustomerPrivacyController],
})
export class CustomerPrivacySurfaceModule {}
