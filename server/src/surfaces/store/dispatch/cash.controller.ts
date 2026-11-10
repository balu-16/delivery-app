import {
  Controller,
  Post,
  Body,
  Headers,
  Inject,
  UseGuards,
  UseInterceptors,
  HttpException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiHeader } from '@nestjs/swagger';
import { IsUUID, Matches } from 'class-validator';
import { createHash } from 'node:crypto';
import { RIDER_CASH, type RiderCash } from '../../../modules/riders/contracts/riders.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
class DepositDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() riderId!: string;
  @ApiProperty() @Matches(/^[1-9]\d{0,17}$/) amountPaise!: string;
}
@Controller('v1/store/cod')
@ApiBearerAuth()
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'store', roles: ['STORE_MANAGER'] })
export class StoreCashController {
  constructor(@Inject(RIDER_CASH) private readonly cash: RiderCash) {}
  @Post('deposits')
  @ApiOperation({ operationId: 'storeCodDeposit' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  deposit(
    @CurrentPrincipal() p: Principal,
    @Body() body: DepositDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length > 150) throw new HttpException('IDEMPOTENCY_KEY_REQUIRED', 400);
    const reference = `cash-${createHash('sha256')
      .update(JSON.stringify([p.userId, body.storeId, body.riderId, key]))
      .digest('hex')
      .slice(0, 32)}`;
    return this.cash.recordDeposit({ ...body, actorId: p.userId, depositReference: reference });
  }
}
