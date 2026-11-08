import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  WALLET_ADJUSTMENTS,
  WALLET_VIEWS,
  type WalletAdjustments,
  type WalletBucket,
  type WalletLedgerPage,
  type WalletReason,
  type WalletViews,
} from '../../../modules/wallet/contracts/wallet.js';

class AdjustmentDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() userId!: string;
  @ApiProperty({ enum: ['cash', 'promo'] }) @IsIn(['cash', 'promo']) bucket!: WalletBucket;
  @ApiProperty({ enum: ['CREDIT', 'DEBIT'] }) @IsIn(['CREDIT', 'DEBIT']) direction!:
    'CREDIT' | 'DEBIT';
  @ApiProperty({ pattern: '^[0-9]+$', example: '10000' })
  @IsString()
  @Matches(/^[0-9]+$/)
  amountPaise!: string;
  @ApiProperty({ maxLength: 200 }) @IsString() @MaxLength(200) reason!: string;
}
class AdminLedgerQuery {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() userId?: string;
  @ApiPropertyOptional({ enum: ['cash', 'promo'] })
  @IsOptional()
  @IsIn(['cash', 'promo'])
  bucket?: WalletBucket;
  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsIn([
    'ORDER_PAYMENT',
    'ORDER_PAYMENT_REVERSAL',
    'TOPUP_CREDIT',
    'PROMO_GRANT',
    'PROMO_EXPIRY',
    'REFUND_CREDIT',
    'ADMIN_ADJUSTMENT',
  ])
  reason?: WalletReason;
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional({ maxLength: 4096 })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  cursor?: string;
}

/**
 * Administrative wallet operations (manifest rows POST-v1-admin-wallet-
 * adjustments and GET-v1-admin-wallet-ledger). Manual money moves are
 * maker-checker: an ADMIN requests, a different SUPER_ADMIN approves through
 * the shared approval executor, and the executed adjustment writes the
 * wallet ledger row plus an audit record exactly once.
 */
@Controller('v1/admin/wallet')
@ApiBearerAuth()
@AuthPolicy({ audience: 'admin', roles: ['ADMIN', 'SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class AdminWalletController {
  constructor(
    @Inject(WALLET_ADJUSTMENTS) private readonly adjustments: WalletAdjustments,
    @Inject(WALLET_VIEWS) private readonly views: WalletViews,
  ) {}
  @Post('adjustments')
  @ApiOperation({ operationId: 'adminWalletAdjustmentRequest' })
  @ApiOkResponse({ description: 'Approval request id for the checker' })
  async request(@CurrentPrincipal() p: Principal, @Body() dto: AdjustmentDto) {
    return { approvalId: await this.adjustments.request(p.userId, dto) };
  }
  @Post('adjustments/:id/approve')
  @AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
  @ApiOperation({ operationId: 'adminWalletAdjustmentApprove' })
  async approve(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    try {
      await this.adjustments.approve(p.userId, id);
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'APPROVAL_INVALID' || code === 'APPROVAL_POLICY_CHANGED' || code === 'FORBIDDEN')
        throw new HttpException(
          { code: code === 'FORBIDDEN' ? 'FORBIDDEN' : 'APPROVAL_INVALID' },
          code === 'FORBIDDEN' ? 403 : 409,
        );
      throw error;
    }
    return {};
  }
  @Get('ledger')
  @ApiOperation({ operationId: 'adminWalletLedger' })
  async ledger(@Query() q: AdminLedgerQuery): Promise<WalletLedgerPage> {
    return this.views.adminLedger(
      { userId: q.userId, bucket: q.bucket, reason: q.reason },
      q.limit ?? 50,
      q.cursor,
    );
  }
}
