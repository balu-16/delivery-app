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
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Json } from '../../../platform/database/database.js';
import { IdempotencyStore, hashRequest } from '../../../common/idempotency/idempotency.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  WALLET_TOPUPS,
  WALLET_VIEWS,
  type WalletTopupIntent,
  type WalletTopups,
  type WalletViews,
} from '../../../modules/wallet/contracts/wallet.js';
import { WALLET_IDEMPOTENCY } from './wallet.tokens.js';

class TopupDto {
  @ApiProperty({ pattern: '^[0-9]+$', example: '50000' })
  @IsString()
  @Matches(/^[0-9]+$/)
  amountPaise!: string;
}
class LedgerQuery {
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
 * Customer wallet reads and top-ups (manifest rows GET-v1-customer-wallet,
 * GET-v1-customer-wallet-ledger, POST-v1-customer-wallet-topups). Read
 * endpoints do not consult `wallet_enabled`: an existing balance stays
 * visible while the flag is off; only spending and new top-ups are refused
 * with 409 WALLET_DISABLED. Top-ups require an Idempotency-Key (money effect)
 * and are credited only from the verified capture webhook.
 */
@Controller('v1/customer/wallet')
@ApiBearerAuth()
@AuthPolicy({ audience: 'customer' })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class CustomerWalletController {
  constructor(
    @Inject(WALLET_VIEWS) private readonly views: WalletViews,
    @Inject(WALLET_TOPUPS) private readonly topups: WalletTopups,
    @Inject(WALLET_IDEMPOTENCY) private readonly idempotency: IdempotencyStore,
  ) {}
  @Get()
  @ApiOperation({ operationId: 'customerWalletGet' })
  @ApiOkResponse({ description: 'Cash and promo balances with the account version' })
  async balances(@CurrentPrincipal() p: Principal) {
    return this.views.balances(p.userId);
  }
  @Get('ledger')
  @ApiOperation({ operationId: 'customerWalletLedger' })
  async ledger(@CurrentPrincipal() p: Principal, @Query() q: LedgerQuery) {
    return this.views.ledger(p.userId, q.limit ?? 50, q.cursor);
  }
  @Post('topups')
  @ApiOperation({ operationId: 'customerWalletTopup' })
  async topup(
    @CurrentPrincipal() p: Principal,
    @Body() dto: TopupDto,
    @Headers('idempotency-key') key?: string,
  ): Promise<WalletTopupIntent> {
    if (!key || key.length < 1 || key.length > 150)
      throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    const hash = hashRequest(JSON.stringify(['POST', '/v1/customer/wallet/topups', dto]));
    const claim = await this.idempotency.claim(
      {
        actor: p.userId,
        audience: 'customer',
        method: 'POST',
        resource: '/v1/customer/wallet/topups',
        key,
      },
      hash,
    );
    if (claim.kind === 'replay') return claim.body as unknown as WalletTopupIntent;
    if (claim.kind === 'in_progress') throw new HttpException({ code: 'REQUEST_IN_PROGRESS' }, 409);
    if (claim.kind !== 'claimed') throw new HttpException({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409);
    try {
      // The gateway call runs outside the idempotency transaction; the intent
      // id derives from the idempotency operation so a retry after a crash
      // resumes the same durable attempt instead of creating a second order.
      const intent = await this.topups.create(p.userId, dto.amountPaise, {
        intentId: claim.owner.operationId,
      });
      await this.idempotency.execute(claim.owner, async () => ({
        status: 200,
        body: intent as unknown as Json,
      }));
      return intent;
    } catch (error: unknown) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'ExternalServiceUnavailable' || code === 'ExternalServiceTimeout') {
        await this.idempotency
          .execute(claim.owner, async () => ({
            status: 503,
            body: { code: 'ExternalServiceUnavailable' } as unknown as Json,
          }))
          .catch(() => undefined);
        throw new HttpException({ code: 'ExternalServiceUnavailable' }, 503);
      }
      throw error;
    }
  }
}
