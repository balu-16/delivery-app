import {
  Body,
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
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { AppConfigModule } from '../../../modules/app-config/app-config.module.js';
import { MediaModule } from '../../../modules/media/media.module.js';
import { ReportDataModule } from '../../../modules/compliance/compliance-report-data.module.js';
import { ComplianceExportsModule } from '../../../modules/compliance/compliance-exports.module.js';
import {
  COMPLIANCE_EXPORTS,
  type ComplianceExports,
} from '../../../modules/compliance/contracts/exports.js';
import { ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import {
  ExportIdView,
  ExportJobView,
  ExportPageView,
  ExportUrlView,
  ReportPageView,
} from '../../../modules/compliance/contracts/swagger.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
const kinds = ['catalog', 'stock', 'financial', 'picking', 'rider', 'subscription', 'support'];
class ReportFiltersDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}
class ExportDto extends ReportFiltersDto {
  @ApiProperty({ enum: kinds }) @IsIn(kinds) kind!: string;
}
class PreviewDto extends ReportFiltersDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 512) cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
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
function key(value: string | undefined): string {
  if (!value) throw new HttpException({ code: 'IDEMPOTENCY_KEY_REQUIRED' }, 400);
  return value;
}
@Controller('v1/admin/reports')
@ApiBearerAuth()
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
export class AdminReportsController {
  constructor(@Inject(COMPLIANCE_EXPORTS) private readonly exports: ComplianceExports) {}
  @Post('exports')
  @ApiOperation({ operationId: 'adminReportExportCreate' })
  @ApiCreatedResponse({ type: ExportIdView })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async create(
    @CurrentPrincipal() p: Principal,
    @Body() body: ExportDto,
    @Headers('idempotency-key') id?: string,
  ) {
    return {
      id: await this.exports.create(
        p.userId,
        'ADMIN',
        body.kind,
        { storeId: body.storeId, from: body.from, to: body.to },
        key(id),
      ),
    };
  }
  @Get('exports')
  @ApiOperation({ operationId: 'adminReportExportsList' })
  @ApiOkResponse({ type: ExportPageView })
  list(@CurrentPrincipal() p: Principal, @Query() q: PageDto) {
    return this.exports.list(p.userId, 'ADMIN', q.cursor, q.limit ?? 50);
  }
  @Get('exports/:id')
  @ApiOperation({ operationId: 'adminReportExportDetail' })
  @ApiOkResponse({ type: ExportJobView })
  detail(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.exports.detail(p.userId, 'ADMIN', id);
  }
  @Get('exports/:id/download')
  @ApiOperation({ operationId: 'adminReportExportDownload' })
  @ApiOkResponse({ type: ExportUrlView })
  download(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.exports.download(p.userId, 'ADMIN', id);
  }
  @Get(':kind')
  @ApiOperation({ operationId: 'adminReportPreview' })
  @ApiOkResponse({ type: ReportPageView })
  preview(@Param('kind') kind: string, @Query() q: PreviewDto) {
    return this.exports.preview(kind, q.cursor, q.limit ?? 50, {
      storeId: q.storeId,
      from: q.from,
      to: q.to,
    });
  }
}
@Module({
  imports: [
    IdentityModule,
    ComplianceExportsModule.register([MediaModule, AppConfigModule, ReportDataModule]),
  ],
  controllers: [AdminReportsController],
})
export class AdminReportsSurfaceModule {}
