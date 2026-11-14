import { Type } from 'class-transformer';
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
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiOkResponse,
  ApiResponse,
} from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  MaxLength,
} from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  INVENTORY_SHELF_LIFE,
  type InventoryShelfLife,
} from '../../../modules/inventory/contracts/shelf-life.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  InventoryApiErrors,
  InventoryIdempotencyHeader,
  ShelfLifePageView,
} from '../../../modules/inventory/contracts/swagger.js';
class ShelfPageDto {
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
class ShelfLifeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() categoryId!: string;
  @ApiProperty({ minimum: 0, maximum: 31536000 })
  @IsInt()
  @Min(0)
  @Max(31536000)
  minSeconds!: number;
  @ApiProperty({ pattern: '^(0|[1-9][0-9]{0,18})$' })
  @Matches(/^(0|[1-9][0-9]{0,18})$/)
  expectedVersion!: string;
  @ApiProperty({ minLength: 1, maxLength: 500 }) @IsString() @Length(1, 500) reason!: string;
}
@Controller('v1/admin/inventory/shelf-life')
@ApiBearerAuth()
@InventoryApiErrors()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
export class AdminShelfLifeController {
  constructor(@Inject(INVENTORY_SHELF_LIFE) private readonly shelf: InventoryShelfLife) {}
  @Get()
  @ApiOperation({ operationId: 'adminInventoryShelfLifeList' })
  @ApiOkResponse({ type: ShelfLifePageView })
  list(@CurrentPrincipal() p: Principal, @Query() q: ShelfPageDto) {
    return this.shelf.list(p.userId, q.cursor, q.limit);
  }
  @Post()
  @ApiOperation({ operationId: 'adminInventoryShelfLifeSet' })
  @InventoryIdempotencyHeader()
  @ApiResponse({ status: 201, description: 'Versioned shelf-life policy saved; empty response' })
  async set(
    @CurrentPrincipal() p: Principal,
    @Body() d: ShelfLifeDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    await this.shelf.set(p.userId, { ...d, reference: key });
  }
}
