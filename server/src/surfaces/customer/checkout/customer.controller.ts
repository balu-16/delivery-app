import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Patch,
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
import { IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength, MinLength } from 'class-validator';
import type { Json, TransactionContext } from '../../../platform/database/database.js';
import { HttpMetrics } from '../../../platform/metrics/http-metrics.js';
import {
  IdempotencyStore,
  hashCanonical,
  hashRequest,
  type IdempotencyOwner,
} from '../../../common/idempotency/idempotency.js';
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
class QuoteIssueView {
  @ApiProperty() code!: string;
  @ApiPropertyOptional({ format: 'uuid' }) variantId?: string;
  @ApiPropertyOptional() detail?: string;
}
class QuoteLineView {
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty({ format: 'uuid' }) storeId!: string;
  @ApiProperty() quantity!: string;
  @ApiProperty() unitPricePaise!: string;
  @ApiProperty() mrpPaise!: string;
  @ApiProperty() lineSubtotalPaise!: string;
  @ApiProperty() discountPaise!: string;
  @ApiProperty() taxRateBps!: number;
  @ApiProperty() taxPaise!: string;
  @ApiProperty() lineTotalPaise!: string;
}
class QuoteFeeView {
  @ApiProperty({ enum: ['DELIVERY', 'HANDLING', 'SMALL_CART', 'SURGE', 'TIP'] }) kind!: string;
  @ApiProperty() amountPaise!: string;
  @ApiProperty() taxPaise!: string;
  @ApiProperty({ enum: ['CGST_SGST', 'IGST'], nullable: true }) taxSplit!: string | null;
}
class QuoteWalletView {
  @ApiProperty() promoPaise!: string;
  @ApiProperty() cashPaise!: string;
}
class QuoteSnapshotView {
  @ApiProperty({ format: 'uuid' }) quoteId!: string;
  @ApiProperty({ format: 'uuid' }) cartId!: string;
  @ApiProperty() cartVersion!: number;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ format: 'uuid' }) storeId!: string;
  @ApiProperty({ format: 'uuid' }) addressId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) referralClaimId!: string | null;
  @ApiProperty({ enum: ['ACTIVE', 'CONSUMED', 'EXPIRED', 'SUPERSEDED'] }) status!: string;
  @ApiProperty({ type: QuoteLineView, isArray: true }) lines!: QuoteLineView[];
  @ApiProperty({ type: QuoteFeeView, isArray: true }) fees!: QuoteFeeView[];
  @ApiProperty({ type: String, nullable: true }) couponCode!: string | null;
  @ApiProperty() couponDiscountPaise!: string;
  @ApiProperty() subtotalPaise!: string;
  @ApiProperty() discountPaise!: string;
  @ApiProperty() feeTotalPaise!: string;
  @ApiProperty() taxTotalPaise!: string;
  @ApiProperty() tipPaise!: string;
  @ApiProperty() totalPaise!: string;
  @ApiProperty({ type: QuoteWalletView, nullable: true }) wallet!: QuoteWalletView | null;
  @ApiProperty() amountDuePaise!: string;
  @ApiProperty() priceVersion!: string;
  @ApiProperty() configVersion!: string;
  @ApiProperty({ type: String, nullable: true }) couponFingerprint!: string | null;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: QuoteIssueView, isArray: true }) issues!: QuoteIssueView[];
}
class QuoteCartLineView {
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() productName!: string;
  @ApiProperty() variantName!: string;
  @ApiProperty({ type: String, nullable: true }) image!: string | null;
  @ApiProperty() quantity!: string;
  @ApiProperty() unitPricePaise!: string;
  @ApiProperty({ type: String, nullable: true }) currentUnitPricePaise!: string | null;
  @ApiProperty() mrpPaise!: string;
  @ApiProperty() lineSubtotalPaise!: string;
}
class QuoteCartView {
  @ApiProperty({ format: 'uuid' }) cartId!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) storeId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) addressId!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ type: String, nullable: true }) couponCode!: string | null;
  @ApiProperty({ type: QuoteCartLineView, isArray: true }) lines!: QuoteCartLineView[];
  @ApiProperty({ type: QuoteIssueView, isArray: true }) issues!: QuoteIssueView[];
}
class CheckoutQuoteView {
  @ApiProperty({ type: QuoteSnapshotView }) quote!: QuoteSnapshotView;
  @ApiProperty({ format: 'uuid' }) intentId!: string;
  @ApiProperty() intentExpiresAt!: string;
  @ApiProperty() codAvailable!: boolean;
  @ApiProperty({ type: QuoteCartView }) cart!: QuoteCartView;
}
class PlacementStatusOrderView {
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty() orderNumber!: string;
  @ApiProperty() status!: string;
  @ApiProperty() paymentStatus!: string;
}
class PlacementStatusView {
  @ApiProperty({ enum: ['ORDER_FOUND', 'REJECTED', 'PROCESSING', 'UNKNOWN'] })
  state!: 'ORDER_FOUND' | 'REJECTED' | 'PROCESSING' | 'UNKNOWN';
  @ApiPropertyOptional({ type: PlacementStatusOrderView }) order?: PlacementStatusOrderView;
  @ApiPropertyOptional({ description: 'Terminal rejection code; present only for REJECTED.' })
  code?: string;
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
    return this.keyed(p, key, `/v1/customer/orders/${id}/reorder`, {}, (_operationId, tx) =>
      this.orders.reorder(id, p.userId, { tx }),
    );
  }
  constructor(
    @Inject(CHECKOUT) private readonly checkout: CheckoutOperations,
    @Inject(ORDERS) private readonly orders: OrderOperations,
    @Inject(ORDER_CODES) private readonly codes: OrderCodes,
    @Inject(INVOICING) private readonly invoices: InvoicingOperations,
    @Inject(CUSTOMER_CHECKOUT_IDEMPOTENCY) private readonly idem: IdempotencyStore,
    @Optional() private readonly metrics?: HttpMetrics,
  ) {}
  @Post('checkout/quote')
  @HttpCode(200)
  @ApiOperation({ operationId: 'customerCheckoutQuote' })
  @ApiOkResponse({ type: CheckoutQuoteView })
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
    return this.keyed(
      p,
      key,
      '/v1/customer/checkout/place',
      body,
      async (operationId, _tx, owner) =>
        this.checkout.place(p.userId, { ...body, idempotencyOperationId: operationId }, owner),
      true,
      async (owner, _operationId, error) =>
        this.checkout.settleFailedPlacement(p.userId, owner, { intentId: body.intentId }, error),
    );
  }
  @Get('checkout/placement-status')
  @Header('Cache-Control', 'no-store')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOkResponse({ type: PlacementStatusView })
  @ApiOperation({ operationId: 'customerCheckoutPlacementStatus' })
  placementStatus(@CurrentPrincipal() p: Principal, @Headers('idempotency-key') key?: string) {
    if (!key || key.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return this.checkout.placementStatus(p.userId, key);
  }
  @Get('orders')
  @ApiOperation({ operationId: 'customerOrdersList' })
  list(
    @CurrentPrincipal() p: Principal,
    @Query('cursor') cursor?: string,
    @Query('group') group?: string,
  ) {
    if (group !== undefined && !['active', 'delivered', 'cancelled'].includes(group))
      throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return this.orders.list(
      p.userId,
      50,
      cursor,
      group as 'active' | 'delivered' | 'cancelled' | undefined,
    );
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
    return this.keyed(p, key, `/v1/customer/orders/${id}/cancel`, body, async (_operationId, tx) =>
      this.orders.cancel(id, { type: 'CUSTOMER', id: p.userId }, body.reason, { tx }),
    );
  }
  private async keyed<T>(
    p: Principal,
    key: string | undefined,
    resource: string,
    body: unknown,
    work: (operationId: string, tx?: TransactionContext, owner?: IdempotencyOwner) => Promise<T>,
    external = false,
    onError?: (owner: IdempotencyOwner, operationId: string, error: unknown) => Promise<T | null>,
  ): Promise<T> {
    if (!key || key.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    const claimStarted = performance.now();
    const claim = await this.idem.claim(
      { actor: p.userId, audience: 'customer', method: 'POST', resource, key },
      hashRequest(JSON.stringify(body)),
      120,
      hashCanonical(body),
    );
    this.metrics?.observeStage('idempotency_claim', performance.now() - claimStarted);
    if (claim.kind === 'rejected') {
      this.metrics?.observeOutcome('rejected');
      throw new HttpException({ code: claim.code }, claim.status);
    }
    if (claim.kind === 'replay') {
      this.metrics?.observeOutcome('replay');
      // A cached error response must raise, never masquerade as a success body.
      if (claim.status >= 400) {
        const code =
          claim.body &&
          typeof claim.body === 'object' &&
          'code' in claim.body &&
          typeof claim.body.code === 'string'
            ? claim.body.code
            : 'REQUEST_FAILED';
        throw new HttpException({ code }, claim.status);
      }
      return claim.body as T;
    }
    if (
      external &&
      resource === '/v1/customer/checkout/place' &&
      (claim.kind === 'in_progress' || claim.kind === 'response_expired')
    ) {
      // A committed order can exist before the response cache is completed or
      // after it has expired. Reading it must not initiate another payment.
      const recovered = await this.checkout.recoverCommitted(p.userId, claim.operationId);
      if (recovered) {
        this.metrics?.observeOutcome(
          claim.kind === 'in_progress' ? 'in_progress' : 'response_expired',
        );
        return recovered as T;
      }
    }
    if (claim.kind === 'in_progress') {
      this.metrics?.observeOutcome('in_progress');
      throw new HttpException({ code: 'REQUEST_IN_PROGRESS' }, 409);
    }
    if (claim.kind === 'response_expired') {
      this.metrics?.observeOutcome('response_expired');
      throw new HttpException({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409);
    }
    if (claim.kind !== 'claimed') {
      this.metrics?.observeOutcome('conflict');
      throw new HttpException({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409);
    }
    this.metrics?.observeOutcome('claimed');
    if (!external) {
      const response = await this.idem.execute(claim.owner, async (tx) => ({
        status: 200,
        body: (await work(claim.owner.operationId, tx)) as Json,
      }));
      return response.body as T;
    }
    return this.idem.withRenewal(claim.owner, async () => {
      try {
        const result = await work(claim.owner.operationId, undefined, claim.owner);
        await this.idem.execute(claim.owner, async () => ({ status: 200, body: result as Json }));
        return result;
      } catch (error) {
        // Settle runs under the live renewal so the fence holds the lease.
        // A recovered order returns normally; anything else rethrows the
        // original error after attempting to record a proven rejection.
        if (onError) {
          const settled = await onError(claim.owner, claim.owner.operationId, error).catch(
            () => null,
          );
          if (settled) return settled;
        }
        throw error;
      }
    });
  }
}
