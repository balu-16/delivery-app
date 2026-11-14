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
  Post,
  Put,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  SUBSCRIPTION_ADMIN,
  type SubscriptionAdmin,
} from '../../../modules/subscriptions/contracts/subscriptions.js';
import {
  IdempotencyStore,
  hashCanonical,
  hashRequest,
} from '../../../common/idempotency/idempotency.js';
import type { Json, TransactionContext } from '../../../platform/database/database.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
class PlanDto {
  @ApiProperty() @IsUUID() variantId!: string;
  @ApiProperty() @IsBoolean() active!: boolean;
}
class SlotDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() id?: string;
  @ApiProperty() @IsUUID() storeId!: string;
  @ApiProperty() @IsString() @MaxLength(100) name!: string;
  @ApiProperty() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) startTime!: string;
  @ApiProperty() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) endTime!: string;
  @ApiProperty() @IsBoolean() active!: boolean;
}
class HolidayDto {
  @ApiProperty() @IsUUID() storeId!: string;
  @ApiProperty() @Matches(/^\d{4}-\d{2}-\d{2}$/) date!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) reason?: string;
}
@Controller('v1/admin/subscriptions')
@ApiBearerAuth()
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class AdminSubscriptionsController {
  constructor(
    @Inject(SUBSCRIPTION_ADMIN) private readonly admin: SubscriptionAdmin,
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
      { actor: p.userId, audience: 'admin', method, resource, key },
      hashRequest(JSON.stringify(body)),
      30,
      hashCanonical(body),
    );
    if (claim.kind === 'replay') return claim.body;
    if (claim.kind === 'in_progress') throw new HttpException({ code: 'REQUEST_IN_PROGRESS' }, 409);
    if (claim.kind !== 'claimed') throw new HttpException({ code: 'IDEMPOTENCY_KEY_REUSED' }, 409);
    return (
      await this.idem.execute(claim.owner, async (tx) => ({
        status: 200,
        body: (await work(tx)) as Json,
      }))
    ).body;
  }
  @Get('plans') @ApiOperation({ operationId: 'adminSubscriptionPlans' }) plans(
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.admin.plans(limit === undefined ? undefined : Number(limit), cursor);
  }
  @Put('plans') @ApiOperation({ operationId: 'adminSubscriptionPlanSave' }) savePlan(
    @CurrentPrincipal() p: Principal,
    @Body() d: PlanDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, 'PUT', '/subscriptions/plans', d, (tx) =>
      this.admin.savePlan(p.userId, d.variantId, d.active, tx),
    );
  }
  @Get('slots') @ApiOperation({ operationId: 'adminSubscriptionSlots' }) slots(
    @Query('storeId', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.admin.slots(id, limit === undefined ? undefined : Number(limit), cursor);
  }
  @Put('slots') @ApiOperation({ operationId: 'adminSubscriptionSlotSave' }) saveSlot(
    @CurrentPrincipal() p: Principal,
    @Body() d: SlotDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, 'PUT', '/subscriptions/slots', d, (tx) =>
      this.admin.saveSlot(p.userId, d, tx),
    );
  }
  @Get('holidays') @ApiOperation({ operationId: 'adminSubscriptionHolidays' }) holidays(
    @Query('storeId', ParseUUIDPipe) id: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.admin.holidays(id, limit === undefined ? undefined : Number(limit), cursor);
  }
  @Put('holidays') @ApiOperation({ operationId: 'adminSubscriptionHolidaySave' }) saveHoliday(
    @CurrentPrincipal() p: Principal,
    @Body() d: HolidayDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, 'PUT', '/subscriptions/holidays', d, (tx) =>
      this.admin.saveHoliday(p.userId, d.storeId, d.date, d.reason ?? null, false, tx),
    );
  }
  @Delete('holidays/:storeId/:date')
  @ApiOperation({ operationId: 'adminSubscriptionHolidayDelete' })
  removeHoliday(
    @CurrentPrincipal() p: Principal,
    @Param('storeId', ParseUUIDPipe) id: string,
    @Param('date') date: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, 'DELETE', `/subscriptions/holidays/${id}/${date}`, {}, (tx) =>
      this.admin.saveHoliday(p.userId, id, date, null, true, tx),
    );
  }
  @Get('runs') @ApiOperation({ operationId: 'adminSubscriptionRuns' }) runs(
    @Query('storeId') id?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    if (id && !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('INVALID_INPUT');
    return this.admin.runs(id, limit === undefined ? undefined : Number(limit), cursor);
  }
  @Post('runs/:id/retry') @ApiOperation({ operationId: 'adminSubscriptionRunRetry' }) retry(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keyed(p, key, 'POST', `/subscriptions/runs/${id}/retry`, {}, (tx) =>
      this.admin.retryRun(p.userId, id, tx),
    );
  }
}
