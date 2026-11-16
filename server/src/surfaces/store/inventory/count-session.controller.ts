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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  INVENTORY_COUNT_SESSIONS,
  type InventoryCountSessions,
} from '../../../modules/inventory/contracts/count-sessions.js';
import {
  InventoryApiErrors,
  InventoryIdempotencyHeader,
} from '../../../modules/inventory/contracts/swagger.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import { StorePageQueryDto } from '../portal/queries.js';

const COUNTED = /^(0|[1-9][0-9]{0,18})$/;

class CountSessionLineDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() batchId!: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    pattern: '^(0|[1-9][0-9]{0,18})$',
    description: 'Absolute counted on-hand; omit or null to clear',
  })
  @IsOptional()
  @Matches(COUNTED)
  counted?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string | null;
}

class CreateCountSessionDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
  @ApiPropertyOptional({
    type: [CountSessionLineDto],
    description: 'Omit to snapshot every active batch currently on hand',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CountSessionLineDto)
  lines?: CountSessionLineDto[];
}

class UpdateCountSessionDto {
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
  @ApiPropertyOptional({ type: [CountSessionLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CountSessionLineDto)
  lines?: CountSessionLineDto[];
  @ApiPropertyOptional({ pattern: '^[1-9][0-9]{0,18}$' })
  @IsOptional()
  @Matches(/^[1-9][0-9]{0,18}$/)
  expectedVersion?: string;
}

class CountSessionLineViewDto {
  @ApiProperty() lineNo!: number;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() variantName!: string;
  @ApiProperty() sku!: string;
  @ApiProperty({ format: 'uuid' }) batchId!: string;
  @ApiProperty() batchCode!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty({ pattern: '^\\d+$' }) expectedQty!: string;
  @ApiProperty({ type: String, nullable: true, pattern: '^\\d+$' }) countedQty!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['APPLIED', 'PENDING_APPROVAL', 'FAILED'],
  })
  outcome!: string | null;
  @ApiProperty({ type: String, nullable: true }) outcomeDetail!: string | null;
}
class CountSessionViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) storeId!: string;
  @ApiProperty({ enum: ['OPEN', 'COMPLETED', 'CANCELLED'] }) status!: string;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ pattern: '^[1-9][0-9]{0,18}$' }) version!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) completedAt!: string | null;
  @ApiProperty({ type: [CountSessionLineViewDto] }) lines!: CountSessionLineViewDto[];
}
class CountSessionPageDto {
  @ApiProperty({ type: [CountSessionViewDto] }) items!: CountSessionViewDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

/** Multi-line stock-count sessions with persistent drafts and audited completion. */
@Controller('v1/store/inventory/count-sessions')
@ApiBearerAuth()
@InventoryApiErrors()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'store', roles: ['STORE_MANAGER'] })
@UseGuards(IdentityGuard)
export class StoreCountSessionController {
  constructor(
    @Inject(INVENTORY_COUNT_SESSIONS) private readonly sessions: InventoryCountSessions,
  ) {}

  @Post()
  @ApiOperation({ operationId: 'storeInventoryCreateCountSession' })
  @ApiCreatedResponse({ type: CountSessionViewDto })
  create(@CurrentPrincipal() p: Principal, @Body() d: CreateCountSessionDto) {
    return this.sessions.create(p.userId, {
      storeId: d.storeId,
      note: d.note,
      lines: d.lines?.map((line) => ({
        batchId: line.batchId,
        counted: line.counted ?? null,
        reason: line.reason ?? null,
      })),
    });
  }

  @Get()
  @ApiOperation({ operationId: 'storeInventoryCountSessions' })
  @ApiOkResponse({ type: CountSessionPageDto })
  list(@CurrentPrincipal() p: Principal, @Query() q: StorePageQueryDto) {
    return this.sessions.list(p.userId, q.storeId, q.cursor, q.limit);
  }

  @Get(':id')
  @ApiOperation({ operationId: 'storeInventoryCountSession' })
  @ApiOkResponse({ type: CountSessionViewDto })
  get(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.sessions.get(p.userId, id);
  }

  @Patch(':id')
  @ApiOperation({ operationId: 'storeInventoryUpdateCountSession' })
  @ApiOkResponse({ type: CountSessionViewDto })
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() d: UpdateCountSessionDto,
  ) {
    return this.sessions.update(p.userId, id, {
      note: d.note,
      expectedVersion: d.expectedVersion,
      lines: d.lines?.map((line) => ({
        batchId: line.batchId,
        counted: line.counted ?? null,
        reason: line.reason ?? null,
      })),
    });
  }

  @Post(':id/complete')
  @ApiOperation({ operationId: 'storeInventoryCompleteCountSession' })
  @InventoryIdempotencyHeader()
  @ApiOkResponse({ type: CountSessionViewDto })
  complete(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return this.sessions.complete(p.userId, id, key);
  }

  @Post(':id/cancel')
  @ApiOperation({ operationId: 'storeInventoryCancelCountSession' })
  @ApiOkResponse({ type: CountSessionViewDto })
  cancel(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.sessions.cancel(p.userId, id);
  }
}
