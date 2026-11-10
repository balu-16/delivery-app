import {
  Body,
  Controller,
  Headers,
  HttpException,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiCreatedResponse,
  ApiResponse,
} from '@nestjs/swagger';
import { IsString, IsUUID, Length, Matches } from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  INVENTORY_ADJUSTMENTS,
  type InventoryAdjustments,
} from '../../../modules/inventory/contracts/adjustments.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  InventoryApiErrors,
  InventoryIdempotencyHeader,
  StockChangeView,
} from '../../../modules/inventory/contracts/swagger.js';
class CountDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() variantId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() batchId!: string;
  @ApiProperty({ pattern: '^(0|[1-9][0-9]{0,18})$' })
  @Matches(/^(0|[1-9][0-9]{0,18})$/)
  counted!: string;
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
export class StoreInventoryCountController {
  constructor(@Inject(INVENTORY_ADJUSTMENTS) private readonly adjustments: InventoryAdjustments) {}
  @Post('cycle-counts')
  @ApiOperation({ operationId: 'storeInventoryCount' })
  @InventoryIdempotencyHeader()
  @ApiCreatedResponse({ type: StockChangeView })
  count(
    @CurrentPrincipal() p: Principal,
    @Body() d: CountDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return this.adjustments.count(p.userId, { ...d, reference: key });
  }
  @Post('approvals/:id/approve')
  @ApiOperation({ operationId: 'storeInventoryApproveCount' })
  @InventoryIdempotencyHeader()
  @ApiResponse({ status: 201, description: 'Approval executed or replayed; empty response' })
  approve(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return this.adjustments.approve(p.userId, id, key);
  }
}
