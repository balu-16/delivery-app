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
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiResponse } from '@nestjs/swagger';
import { IsIn, IsString, IsUUID, Length } from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  INVENTORY_QUALITY,
  type InventoryQuality,
} from '../../../modules/inventory/contracts/quality.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  InventoryApiErrors,
  InventoryIdempotencyHeader,
} from '../../../modules/inventory/contracts/swagger.js';
class QualityDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() variantId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() batchId!: string;
  @ApiProperty({ enum: ['QUARANTINED', 'DAMAGED'] }) @IsIn(['QUARANTINED', 'DAMAGED']) state!:
    'QUARANTINED' | 'DAMAGED';
  @ApiProperty({ minLength: 1, maxLength: 500 }) @IsString() @Length(1, 500) reason!: string;
}
@Controller('v1/store/inventory')
@ApiBearerAuth()
@InventoryApiErrors()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'store', roles: ['STORE_MANAGER'] })
@UseGuards(IdentityGuard)
export class StoreInventoryQualityController {
  constructor(@Inject(INVENTORY_QUALITY) private readonly quality: InventoryQuality) {}
  @Post('quality')
  @ApiOperation({ operationId: 'storeInventoryQuality' })
  @InventoryIdempotencyHeader()
  @ApiResponse({ status: 201, description: 'Batch quality changed; empty response' })
  async state(
    @CurrentPrincipal() p: Principal,
    @Body() d: QualityDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return this.quality.setState(p.userId, { ...d, reference: key });
  }
}
