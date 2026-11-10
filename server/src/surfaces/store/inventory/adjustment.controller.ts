import {
  Body,
  Controller,
  Headers,
  HttpException,
  Inject,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiCreatedResponse } from '@nestjs/swagger';
import { IsString, IsUUID, Length, Matches } from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  INVENTORY_MANUAL_ADJUSTMENT,
  type InventoryManualAdjustment,
} from '../../../modules/inventory/contracts/manual-adjustment.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  InventoryApiErrors,
  InventoryIdempotencyHeader,
  StockChangeView,
} from '../../../modules/inventory/contracts/swagger.js';
class AdjustmentDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() variantId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() batchId!: string;
  @ApiProperty({ pattern: '^-?[1-9][0-9]{0,18}$' }) @Matches(/^-?[1-9][0-9]{0,18}$/) delta!: string;
  @ApiProperty({ pattern: '^[1-9][0-9]{0,18}$' })
  @Matches(/^[1-9][0-9]{0,18}$/)
  expectedVersion!: string;
  @ApiProperty({ minLength: 1, maxLength: 500 }) @IsString() @Length(1, 500) reason!: string;
}
@Controller('v1/store/inventory')
@ApiBearerAuth()
@InventoryApiErrors()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'store', roles: ['STORE_MANAGER'] })
@UseGuards(IdentityGuard)
export class StoreInventoryAdjustmentController {
  constructor(
    @Inject(INVENTORY_MANUAL_ADJUSTMENT) private readonly adjustments: InventoryManualAdjustment,
  ) {}
  @Post('adjustments')
  @ApiOperation({ operationId: 'storeInventoryAdjust' })
  @InventoryIdempotencyHeader()
  @ApiCreatedResponse({ type: StockChangeView })
  async adjust(
    @CurrentPrincipal() p: Principal,
    @Body() d: AdjustmentDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return this.adjustments.adjust(p.userId, { ...d, reference: key });
  }
}
