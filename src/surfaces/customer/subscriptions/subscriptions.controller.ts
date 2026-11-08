import {
  Body,
  Controller,
  Delete,
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
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, IsUUID, Matches } from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  SUBSCRIPTIONS,
  type SubscriptionOperations,
} from '../../../modules/subscriptions/contracts/subscriptions.js';
import type { FrequencyRule } from '../../../modules/subscriptions/contracts/subscriptions.js';
import { IdempotencyStore, hashRequest } from '../../../common/idempotency/idempotency.js';
import type { Json, TransactionContext } from '../../../platform/database/database.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
class CreateDto {
  @ApiProperty() @IsUUID() variantId!: string;
  @ApiProperty() @IsString() @Matches(/^[1-9]\d{0,18}$/) quantity!: string;
  @ApiProperty({ type: Object }) @IsObject() frequencyRule!: FrequencyRule;
  @ApiProperty() @Matches(/^\d{4}-\d{2}-\d{2}$/) startDate!: string;
  @ApiPropertyOptional() @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) endDate?: string;
  @ApiProperty() @IsUUID() slotId!: string;
  @ApiProperty() @IsUUID() addressId!: string;
}
class QuantityDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Matches(/^[1-9]\d{0,18}$/) quantity?: string;
  @ApiPropertyOptional({ type: Object }) @IsOptional() @IsObject() frequencyRule?: FrequencyRule;
  @ApiPropertyOptional() @IsOptional() @IsUUID() slotId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() addressId?: string;
}
class DateDto {
  @ApiProperty() @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
}
class PauseDto {
  @ApiProperty() @Matches(/^\d{4}-\d{2}-\d{2}$/) from!: string;
  @ApiProperty() @Matches(/^\d{4}-\d{2}-\d{2}$/) to!: string;
}
@Controller('v1/customer/subscriptions')
@ApiBearerAuth()
@AuthPolicy({ audience: 'customer' })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class CustomerSubscriptionsController {
  constructor(
    @Inject(SUBSCRIPTIONS) private readonly subscriptions: SubscriptionOperations,
    private readonly idem: IdempotencyStore,
  ) {}
  private async keyed(
    p: Principal,
    key: string | undefined,
    method: string,
    resource: string,
    body: unknown,
    work: (tx: TransactionContext) => Promise<unknown>,
  ) {
    if (!key || key.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    const claim = await this.idem.claim(
      { actor: p.userId, audience: 'customer', method, resource, key },
      hashRequest(JSON.stringify(body)),
    );
    if (claim.kind === 'replay') return claim.body;
    if (claim.kind === 'in_progress') throw new HttpException({ code: 'REQUEST_IN_PROGRESS' }, 409);
    if (claim.kind !== 'claimed') throw new HttpException({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409);
    const result = await this.idem.execute(claim.owner, async (tx) => ({
      status: 200,
      body: (await work(tx)) as Json,
    }));
    return result.body;
  }
  @Post() @ApiOperation({ operationId: 'customerSubscriptionCreate' }) create(
    @CurrentPrincipal() p: Principal,
    @Body() body: CreateDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, 'POST', '/subscriptions', body, (tx) =>
      this.subscriptions.create(p.userId, body, tx),
    );
  }
  @Get() @ApiOperation({ operationId: 'customerSubscriptionsList' }) list(
    @CurrentPrincipal() p: Principal,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.subscriptions.list(
      p.userId,
      limit === undefined ? undefined : Number(limit),
      cursor,
    );
  }
  @Get('calendar')
  @ApiOperation({ operationId: 'customerSubscriptionCalendar' })
  calendar(
    @CurrentPrincipal() p: Principal,
    @Query('month') month: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.subscriptions.calendar(
      p.userId,
      month,
      limit === undefined ? undefined : Number(limit),
      cursor,
    );
  }
  @Get(':id/upcoming')
  @ApiOperation({ operationId: 'customerSubscriptionUpcoming' })
  upcoming(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('count') raw?: string,
  ) {
    const count = raw === undefined ? 10 : Number(raw);
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('INVALID_INPUT');
    const now = new Date(Date.now() + 330 * 60_000);
    const from = now.toISOString().slice(0, 10);
    const to = new Date(Date.parse(`${from}T00:00:00Z`) + count * 365 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    return this.subscriptions.upcoming(p.userId, id, from, to, count);
  }
  @Get(':id') @ApiOperation({ operationId: 'customerSubscriptionGet' }) get(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.subscriptions.get(p.userId, id);
  }
  @Patch(':id') @ApiOperation({ operationId: 'customerSubscriptionQuantity' }) quantity(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: QuantityDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, 'PATCH', `/subscriptions/${id}`, body, (tx) =>
      this.subscriptions.change(p.userId, id, body, tx),
    );
  }
  @Post(':id/pause') @ApiOperation({ operationId: 'customerSubscriptionPause' }) pause(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PauseDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, 'POST', `/subscriptions/${id}/pause`, body, (tx) =>
      this.subscriptions.pause(p.userId, id, body.from, body.to, tx),
    );
  }
  @Post(':id/resume') @ApiOperation({ operationId: 'customerSubscriptionResume' }) resume(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, 'POST', `/subscriptions/${id}/resume`, {}, (tx) =>
      this.subscriptions.resume(p.userId, id, tx),
    );
  }
  @Post(':id/skip') @ApiOperation({ operationId: 'customerSubscriptionSkip' }) skip(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DateDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, 'POST', `/subscriptions/${id}/skip`, body, (tx) =>
      this.subscriptions.skip(p.userId, id, body.date, false, tx),
    );
  }
  @Delete(':id/skip/:date') @ApiOperation({ operationId: 'customerSubscriptionUnskip' }) unskip(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('date') date: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, 'DELETE', `/subscriptions/${id}/skip/${date}`, {}, (tx) =>
      this.subscriptions.skip(p.userId, id, date, true, tx),
    );
  }
  @Post(':id/cancel') @ApiOperation({ operationId: 'customerSubscriptionCancel' }) cancel(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, 'POST', `/subscriptions/${id}/cancel`, {}, (tx) =>
      this.subscriptions.cancel(p.userId, id, tx),
    );
  }
}
