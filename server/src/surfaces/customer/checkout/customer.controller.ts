import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Patch,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { Json } from '../../../platform/database/database.js';
import { IdempotencyStore, hashRequest } from '../../../common/idempotency/idempotency.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { CHECKOUT, type CheckoutOperations } from '../../../modules/checkout/contracts/checkout.js';
import {
  ORDERS,
  ORDER_CODES,
  type OrderCodes,
  type OrderOperations,
} from '../../../modules/orders/contracts/orders.js';
import {
  INVOICING,
  type InvoicingOperations,
} from '../../../modules/invoicing/contracts/invoicing.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
export const CUSTOMER_CHECKOUT_IDEMPOTENCY = Symbol('CUSTOMER_CHECKOUT_IDEMPOTENCY');
class QuoteDto {
  @ApiProperty() @IsUUID() addressId!: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^(0|[1-9][0-9]{0,11})$/) tipPaise?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) couponCode?: string;
}
class PlaceDto {
  @ApiProperty() @IsUUID() quoteId!: string;
  @ApiProperty() @IsUUID() intentId!: string;
  @ApiProperty({ enum: ['GATEWAY', 'COD'] }) @IsIn(['GATEWAY', 'COD']) method!: 'GATEWAY' | 'COD';
}
class CancelDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(200) reason!: string;
}
class ChangeOrderAddressDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() addressId!: string;
}
@Controller('v1/customer')
@ApiBearerAuth()
@AuthPolicy({ audience: 'customer' })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class CustomerCheckoutController {
  @Patch('orders/:orderId/address')
  @ApiOperation({ operationId: 'customerOrderChangeAddress' })
  changeAddress(
    @CurrentPrincipal() p: Principal,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() body: ChangeOrderAddressDto,
  ) {
    return this.orders.changeAddress(id, p.userId, {
      addressId: body.addressId,
      addressSnapshot: {},
    });
  }
  @Post('orders/:orderId/reorder')
  @ApiOperation({ operationId: 'customerOrderReorder' })
  reorder(
    @CurrentPrincipal() p: Principal,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, `/v1/customer/orders/${id}/reorder`, {}, () =>
      this.orders.reorder(id, p.userId),
    );
  }
  constructor(
    @Inject(CHECKOUT) private readonly checkout: CheckoutOperations,
    @Inject(ORDERS) private readonly orders: OrderOperations,
    @Inject(ORDER_CODES) private readonly codes: OrderCodes,
    @Inject(INVOICING) private readonly invoices: InvoicingOperations,
    @Inject(CUSTOMER_CHECKOUT_IDEMPOTENCY) private readonly idem: IdempotencyStore,
  ) {}
  @Post('checkout/quote')
  @HttpCode(200)
  @ApiOperation({ operationId: 'customerCheckoutQuote' })
  quote(@CurrentPrincipal() p: Principal, @Body() body: QuoteDto) {
    return this.checkout.quote(p.userId, body);
  }
  @Post('checkout/place')
  @ApiOperation({ operationId: 'customerCheckoutPlace' })
  async place(
    @CurrentPrincipal() p: Principal,
    @Body() body: PlaceDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, '/v1/customer/checkout/place', body, async (operationId) =>
      this.checkout.place(p.userId, { ...body, idempotencyOperationId: operationId }),
    );
  }
  @Get('orders')
  @ApiOperation({ operationId: 'customerOrdersList' })
  list(@CurrentPrincipal() p: Principal, @Query('cursor') cursor?: string) {
    return this.orders.list(p.userId, 50, cursor);
  }
  @Get('orders/:orderId')
  @ApiOperation({ operationId: 'customerOrderGet' })
  async get(@CurrentPrincipal() p: Principal, @Param('orderId', ParseUUIDPipe) id: string) {
    const order = await this.orders.byId(id, { userId: p.userId });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    return order;
  }
  @Get('orders/:orderId/timeline')
  @ApiOperation({ operationId: 'customerOrderTimeline' })
  timeline(@CurrentPrincipal() p: Principal, @Param('orderId', ParseUUIDPipe) id: string) {
    return this.orders.timeline(id, { userId: p.userId });
  }
  @Get('orders/:orderId/invoice')
  @ApiOperation({ operationId: 'customerOrderInvoice' })
  invoice(@CurrentPrincipal() p: Principal, @Param('orderId', ParseUUIDPipe) id: string) {
    return this.invoices.invoiceForOrder(id, p.userId);
  }
  @Post('orders/:orderId/cancel')
  @HttpCode(200)
  @ApiOperation({ operationId: 'customerOrderCancel' })
  async cancel(
    @CurrentPrincipal() p: Principal,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() body: CancelDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!(await this.orders.byId(id, { userId: p.userId }))) throw new Error('ORDER_NOT_FOUND');
    return this.keyed(p, key, `/v1/customer/orders/${id}/cancel`, body, async () =>
      this.orders.cancel(id, { type: 'CUSTOMER', id: p.userId }, body.reason),
    );
  }
  private async keyed<T>(
    p: Principal,
    key: string | undefined,
    resource: string,
    body: unknown,
    work: (operationId: string) => Promise<T>,
  ): Promise<T> {
    if (!key || key.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    const claim = await this.idem.claim(
      { actor: p.userId, audience: 'customer', method: 'POST', resource, key },
      hashRequest(JSON.stringify(body)),
    );
    if (claim.kind === 'replay') return claim.body as T;
    if (claim.kind === 'in_progress') throw new HttpException({ code: 'REQUEST_IN_PROGRESS' }, 409);
    if (claim.kind !== 'claimed') throw new HttpException({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409);
    const result = await work(claim.owner.operationId);
    await this.idem.execute(claim.owner, async () => ({ status: 200, body: result as Json }));
    return result;
  }
}
