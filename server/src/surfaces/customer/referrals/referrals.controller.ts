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
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  REFERRALS,
  REFERRAL_HISTORY_DEFAULT_LIMIT,
  REFERRAL_HISTORY_MAX_LIMIT,
  REFERRAL_INVITE_LABEL_MAX,
  normalizeInviteLabel,
  type Referrals,
} from '../../../modules/referrals/contracts/referrals.js';
import {
  IdempotencyStore,
  hashCanonical,
  hashRequest,
} from '../../../common/idempotency/idempotency.js';
import type { Json } from '../../../platform/database/database.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';

class HistoryQuery {
  @ApiPropertyOptional({ enum: ['successful', 'pending'], default: 'successful' })
  @IsOptional()
  @IsIn(['successful', 'pending'])
  status?: 'successful' | 'pending';
  @ApiPropertyOptional({ maxLength: 4096 })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  cursor?: string;
  @ApiPropertyOptional({
    type: Number,
    minimum: 1,
    maximum: REFERRAL_HISTORY_MAX_LIMIT,
    default: REFERRAL_HISTORY_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @Min(1)
  @Max(REFERRAL_HISTORY_MAX_LIMIT)
  limit?: number;
}

class CreateInviteDto {
  @ApiPropertyOptional({
    maxLength: REFERRAL_INVITE_LABEL_MAX,
    description: 'Private owner note; trimmed, empty becomes null.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}

class ReferralHistoryItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) label!: string | null;
  @ApiProperty({ enum: ['successful', 'pending'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiPropertyOptional({ format: 'date-time' }) completedAt?: string;
  @ApiPropertyOptional() rewardPaise?: string;
  @ApiPropertyOptional({ format: 'date-time' }) creditExpiresAt?: string;
  @ApiPropertyOptional() inviteCode?: string;
}

class ReferralHistoryPageDto {
  @ApiProperty({ type: [ReferralHistoryItemDto] }) items!: ReferralHistoryItemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

class ReferralInviteCreatedDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Opaque invite reference, independent of the shareable code.',
  })
  reference!: string;
  @ApiProperty({ pattern: '^INV-[A-F0-9]{32}$' }) code!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

/**
 * Tracked invitations + history (plan3 §6, lead wires registration).
 * The top-card `GET /v1/customer/referrals` stays on the identity controller.
 */
@Controller('v1/customer/referrals')
@ApiBearerAuth()
@AuthPolicy({ audience: 'customer' })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class CustomerReferralsController {
  constructor(
    @Inject(REFERRALS) private readonly referrals: Referrals,
    private readonly idempotency: IdempotencyStore,
  ) {}

  @Get('history')
  @ApiOperation({ operationId: 'customerReferralsHistory' })
  @ApiOkResponse({ type: ReferralHistoryPageDto })
  history(@CurrentPrincipal() p: Principal, @Query() q: HistoryQuery) {
    return this.referrals.history(
      p.userId,
      q.status ?? 'successful',
      q.cursor,
      q.limit ?? REFERRAL_HISTORY_DEFAULT_LIMIT,
    );
  }

  @Post('invites')
  @ApiOperation({ operationId: 'customerReferralsInviteCreate' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: ReferralInviteCreatedDto })
  async createInvite(
    @CurrentPrincipal() p: Principal,
    @Body() body: CreateInviteDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length < 1 || key.length > 150)
      throw new HttpException({ code: 'IDEMPOTENCY_KEY_REQUIRED' }, 400);
    const label = normalizeInviteLabel(body?.label);
    const normalized = label ? { label } : {};
    const claim = await this.idempotency.claim(
      {
        actor: p.userId,
        audience: 'customer',
        method: 'POST',
        resource: '/v1/customer/referrals/invites',
        key,
      },
      hashRequest(JSON.stringify(['POST', '/v1/customer/referrals/invites', normalized])),
      30,
      hashCanonical(['POST', '/v1/customer/referrals/invites', normalized]),
    );
    if (claim.kind === 'replay') return claim.body;
    if (claim.kind === 'in_progress') throw new HttpException({ code: 'REQUEST_IN_PROGRESS' }, 409);
    if (claim.kind !== 'claimed') throw new HttpException({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409);
    const result = await this.idempotency.execute(claim.owner, async (tx) => ({
      status: 201,
      body: (await this.referrals.createInvite(
        p.userId,
        label ?? undefined,
        tx,
      )) as unknown as Json,
    }));
    return result.body;
  }
}
