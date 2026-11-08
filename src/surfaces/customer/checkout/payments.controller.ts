import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Inject,
  Headers,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
  HttpException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiHeader } from '@nestjs/swagger';
import { IsUUID, IsString, Length } from 'class-validator';
import {
  CHECKOUT_PAYMENTS,
  type CustomerPayments,
} from '../../../modules/checkout/contracts/customer-payments.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
class VerifyPaymentDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() attemptId!: string;
  @ApiProperty() @IsString() @Length(1, 100) gatewayOrderId!: string;
  @ApiProperty() @IsString() @Length(1, 100) gatewayPaymentId!: string;
  @ApiProperty() @IsString() @Length(1, 256) signature!: string;
}
@Controller('v1/customer/payments')
@ApiBearerAuth()
@UseGuards(IdentityGuard)
@AuthPolicy({ audience: 'customer', roles: ['CUSTOMER'] })
@UseInterceptors(DomainErrorInterceptor)
export class CustomerPaymentRecoveryController {
  constructor(@Inject(CHECKOUT_PAYMENTS) private readonly payments: CustomerPayments) {}
  @Get(':orderId')
  @ApiOperation({ operationId: 'customerPaymentStatus' })
  status(@CurrentPrincipal() p: Principal, @Param('orderId', new ParseUUIDPipe()) id: string) {
    return this.payments.status(p.userId, id);
  }
  @Post(':orderId/retry')
  @ApiOperation({ operationId: 'customerPaymentRetry' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  retry(
    @CurrentPrincipal() p: Principal,
    @Param('orderId', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length > 150) throw new HttpException('IDEMPOTENCY_KEY_REQUIRED', 400);
    return this.payments.retry(p.userId, id, key);
  }
  @Post(':orderId/verify')
  @ApiOperation({ operationId: 'customerPaymentVerify' })
  verify(
    @CurrentPrincipal() p: Principal,
    @Param('orderId', new ParseUUIDPipe()) id: string,
    @Body() body: VerifyPaymentDto,
  ) {
    return this.payments.verify(p.userId, id, body);
  }
}
