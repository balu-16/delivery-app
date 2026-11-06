import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiOkResponse,
  ApiResponse,
} from '@nestjs/swagger';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  ExpiringPageView,
  InventoryApiErrors,
  InventoryIdempotencyHeader,
  StockPageView,
} from '../../../modules/inventory/contracts/swagger.js';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { APP_CONFIG, type AppConfig } from '../../../modules/app-config/contracts/config.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  INVENTORY_MANAGEMENT,
  type InventoryManagement,
} from '../../../modules/inventory/contracts/inventory.js';
class ReceiptDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() variantId!: string;
  @ApiProperty({ maxLength: 120 }) @IsString() @Length(1, 120) batchCode!: string;
  @ApiProperty({ pattern: '^[1-9][0-9]{0,18}$' }) @Matches(/^[1-9][0-9]{0,18}$/) quantity!: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsDateString() expiresAt?: string;
}
class ListDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
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
@Controller('v1/store/inventory')
@ApiBearerAuth()
@InventoryApiErrors()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'store', roles: ['PICKER', 'STORE_MANAGER'] })
@UseGuards(IdentityGuard)
export class StoreInventoryController {
  constructor(
    @Inject(INVENTORY_MANAGEMENT) private readonly inventory: InventoryManagement,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  @Get()
  @ApiOperation({ operationId: 'storeInventoryList' })
  @ApiOkResponse({ type: StockPageView })
  list(@CurrentPrincipal() p: Principal, @Query() q: ListDto) {
    return this.inventory.list(p.userId, q.storeId, q.search ?? '', q.cursor, q.limit);
  }
  @Get('low-stock')
  @ApiOperation({ operationId: 'storeInventoryLowStock' })
  @ApiOkResponse({ type: StockPageView })
  async lowStock(@CurrentPrincipal() p: Principal, @Query() q: ListDto) {
    const threshold = await this.config.get('catalogLowStockThreshold');
    return this.inventory.list(p.userId, q.storeId, q.search ?? '', q.cursor, q.limit, threshold);
  }
  @Get('expiring')
  @ApiOperation({ operationId: 'storeInventoryExpiring' })
  @ApiOkResponse({ type: ExpiringPageView })
  async expiring(@CurrentPrincipal() p: Principal, @Query() q: ListDto) {
    const days = await this.config.get('inventoryExpirySoonDays');
    return this.inventory.expiring(p.userId, q.storeId, days, q.cursor, q.limit);
  }
  @Post('receipts')
  @ApiOperation({ operationId: 'storeInventoryReceive' })
  @InventoryIdempotencyHeader()
  @ApiResponse({ status: 201, description: 'Receipt committed; empty response' })
  receipt(
    @CurrentPrincipal() p: Principal,
    @Body() d: ReceiptDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return this.inventory.receive(p.userId, { ...d, reference: key });
  }
}
