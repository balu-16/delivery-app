import { Controller, Get, Inject, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import {
  STORE_COD_READS,
  type StoreCodReads,
} from '../../../modules/riders/contracts/store-cod.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import { StorePageQueryDto, StoreSearchPageQueryDto } from './queries.js';

class CodRiderViewDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ pattern: '^\\d+$' }) cashInHandPaise!: string;
  @ApiProperty({ type: String, nullable: true, pattern: '^\\d+$' }) limitPaise!: string | null;
  @ApiProperty() hasOutstanding!: boolean;
}
class CodRiderPageDto {
  @ApiProperty({ type: [CodRiderViewDto] }) items!: CodRiderViewDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
class CodDepositViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) riderId!: string;
  @ApiProperty() riderName!: string;
  @ApiProperty({ pattern: '^\\d+$' }) amountPaise!: string;
  @ApiProperty({ pattern: '^\\d+$' }) discrepancyPaise!: string;
  @ApiProperty() depositReference!: string;
  @ApiProperty({ enum: ['PENDING', 'CLEARED'] }) status!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
class CodDepositTotalsDto {
  @ApiProperty({ pattern: '^\\d+$' }) depositedPaise!: string;
  @ApiProperty({ pattern: '^\\d+$' }) discrepancyPaise!: string;
  @ApiProperty({ minimum: 0 }) count!: number;
}
class CodDepositPageDto {
  @ApiProperty({ type: [CodDepositViewDto] }) items!: CodDepositViewDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
  @ApiProperty({ type: CodDepositTotalsDto }) totals!: CodDepositTotalsDto;
}

/** Store-manager COD views: deposit candidates and settlement history (P10 portal). */
@Controller('v1/store/cod')
@ApiBearerAuth()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'store', roles: ['STORE_MANAGER'] })
@UseGuards(IdentityGuard)
export class StoreCodReadsController {
  constructor(@Inject(STORE_COD_READS) private readonly reads: StoreCodReads) {}

  @Get('riders')
  @ApiOperation({ operationId: 'storeCodRiders' })
  @ApiOkResponse({ type: CodRiderPageDto })
  riders(@CurrentPrincipal() p: Principal, @Query() q: StorePageQueryDto) {
    return this.reads.eligibleRiders(p.userId, q.storeId, q.cursor, q.limit);
  }

  @Get('deposits')
  @ApiOperation({ operationId: 'storeCodDeposits' })
  @ApiOkResponse({ type: CodDepositPageDto })
  deposits(@CurrentPrincipal() p: Principal, @Query() q: StoreSearchPageQueryDto) {
    return this.reads.deposits(p.userId, q.storeId, q.search ?? '', q.cursor, q.limit);
  }
}
