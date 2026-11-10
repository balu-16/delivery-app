import {
  Body,
  Controller,
  Headers,
  HttpException,
  Inject,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  HandoverResultView,
  PackResultView,
  PickingApiErrors,
  PickIdempotencyHeader,
} from '../../../modules/picking/contracts/swagger.js';
import {
  HANDOVER_CODES,
  type HandoverCodes,
  PICK_PACKING,
  type PickPacking,
} from '../../../modules/picking/contracts/packing.js';
import {
  INVENTORY_RETURNS,
  type InventoryReturns,
} from '../../../modules/inventory/contracts/returns.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';

class PackDto {
  @ApiProperty({ pattern: '^[1-9][0-9]{0,2}$' }) @Matches(/^[1-9][0-9]{0,2}$/) bags!: string;
  @ApiProperty({ maxLength: 64 }) @IsString() @Length(1, 64) sealCode!: string;
  @ApiProperty() @IsBoolean() coldChain!: boolean;
}
class HandoverDto {
  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @Length(1, 20)
  handoverCode?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() override?: boolean;
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}
class QcDto {
  @ApiProperty({ enum: ['APPROVE', 'REJECT'] }) @IsIn(['APPROVE', 'REJECT']) result!:
    'APPROVE' | 'REJECT';
  @ApiProperty({ maxLength: 300 }) @IsString() @Length(1, 300) reason!: string;
}

function key(header?: string): string {
  if (!header || header.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
  return header;
}

@Controller('v1/store')
@ApiBearerAuth()
@PickingApiErrors()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'store', roles: ['PICKER', 'STORE_MANAGER'] })
@UseGuards(IdentityGuard)
export class StoreOrderFulfillmentController {
  constructor(
    @Inject(PICK_PACKING) private readonly packing: PickPacking,
    @Inject(HANDOVER_CODES) private readonly handoverCodes: HandoverCodes,
    @Inject(INVENTORY_RETURNS) private readonly returns: InventoryReturns,
  ) {}
  @Post('orders/:id/pack')
  @ApiOperation({ operationId: 'storeOrderPack' })
  @PickIdempotencyHeader()
  @ApiOkResponse({ type: PackResultView })
  pack(
    @CurrentPrincipal() p: Principal,
    @Param('id') orderId: string,
    @Body() d: PackDto,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.packing.pack(p.userId, orderId, d, key(keyHeader));
  }
  @Post('orders/:id/handover')
  @ApiOperation({ operationId: 'storeOrderHandover' })
  @ApiOkResponse({ type: HandoverResultView })
  handover(@CurrentPrincipal() p: Principal, @Param('id') orderId: string, @Body() d: HandoverDto) {
    return this.handoverCodes.verify(p.userId, {
      orderId,
      code: d.handoverCode,
      override: d.override,
      reason: d.reason,
    });
  }
  @Post('returns/:id/qc')
  @ApiOperation({ operationId: 'storeReturnQc' })
  qc(@CurrentPrincipal() p: Principal, @Param('id') returnId: string, @Body() d: QcDto) {
    return this.returns.inspectReturn(p.userId, returnId, d.result, d.reason);
  }
}
