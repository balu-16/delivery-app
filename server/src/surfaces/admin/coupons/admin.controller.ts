import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Json, TransactionContext } from '../../../platform/database/database.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  canonical,
  IdempotencyStore,
  hashRequest,
} from '../../../common/idempotency/idempotency.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  COUPON_ADMINISTRATION,
  type CouponAdministration,
  type CouponDraft,
  type CouponPatch,
} from '../../../modules/coupons/contracts/coupons.js';
const IDEMPOTENCY_STORE = Symbol('COUPON_ADMIN_HTTP_IDEMPOTENCY');
export { IDEMPOTENCY_STORE };
const PAISE = /^(0|[1-9][0-9]{0,17})$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;
class CouponDraftDto {
  @ApiProperty({ pattern: CODE.source, minLength: 3, maxLength: 40 })
  @Matches(CODE)
  @MinLength(3)
  @MaxLength(40)
  code!: string;
  @ApiProperty({ enum: ['PERCENT', 'FLAT', 'FREE_DELIVERY'] })
  @IsIn(['PERCENT', 'FLAT', 'FREE_DELIVERY'])
  kind!: 'PERCENT' | 'FLAT' | 'FREE_DELIVERY';
  @ApiProperty({ pattern: PAISE.source, description: 'percent basis points or flat paise' })
  @Matches(PAISE)
  valuePaise!: string;
  @ApiPropertyOptional({ pattern: PAISE.source })
  @IsOptional()
  @Matches(PAISE)
  maxCapPaise?: string;
  @ApiProperty({ pattern: PAISE.source }) @Matches(PAISE) minOrderPaise!: string;
  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perUserLimit?: number;
  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  globalLimit?: number;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsISO8601() validFrom?: string;
  @ApiPropertyOptional({ format: 'date-time' }) @IsOptional() @IsISO8601() validTo?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() categoryId?: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() productId?: string;
  @ApiPropertyOptional({ type: [String], format: 'uuid', maxItems: 500 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  excludedVariantIds?: string[];
  @ApiProperty() @IsBoolean() stackable!: boolean;
  @ApiProperty() @IsBoolean() firstOrderOnly!: boolean;
}
class CouponPatchDto {
  @ApiPropertyOptional({ minimum: 1, nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perUserLimit?: number | null;
  @ApiPropertyOptional({ minimum: 1, nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  globalLimit?: number | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @IsISO8601()
  validFrom?: string | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @IsISO8601()
  validTo?: string | null;
  @ApiPropertyOptional({ pattern: PAISE.source })
  @IsOptional()
  @Matches(PAISE)
  minOrderPaise?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() active?: boolean;
  @ApiProperty({ pattern: '^[1-9][0-9]{0,17}$' })
  @Matches(/^[1-9][0-9]{0,17}$/)
  expectedVersion!: string;
}
class CouponListQuery {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @Matches(/^[A-Z0-9][A-Z0-9_-]{2,39}$/)
  cursor?: string;
}
function draftOf(d: CouponDraftDto): CouponDraft {
  return {
    code: d.code,
    kind: d.kind,
    valuePaise: d.valuePaise,
    maxCapPaise: d.maxCapPaise ?? null,
    minOrderPaise: d.minOrderPaise,
    perUserLimit: d.perUserLimit ?? null,
    globalLimit: d.globalLimit ?? null,
    validFrom: d.validFrom ?? null,
    validTo: d.validTo ?? null,
    storeId: d.storeId ?? null,
    categoryId: d.categoryId ?? null,
    productId: d.productId ?? null,
    excludedVariantIds: d.excludedVariantIds ?? [],
    stackable: d.stackable,
    firstOrderOnly: d.firstOrderOnly,
  };
}
function patchOf(d: CouponPatchDto): CouponPatch {
  const result: CouponPatch = {};
  for (const key of ['perUserLimit', 'globalLimit'] as const) {
    const value = d[key];
    if (value !== undefined) result[key] = value;
  }
  for (const key of ['validFrom', 'validTo'] as const) {
    const value = d[key];
    if (value !== undefined) result[key] = value;
  }
  if (d.minOrderPaise !== undefined) result.minOrderPaise = d.minOrderPaise;
  if (d.active !== undefined) result.active = d.active;
  return result;
}
@Controller('v1/admin/coupons')
@ApiBearerAuth()
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class AdminCouponsController {
  constructor(
    @Inject(COUPON_ADMINISTRATION) private readonly admin: CouponAdministration,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotency: IdempotencyStore,
  ) {}
  @Post()
  @ApiOperation({ operationId: 'adminCouponsCreate' })
  @ApiOkResponse({ description: 'Created coupon; replayed for identical retries' })
  create(
    @CurrentPrincipal() p: Principal,
    @Body() d: CouponDraftDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, 'POST', '/v1/admin/coupons', key, d, (tx) =>
      this.admin.create(p.userId, draftOf(d), tx),
    );
  }
  @Get()
  @ApiOperation({ operationId: 'adminCouponsList' })
  list(@CurrentPrincipal() p: Principal, @Query() q: CouponListQuery) {
    return this.admin.list(p.userId, q.limit ?? 50, q.cursor);
  }
  @Patch(':id')
  @ApiOperation({ operationId: 'adminCouponsUpdate' })
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() d: CouponPatchDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, 'PATCH', `/v1/admin/coupons/${id}`, key, { id, ...d }, (tx) =>
      this.admin.update(p.userId, id, patchOf(d), d.expectedVersion, tx),
    );
  }
  private async keyed<T>(
    p: Principal,
    method: 'POST' | 'PATCH',
    resource: string,
    key: string | undefined,
    input: unknown,
    work: (tx: TransactionContext) => Promise<T>,
  ): Promise<T> {
    if (!key || key.length < 1 || key.length > 150)
      throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    const hash = hashRequest(JSON.stringify([method, resource, canonical(input)]));
    const claim = await this.idempotency.claim(
      { actor: p.userId, audience: 'admin', method, resource, key },
      hash,
    );
    if (claim.kind === 'replay') return claim.body as T;
    if (claim.kind === 'in_progress') throw new HttpException({ code: 'REQUEST_IN_PROGRESS' }, 409);
    if (claim.kind !== 'claimed') throw new HttpException({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409);
    const { body } = await this.idempotency.execute(claim.owner, async (tx) => ({
      status: 200,
      body: (await work(tx)) as unknown as Json,
    }));
    return body as T;
  }
}
