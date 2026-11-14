import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiResponse,
  ApiProduces,
} from '@nestjs/swagger';
import { IsBoolean, IsUUID } from 'class-validator';
import type { FastifyReply } from 'fastify';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  CATALOG_IMPORTS,
  type CatalogImports,
} from '../../../modules/catalog/contracts/imports.js';
class CreateImportDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() mediaId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty() @IsBoolean() dryRun!: boolean;
}
class ImportCreatedView {
  @ApiProperty({ format: 'uuid' }) id!: string;
}
class ImportErrorView {
  @ApiProperty() row!: number;
  @ApiProperty() code!: string;
}
class ImportView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    enum: ['QUEUED', 'VALIDATING', 'AWAITING_APPROVAL', 'APPLYING', 'COMPLETED', 'FAILED'],
  })
  status!: string;
  @ApiProperty() dryRun!: boolean;
  @ApiProperty() rowsTotal!: number;
  @ApiProperty() checkpoint!: number;
  @ApiProperty({ type: ImportErrorView, isArray: true }) errors!: ImportErrorView[];
  @ApiProperty({ type: String, nullable: true }) approvalId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
}
@ApiResponse({ status: 400, description: 'Invalid input' })
@ApiResponse({ status: 401, description: 'Authentication required' })
@ApiResponse({ status: 403, description: 'Insufficient role' })
@ApiResponse({ status: 404, description: 'Resource not found' })
@ApiResponse({ status: 503, description: 'Storage unavailable' })
@Controller('v1/admin/catalog/imports')
@ApiBearerAuth()
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class AdminCatalogImportController {
  constructor(@Inject(CATALOG_IMPORTS) private readonly imports: CatalogImports) {}
  @Post()
  @ApiOperation({ operationId: 'adminCreateCatalogImport' })
  @ApiCreatedResponse({ type: ImportCreatedView })
  create(@CurrentPrincipal() p: Principal, @Body() d: CreateImportDto) {
    return this.imports.create(p.userId, d.mediaId, d.storeId, d.dryRun);
  }
  @Get(':id')
  @ApiOperation({ operationId: 'adminGetCatalogImport' })
  @ApiOkResponse({ type: ImportView })
  get(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.imports.get(p.userId, id);
  }
  @Get(':id/report')
  @ApiOperation({ operationId: 'adminGetCatalogImportReport' })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async report(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() reply: FastifyReply,
  ) {
    const report = await this.imports.report(p.userId, id);
    return reply
      .type('text/csv')
      .header('content-disposition', 'attachment; filename="catalog-import-errors.csv"')
      .send(report);
  }
  @Post('approvals/:id/approve')
  @ApiOperation({ operationId: 'adminApproveCatalogImport' })
  approve(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.imports.approve(p.userId, id);
  }
}
