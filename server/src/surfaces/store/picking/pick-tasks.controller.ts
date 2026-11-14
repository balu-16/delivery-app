import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Param,
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
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  IsArray,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  ClaimResultView,
  PickingApiErrors,
  PickIdempotencyHeader,
  PickTaskPageView,
  PickTaskView,
  StoreOrderPageView,
} from '../../../modules/picking/contracts/swagger.js';
import { PICK_TASKS, type PickTasks } from '../../../modules/picking/contracts/tasks.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';

const QTY = /^[1-9][0-9]{0,18}$/;

class QueueQueryDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiPropertyOptional({ enum: ['QUEUE', 'MINE', 'ALL'], default: 'MINE' })
  @IsOptional()
  @IsIn(['QUEUE', 'MINE', 'ALL'])
  scope?: 'QUEUE' | 'MINE' | 'ALL';
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
class ReassignDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() toUserId!: string;
  @ApiProperty({ maxLength: 300 }) @IsString() @Length(1, 300) reason!: string;
}
class PickBatchDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() batchId!: string;
  @ApiProperty({ pattern: '^[1-9][0-9]{0,18}$' }) @Matches(QTY) quantity!: string;
}
class PickItemDto {
  @ApiProperty({ maxLength: 100 }) @IsString() @Length(1, 100) scannedBarcode!: string;
  @ApiProperty({ pattern: '^[1-9][0-9]{0,18}$' }) @Matches(QTY) quantity!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() batchId?: string;
  @ApiPropertyOptional({ type: [PickBatchDto], maxItems: 20 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => PickBatchDto)
  batches?: PickBatchDto[];
}
class ShortDto {
  @ApiProperty({ enum: ['OUT_OF_STOCK', 'DAMAGED', 'EXPIRED', 'NOT_FOUND'] })
  @IsIn(['OUT_OF_STOCK', 'DAMAGED', 'EXPIRED', 'NOT_FOUND'])
  reason!: 'OUT_OF_STOCK' | 'DAMAGED' | 'EXPIRED' | 'NOT_FOUND';
}
class SubstituteDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() candidateVariantId!: string;
  @ApiProperty({ maxLength: 100 }) @IsString() @Length(1, 100) scannedBarcode!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() batchId?: string;
}
class CursorQueryDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiPropertyOptional({ maxLength: 512 })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

function key(header?: string): string {
  if (!header || header.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
  return header;
}

@Controller('v1/store')
@ApiBearerAuth()
@PickingApiErrors()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'store', roles: ['STORE_MANAGER'] })
@UseGuards(IdentityGuard)
export class StorePickTasksController {
  @Post('pick-tasks/:id/heartbeat')
  @ApiOperation({ operationId: 'storePickHeartbeat' })
  async heartbeat(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.picking.heartbeat(p.userId, id);
    return { state: 'ACTIVE' };
  }
  constructor(@Inject(PICK_TASKS) private readonly picking: PickTasks) {}
  @Get('pick-tasks')
  @ApiOperation({ operationId: 'storePickQueue' })
  @ApiOkResponse({ type: PickTaskPageView })
  queue(@CurrentPrincipal() p: Principal, @Query() q: QueueQueryDto) {
    return this.picking.queue(p.userId, {
      storeId: q.storeId,
      scope: q.scope ?? 'MINE',
      cursor: q.cursor,
      limit: q.limit,
    });
  }
  @Post('pick-tasks/:id/claim')
  @ApiOperation({ operationId: 'storePickClaim' })
  @PickIdempotencyHeader()
  @ApiOkResponse({ type: ClaimResultView })
  claim(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.picking.claim(p.userId, id, key(keyHeader));
  }
  @Post('pick-tasks/:id/start')
  @ApiOperation({ operationId: 'storePickStart' })
  @PickIdempotencyHeader()
  @ApiOkResponse({ type: PickTaskView })
  start(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.picking.start(p.userId, id, key(keyHeader));
  }
  @Post('pick-tasks/:id/complete')
  @ApiOperation({ operationId: 'storePickComplete' })
  @PickIdempotencyHeader()
  @ApiOkResponse({ type: PickTaskView })
  complete(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.picking.complete(p.userId, id, key(keyHeader));
  }
  @Post('pick-tasks/:id/reassign')
  @ApiOperation({ operationId: 'storePickReassign' })
  @PickIdempotencyHeader()
  @ApiOkResponse({ type: PickTaskView })
  reassign(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() d: ReassignDto,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.picking.reassign(p.userId, id, d.toUserId, d.reason, key(keyHeader));
  }
  @Post('pick-tasks/:id/items/:itemId/pick')
  @ApiOperation({ operationId: 'storePickItem' })
  @PickIdempotencyHeader()
  @ApiOkResponse({ type: PickTaskView })
  pickItem(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() d: PickItemDto,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.picking.pickItem(p.userId, id, itemId, d, key(keyHeader));
  }
  @Post('pick-tasks/:id/items/:itemId/short')
  @ApiOperation({ operationId: 'storePickItemShort' })
  @PickIdempotencyHeader()
  @ApiOkResponse({ type: PickTaskView })
  shortItem(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() d: ShortDto,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.picking.shortItem(p.userId, id, itemId, d, key(keyHeader));
  }
  @Post('pick-tasks/:id/items/:itemId/substitute')
  @ApiOperation({ operationId: 'storePickItemSubstitute' })
  @PickIdempotencyHeader()
  @ApiOkResponse({ type: PickTaskView })
  substituteItem(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() d: SubstituteDto,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.picking.substituteItem(p.userId, id, itemId, d, key(keyHeader));
  }
  @Get('sla-board')
  @ApiOperation({ operationId: 'storeSlaBoard' })
  slaBoard(@CurrentPrincipal() p: Principal, @Query() q: CursorQueryDto) {
    return this.picking.slaBoard(p.userId, q.storeId, q.cursor, q.limit);
  }
  @Get('staff')
  @ApiOperation({ operationId: 'storeStaff' })
  staff(@CurrentPrincipal() p: Principal, @Query() q: CursorQueryDto) {
    return this.picking.staff(p.userId, q.storeId, q.cursor, q.limit);
  }
  @Get('kpis')
  @ApiOperation({ operationId: 'storeKpis' })
  kpis(@CurrentPrincipal() p: Principal, @Query('storeId') storeId: string) {
    if (!storeId || !/^[0-9a-f-]{36}$/i.test(storeId))
      throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return this.picking.kpis(p.userId, storeId);
  }
  @Get('orders')
  @ApiOperation({ operationId: 'storeOrdersQueue' })
  @ApiOkResponse({ type: StoreOrderPageView })
  orders(@CurrentPrincipal() p: Principal, @Query() q: CursorQueryDto) {
    return this.picking.storeOrders(p.userId, q.storeId, q.cursor, q.limit);
  }
}
