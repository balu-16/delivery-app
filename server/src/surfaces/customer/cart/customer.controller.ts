import {
  Body,
  Controller,
  Delete,
  HttpCode,
  Get,
  Headers,
  HttpException,
  Inject,
  Optional,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
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
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import type { Json } from '../../../platform/database/database.js';
import type { TransactionContext } from '../../../platform/database/database.js';
import { HttpMetrics } from '../../../platform/metrics/http-metrics.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  canonical,
  IdempotencyStore,
  hashRequest,
} from '../../../common/idempotency/idempotency.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { CART_SERVICE } from '../../../modules/cart/contracts/cart.js';
import type { CartService } from '../../../modules/cart/contracts/cart.js';
import { CART_PREVIEWS } from '../../../modules/cart/contracts/quote.js';
import type { CartPreviews } from '../../../modules/cart/contracts/quote.js';
import { COUPONS, COUPON_ATTEMPT_LIMITER } from '../../../modules/coupons/contracts/coupons.js';
import type {
  CouponAttemptLimiter,
  CouponValidation,
} from '../../../modules/coupons/contracts/coupons.js';
const IDEMPOTENCY_STORE = Symbol('CART_HTTP_IDEMPOTENCY');
export { IDEMPOTENCY_STORE };
const PAISE = /^(0|[1-9][0-9]{0,11})$/;
class CartIssueView {
  @ApiProperty() code!: string;
  @ApiPropertyOptional({ format: 'uuid' }) variantId?: string;
  @ApiPropertyOptional() detail?: string;
}
class CartLineView {
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
class CartView {
  @ApiProperty({ format: 'uuid' }) cartId!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) storeId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) addressId!: string | null;
  @ApiProperty() version!: number;
  @ApiProperty({ type: String, nullable: true }) couponCode!: string | null;
  @ApiProperty({ type: CartLineView, isArray: true }) lines!: CartLineView[];
  @ApiProperty({ type: CartIssueView, isArray: true }) issues!: CartIssueView[];
}
class CartWriteView {
  @ApiProperty({ type: CartView }) cart!: CartView;
  @ApiProperty() clamped!: boolean;
}
class PutItemDto {
  @ApiProperty({ pattern: PAISE.source }) @Matches(PAISE) quantity!: string;
  @ApiProperty({ minimum: 1 }) @Type(() => Number) @IsInt() @Min(1) version!: number;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() addressId?: string;
  @ApiPropertyOptional({ pattern: PAISE.source })
  @IsOptional()
  @Matches(PAISE)
  displayedUnitPricePaise?: string;
  @ApiPropertyOptional({ type: Boolean }) @IsOptional() @IsBoolean() acceptPriceChange?: boolean;
}
class VersionQuery {
  @ApiProperty({ minimum: 1 }) @Type(() => Number) @IsInt() @Min(1) version!: number;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() addressId?: string;
}
class ApplyCouponDto {
  @ApiProperty({ maxLength: 40 }) @IsString() @MaxLength(40) code!: string;
  @ApiProperty({ minimum: 1 }) @Type(() => Number) @IsInt() @Min(1) version!: number;
}
class ValidateDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() addressId!: string;
  @ApiPropertyOptional({ pattern: PAISE.source }) @IsOptional() @Matches(PAISE) tipPaise?: string;
  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  couponCode?: string;
}
class AvailableQuery {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() addressId?: string;
}
@Controller('v1/customer')
@ApiBearerAuth()
@AuthPolicy({ audience: 'customer' })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class CustomerCartController {
  constructor(
    @Inject(CART_SERVICE) private readonly carts: CartService,
    @Inject(CART_PREVIEWS) private readonly previews: CartPreviews,
    @Inject(COUPONS) private readonly coupons: CouponValidation,
    @Inject(COUPON_ATTEMPT_LIMITER) private readonly limiter: CouponAttemptLimiter,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotency: IdempotencyStore,
    @Optional() private readonly metrics?: HttpMetrics,
  ) {}
  @Get('cart')
  @ApiOperation({ operationId: 'customerCartGet' })
  @ApiOkResponse({
    type: CartView,
    description: 'Stored lines with freshly computed issues and version',
  })
  async get(@CurrentPrincipal() p: Principal) {
    const cart = await this.carts.get(p.userId);
    if (!cart) throw new Error('CART_NOT_FOUND');
    return cart;
  }
  @Put('cart/items/:variantId')
  @ApiOperation({ operationId: 'customerCartPutItem' })
  @ApiOkResponse({ type: CartWriteView, description: 'Cart after the absolute quantity write' })
  putItem(
    @CurrentPrincipal() p: Principal,
    @Param('variantId', new ParseUUIDPipe()) variantId: string,
    @Body() d: PutItemDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(
      p,
      'PUT',
      `/v1/customer/cart/items/${variantId}`,
      key,
      { variantId, ...d },
      (tx) =>
        this.carts.putItem(p.userId, variantId, d.quantity, {
          expectedVersion: d.version,
          addressId: d.addressId,
          displayedUnitPricePaise: d.displayedUnitPricePaise,
          acceptPriceChange: d.acceptPriceChange,
          tx,
        }),
    );
  }
  @Delete('cart/items/:variantId')
  @ApiOperation({ operationId: 'customerCartDeleteItem' })
  deleteItem(
    @CurrentPrincipal() p: Principal,
    @Param('variantId', new ParseUUIDPipe()) variantId: string,
    @Query() q: VersionQuery,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(
      p,
      'DELETE',
      `/v1/customer/cart/items/${variantId}`,
      key,
      { variantId, ...q },
      (tx) => this.carts.deleteItem(p.userId, variantId, { expectedVersion: q.version, tx }),
    );
  }
  @Delete('cart')
  @ApiOperation({ operationId: 'customerCartDelete' })
  async delete(
    @CurrentPrincipal() p: Principal,
    @Query() q: VersionQuery,
    @Headers('idempotency-key') key?: string,
  ) {
    await this.keyed(p, 'DELETE', '/v1/customer/cart', key, q, async (tx) => {
      await this.carts.deleteCart(p.userId, { expectedVersion: q.version, tx });
      return {};
    });
  }
  @Post('cart/coupon')
  @HttpCode(200)
  @ApiOperation({ operationId: 'customerCartApplyCoupon' })
  applyCoupon(
    @CurrentPrincipal() p: Principal,
    @Body() d: ApplyCouponDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(
      p,
      'POST',
      '/v1/customer/cart/coupon',
      key,
      d,
      (tx) => this.carts.applyCoupon(p.userId, d.code, { expectedVersion: d.version, tx }),
      { beforeClaim: () => this.limiter.check(p.userId) },
    );
  }
  @Delete('cart/coupon')
  @ApiOperation({ operationId: 'customerCartRemoveCoupon' })
  removeCoupon(
    @CurrentPrincipal() p: Principal,
    @Query() q: VersionQuery,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, 'DELETE', '/v1/customer/cart/coupon', key, q, (tx) =>
      this.carts.removeCoupon(p.userId, { expectedVersion: q.version, tx }),
    );
  }
  @Post('cart/validate')
  @HttpCode(200)
  @ApiOperation({ operationId: 'customerCartValidate' })
  @ApiOkResponse({ description: 'Computed quote preview with issues; no snapshot is persisted' })
  validate(
    @CurrentPrincipal() p: Principal,
    @Body() d: ValidateDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(
      p,
      'POST',
      '/v1/customer/cart/validate',
      key,
      d,
      (tx) =>
        this.previews.preview({
          userId: p.userId,
          addressId: d.addressId,
          ...(d.tipPaise === undefined ? {} : { tipPaise: d.tipPaise }),
          ...(d.couponCode === undefined ? {} : { couponCode: d.couponCode }),
          tx,
        }),
      { beforeClaim: () => this.limiter.check(p.userId) },
    );
  }
  @Get('coupons/available')
  @ApiOperation({ operationId: 'customerCouponsAvailable' })
  async available(@CurrentPrincipal() p: Principal, @Query() q: AvailableQuery) {
    const scope = await this.carts.freshSubtotal(p.userId, q.addressId);
    if (!scope) throw new Error('CART_NOT_FOUND');
    const items = await this.coupons.available(p.userId, scope.storeId, scope.subtotalPaise);
    return { items };
  }
  /**
   * Claims the idempotency key, runs the DB-only work inside the claimed
   * transaction and replays the cached response for identical retries.
   */
  private async keyed<T>(
    p: Principal,
    method: 'PUT' | 'POST' | 'DELETE',
    resource: string,
    key: string | undefined,
    input: unknown,
    work: (tx: TransactionContext) => Promise<T>,
    guards: { beforeClaim?: () => Promise<void> } = {},
  ): Promise<T> {
    if (!key || key.length < 1 || key.length > 150)
      throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    const writeStarted = performance.now();
    try {
      await guards.beforeClaim?.();
      const hash = hashRequest(JSON.stringify([method, resource, canonical(input)]));
      const claimStarted = performance.now();
      const claim = await this.idempotency.claim(
        { actor: p.userId, audience: 'customer', method, resource, key },
        hash,
      );
      this.metrics?.observeStage('idempotency_claim', performance.now() - claimStarted);
      if (claim.kind === 'replay') {
        this.metrics?.observeOutcome('replay');
        return claim.body as T;
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
      const txnStarted = performance.now();
      try {
        const { body } = await this.idempotency.execute(claim.owner, async (tx) => ({
          status: 200,
          body: (await work(tx)) as unknown as Json,
        }));
        return body as T;
      } finally {
        this.metrics?.observeStage('cart_write_txn', performance.now() - txnStarted);
      }
    } finally {
      this.metrics?.observeStage('cart_write', performance.now() - writeStarted);
    }
  }
}
