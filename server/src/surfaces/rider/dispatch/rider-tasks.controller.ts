import {
  DELIVERY_POD,
  WRONG_ADDRESS,
  type DeliveryPod,
  type WrongAddress,
} from '../../../modules/dispatch/contracts/tasks.js';
import { IsInt } from 'class-validator';
import {
  Body,
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  getSchemaPath,
} from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  CodCollectResultView,
  ContactAttemptView,
  DeliveryApiErrors,
  DeliveryErrorInterceptor,
  DeliveryIdempotencyHeader,
  DeliveryTaskView,
  WrongAddressFlagView,
  RiderActiveTaskView,
  RiderTaskHistoryView,
  RiderDashboardView,
} from '../../../modules/dispatch/contracts/swagger.js';
import {
  DELIVERY_TASKS,
  RIDER_TASK_READS,
  type DeliveryTasks,
  type RiderTaskReadPort,
} from '../../../modules/dispatch/contracts/tasks.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { requireKey } from './rider-offers.controller.js';

class PodUploadDto {
  @ApiProperty({ enum: ['image/jpeg', 'image/png'] }) @IsString() contentType!: string;
  @ApiProperty({ minimum: 1 }) @IsInt() @Min(1) size!: number;
}

class PointDto {
  @ApiPropertyOptional({ minimum: -90, maximum: 90 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;
  @ApiPropertyOptional({ minimum: -180, maximum: 180 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;
}

class DeliverDto {
  @ApiPropertyOptional({ pattern: '^\\d{4}$' })
  @IsOptional()
  @Matches(/^\d{4}$/)
  deliveryCode?: string;
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsString()
  podMediaId?: string;
}

class FailDto {
  @ApiProperty({ maxLength: 300 }) @IsString() @Length(1, 300) reason!: string;
  @ApiPropertyOptional({ type: Object, additionalProperties: { type: 'string' } })
  @IsOptional()
  evidence?: Record<string, string>;
}
class WrongAddressDto {
  @ApiProperty({ minLength: 1, maxLength: 300 }) @IsString() @Length(1, 300) reason!: string;
}

class CodCollectDto {
  @ApiProperty({ pattern: '^\\d+$' }) @Matches(/^\d+$/) amountPaise!: string;
}

function readPoint(raw: PointDto | undefined): { lat: number; lng: number } | undefined {
  if (!raw || (raw.lat === undefined && raw.lng === undefined)) return undefined;
  if (raw.lat === undefined || raw.lng === undefined)
    throw new BadRequestException({ code: 'INVALID_INPUT' });
  return { lat: raw.lat, lng: raw.lng };
}

@Controller('v1/rider')
@ApiBearerAuth()
@ApiExtraModels(RiderActiveTaskView, RiderTaskHistoryView)
@DeliveryApiErrors()
@UseInterceptors(DomainErrorInterceptor, DeliveryErrorInterceptor)
@AuthPolicy({ audience: 'rider', roles: ['RIDER'] })
@UseGuards(IdentityGuard)
export class RiderTasksController {
  constructor(
    @Inject(DELIVERY_TASKS) private readonly tasks: DeliveryTasks,
    @Inject(DELIVERY_POD) private readonly pod: DeliveryPod,
    @Inject(WRONG_ADDRESS) private readonly wrongAddress: WrongAddress,
    @Inject(RIDER_TASK_READS) private readonly reads: RiderTaskReadPort,
  ) {}

  @Get('tasks')
  @ApiOperation({ operationId: 'riderListTasks' })
  @ApiQuery({ name: 'scope', required: false, enum: ['active', 'history'] })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['items', 'nextCursor'],
      properties: {
        items: {
          type: 'array',
          items: {
            oneOf: [
              { $ref: getSchemaPath(RiderActiveTaskView) },
              { $ref: getSchemaPath(RiderTaskHistoryView) },
            ],
          },
        },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  list(
    @CurrentPrincipal() p: Principal,
    @Query('scope') scope?: string,
    @Query('cursor') cursor?: string,
  ) {
    if (scope && !['active', 'history'].includes(scope)) throw new Error('INVALID_PAGE');
    return scope === 'history' ? this.reads.history(p.userId, cursor) : this.reads.active(p.userId);
  }

  @Get('tasks/:id')
  @ApiOperation({ operationId: 'riderTaskDetail' })
  @ApiOkResponse({ type: RiderActiveTaskView })
  detail(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.reads.detail(p.userId, id);
  }

  @Get('dashboard')
  @ApiOperation({ operationId: 'riderDashboard' })
  @ApiOkResponse({ type: RiderDashboardView })
  dashboard(@CurrentPrincipal() p: Principal) {
    return this.reads.dashboard(p.userId);
  }

  @Post('tasks/:id/pod')
  @ApiOperation({ operationId: 'riderPodUploadTarget' })
  podTarget(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body() body: PodUploadDto) {
    return this.pod.target(p.userId, id, body.contentType, body.size);
  }

  @Post('tasks/:id/pod/:mediaId/complete')
  @ApiOperation({ operationId: 'riderPodUploadComplete' })
  podComplete(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
  ) {
    return this.pod.complete(p.userId, id, mediaId);
  }

  @Post('tasks/:id/arrived-at-store')
  @ApiOperation({ operationId: 'riderArrivedAtStore' })
  @DeliveryIdempotencyHeader()
  @ApiOkResponse({ type: DeliveryTaskView })
  arrivedAtStore(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Query() q: PointDto | undefined,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.tasks.arrivedAtStore(p.userId, id, requireKey(keyHeader), readPoint(q));
  }

  @Post('tasks/:id/picked-up')
  @ApiOperation({ operationId: 'riderPickedUp' })
  @DeliveryIdempotencyHeader()
  @ApiOkResponse({ type: DeliveryTaskView })
  pickedUp(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.tasks.pickedUp(p.userId, id, requireKey(keyHeader));
  }

  @Post('tasks/:id/arrived')
  @ApiOperation({ operationId: 'riderArrived' })
  @DeliveryIdempotencyHeader()
  @ApiOkResponse({ type: DeliveryTaskView })
  arrived(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Query() q: PointDto | undefined,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.tasks.arrived(p.userId, id, requireKey(keyHeader), readPoint(q));
  }

  @Post('tasks/:id/deliver')
  @ApiOperation({ operationId: 'riderDeliver' })
  @DeliveryIdempotencyHeader()
  @ApiOkResponse({ type: DeliveryTaskView })
  deliver(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: DeliverDto,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.tasks.deliver(p.userId, id, body, requireKey(keyHeader));
  }

  @Post('tasks/:id/fail')
  @ApiOperation({ operationId: 'riderFailTask' })
  @DeliveryIdempotencyHeader()
  @ApiOkResponse({ type: DeliveryTaskView })
  fail(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: FailDto,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.tasks.fail(p.userId, id, body, requireKey(keyHeader));
  }

  @Post('tasks/:id/cod-collect')
  @ApiOperation({ operationId: 'riderCodCollect' })
  @DeliveryIdempotencyHeader()
  @ApiOkResponse({ type: CodCollectResultView })
  codCollect(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: CodCollectDto,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.tasks.codCollect(p.userId, id, body, requireKey(keyHeader));
  }

  @Get('tasks/:id/contact')
  @ApiOperation({ operationId: 'riderTaskContact' })
  contact(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.tasks.contact(p.userId, id);
  }

  @Post('tasks/:id/contact-attempts')
  @ApiOperation({ operationId: 'riderRecordContactAttempt' })
  @DeliveryIdempotencyHeader()
  @ApiCreatedResponse({ type: ContactAttemptView })
  recordContactAttempt(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.tasks.recordContactAttempt(p.userId, id, requireKey(keyHeader));
  }

  @Post('tasks/:id/wrong-address')
  @ApiOperation({ operationId: 'riderFlagWrongAddress' })
  @DeliveryIdempotencyHeader()
  @ApiCreatedResponse({ type: WrongAddressFlagView })
  flagWrongAddress(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: WrongAddressDto,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.wrongAddress.flag(p.userId, id, body.reason, requireKey(keyHeader));
  }
}
