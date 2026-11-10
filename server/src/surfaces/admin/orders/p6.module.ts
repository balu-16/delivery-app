import {
  Module,
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Inject,
  Headers,
  UseGuards,
  UseInterceptors,
  ParseUUIDPipe,
  HttpException,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiHeader,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  IsInt,
  IsIn,
  IsBoolean,
  IsISO8601,
  Length,
  Matches,
  Min,
  Max,
} from 'class-validator';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { OrdersModule } from '../../../modules/orders/orders.module.js';
import { PaymentsModule } from '../../../modules/payments/payments.module.js';
import {
  ORDERS,
  ORDER_CODES,
  type OrderCodes,
  type OrderOperations,
  type OrderStatus,
} from '../../../modules/orders/contracts/orders.js';
import {
  ORDER_ADMINISTRATION,
  type OrderAdministration,
} from '../../../modules/orders/contracts/administration.js';
import {
  PAYMENT_FINDINGS,
  PAYMENT_ORDERS,
  PAYMENT_REFUNDS,
  type PaymentFindings,
  type PaymentOrderOperations,
  type PaymentRefundOperations,
} from '../../../modules/payments/contracts/payments.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import { ORDER_HOLDS, type OrderHolds } from '../../../modules/orders/contracts/hold.js';
class PageDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 512) cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
class OrdersDto extends PageDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() userId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn([
    'PENDING_PAYMENT',
    'CONFIRMED',
    'PICKING',
    'PACKED',
    'OUT_FOR_DELIVERY',
    'DELIVERED',
    'EXPIRED',
    'CANCELLED',
    'DELIVERY_FAILED',
    'RETURNED_TO_STORE',
    'PAYMENT_FAILED',
  ])
  status?: OrderStatus;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() placedAfter?: string;
}
class ReasonDto {
  @ApiProperty() @IsString() @Length(1, 300) reason!: string;
}
class HoldDto extends ReasonDto {
  @ApiProperty() @IsBoolean() held!: boolean;
}
class RefundDto extends ReasonDto {
  @ApiProperty({ pattern: '^[1-9][0-9]{0,17}$' }) @Matches(/^[1-9]\d{0,17}$/) amountPaise!: string;
}
class RepairDto extends ReasonDto {
  @ApiProperty({ enum: ['CANCELLED', 'EXPIRED'] }) @IsIn(['CANCELLED', 'EXPIRED']) state!:
    'CANCELLED' | 'EXPIRED';
}
function key(value?: string) {
  if (!value || value.length > 150) throw new HttpException('IDEMPOTENCY_KEY_REQUIRED', 400);
  return value;
}
@Controller('v1/admin')
@ApiBearerAuth()
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'admin', roles: ['ADMIN', 'SUPER_ADMIN'] })
export class AdminCommerceController {
  constructor(
    @Inject(ORDERS) private readonly orders: OrderOperations,
    @Inject(ORDER_CODES) private readonly codes: OrderCodes,
    @Inject(ORDER_HOLDS) private readonly holds: OrderHolds,
    @Inject(ORDER_ADMINISTRATION) private readonly administration: OrderAdministration,
    @Inject(PAYMENT_ORDERS) private readonly payments: PaymentOrderOperations,
    @Inject(PAYMENT_REFUNDS) private readonly refunds: PaymentRefundOperations,
    @Inject(PAYMENT_FINDINGS) private readonly findings: PaymentFindings,
  ) {}
  @Get('orders') @ApiOperation({ operationId: 'adminOrdersList' }) list(@Query() q: OrdersDto) {
    return this.orders.adminList(q, q.limit ?? 50, q.cursor);
  }
  @Get('orders/:id') @ApiOperation({ operationId: 'adminOrderDetail' }) async detail(
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const order = await this.orders.byId(id);
    if (!order) throw new Error('ORDER_NOT_FOUND');
    return { ...order, hold: await this.holds.get(id) };
  }
  @Get('orders/:id/timeline') @ApiOperation({ operationId: 'adminOrderTimeline' }) timeline(
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.orders.timeline(id);
  }
  @Get('orders/:id/payments') @ApiOperation({ operationId: 'adminOrderPayments' }) async attempts(
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    if (!(await this.orders.byId(id))) throw new Error('ORDER_NOT_FOUND');
    return {
      attempts: await this.payments.listAttempts(id),
      refunds: await this.refunds.refundsForOrder(id),
    };
  }
  @Post('orders/:id/cancel') @ApiOperation({ operationId: 'adminOrderCancel' }) cancel(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReasonDto,
  ) {
    return this.orders.cancel(id, { type: 'ADMIN', id: p.userId }, body.reason);
  }
  @Post('orders/:id/hold')
  @ApiOperation({ operationId: 'adminOrderHold' })
  async hold(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: HoldDto,
  ) {
    await this.holds.set(id, p.userId, body.held, body.reason);
    return { held: body.held };
  }
  @Post('orders/:id/delivery-code/reset')
  @ApiOperation({ operationId: 'adminOrderDeliveryCodeReset' })
  async resetDeliveryCode(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: ReasonDto,
  ) {
    await this.codes.resetLock(id, p.userId, body.reason);
    return { state: 'RESET' };
  }
  @Post('orders/:id/refunds')
  @ApiOperation({ operationId: 'adminOrderRefundRequest' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async refund(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RefundDto,
    @Headers('idempotency-key') ref?: string,
  ) {
    return { approvalId: await this.administration.requestRefund(p.userId, id, body, key(ref)) };
  }
  @Post('orders/:id/force-state')
  @ApiOperation({ operationId: 'adminOrderRepairRequest' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async repair(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RepairDto,
    @Headers('idempotency-key') ref?: string,
  ) {
    return { approvalId: await this.administration.requestRepair(p.userId, id, body, key(ref)) };
  }
  @Post('order-approvals/:id/approve')
  @AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
  @ApiOperation({ operationId: 'adminOrderApprovalApprove' })
  async approve(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.administration.approve(p.userId, id);
    return { state: 'APPROVED' };
  }
  @Get('payments/reconciliation')
  @ApiOperation({ operationId: 'adminPaymentReconciliation' })
  reconciliation(@Query() q: PageDto) {
    return this.findings.list(q.limit ?? 50, q.cursor);
  }
}
@Module({
  imports: [IdentityModule, OrdersModule, PaymentsModule],
  controllers: [AdminCommerceController],
})
export class AdminCommerceSurfaceModule {}
