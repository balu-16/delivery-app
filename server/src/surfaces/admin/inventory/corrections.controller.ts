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
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  INVENTORY_ADMIN_CORRECTIONS,
  type InventoryAdminCorrections,
} from '../../../modules/inventory/contracts/admin-corrections.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
class BatchesQuery {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cursor?: string;
}
class CorrectionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() variantId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() batchId!: string;
  @ApiProperty({ pattern: '^[0-9]+$' }) @IsString() @Matches(/^\d+$/) counted!: string;
  @ApiProperty({ pattern: '^[1-9][0-9]*$' })
  @IsString()
  @Matches(/^[1-9]\d*$/)
  expectedVersion!: string;
  @ApiProperty({ minLength: 1, maxLength: 500 }) @IsString() @Length(1, 500) reason!: string;
}
class AdminStockBatchView {
  @ApiProperty({ format: 'uuid' }) batchId!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() productName!: string;
  @ApiProperty() variantName!: string;
  @ApiProperty() batchCode!: string;
  @ApiProperty() state!: string;
  @ApiProperty() onHand!: string;
  @ApiProperty() reserved!: string;
  @ApiProperty() version!: string;
}
class AdminStockBatchPageView {
  @ApiProperty({ type: [AdminStockBatchView] }) items!: AdminStockBatchView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
@Controller('v1/admin/inventory')
@ApiBearerAuth()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
export class AdminInventoryCorrectionsController {
  constructor(
    @Inject(INVENTORY_ADMIN_CORRECTIONS) private readonly corrections: InventoryAdminCorrections,
  ) {}
  @Get('batches')
  @ApiOkResponse({ type: AdminStockBatchPageView })
  @ApiOperation({ operationId: 'adminInventoryBatches' })
  batches(@CurrentPrincipal() p: Principal, @Query() q: BatchesQuery) {
    return this.corrections.batches(p.userId, q.storeId, q.cursor);
  }
  @Post('corrections')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ operationId: 'adminInventoryCorrectCount' })
  correct(
    @CurrentPrincipal() p: Principal,
    @Body() body: CorrectionDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || !/^[\x21-\x7e]{1,150}$/.test(key))
      throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return this.corrections.correct(p.userId, { ...body, reference: key });
  }
}
