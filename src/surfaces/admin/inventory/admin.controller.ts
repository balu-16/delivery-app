import { Controller, Get, Inject, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiOkResponse,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, IsString, MaxLength, Min, Max } from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  INVENTORY_MANAGEMENT,
  type InventoryManagement,
} from '../../../modules/inventory/contracts/inventory.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  InventoryApiErrors,
  StockLedgerPageView,
  StockReportView,
} from '../../../modules/inventory/contracts/swagger.js';
class LedgerQuery {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() variantId?: string;
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
@Controller('v1/admin/inventory')
@ApiBearerAuth()
@InventoryApiErrors()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'admin', roles: ['ADMIN', 'SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
export class AdminInventoryController {
  constructor(@Inject(INVENTORY_MANAGEMENT) private readonly inventory: InventoryManagement) {}
  @Get('report')
  @ApiOperation({ operationId: 'adminInventoryReport' })
  @ApiOkResponse({ type: StockReportView })
  async report(@CurrentPrincipal() p: Principal, @Query() q: LedgerQuery) {
    return this.inventory.report(p.userId, q.storeId, q.cursor, q.limit);
  }
  @Get('ledger')
  @ApiOperation({ operationId: 'adminInventoryLedger' })
  @ApiOkResponse({ type: StockLedgerPageView })
  async ledger(@CurrentPrincipal() p: Principal, @Query() q: LedgerQuery) {
    return this.inventory.ledger(p.userId, q.storeId, q.variantId, q.cursor, q.limit);
  }
}
