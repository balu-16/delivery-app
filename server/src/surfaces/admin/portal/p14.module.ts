import {
  Controller,
  Get,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import { AuthPolicy } from '../../../modules/identity/contracts/http.js';
import { AdminPortalReadsModule } from '../../../modules/admin-portal-reads/admin-portal-reads.module.js';
import {
  ADMIN_PORTAL_READS,
  type AdminPortalReads,
  type PaymentAttemptListItem,
} from '../../../modules/admin-portal-reads/contracts/admin-portal-reads.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';

class DashboardDto {
  @ApiPropertyOptional() @IsISO8601() from!: string;
  @ApiPropertyOptional() @IsISO8601() to!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() storeId?: string;
}
class PageDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 512) cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
class PaymentAttemptsDto extends PageDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['CREATED', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'UNKNOWN'])
  status?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['GATEWAY', 'WALLET', 'COD', 'ZERO_DUE'])
  method?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) search?: string;
}
class RefundsDto extends PageDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() storeId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn(['PENDING', 'PROCESSED', 'FAILED', 'UNKNOWN'])
  status?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) search?: string;
}
class InventorySummaryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(2, 64) search?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 64) cursor?: string;
  // The portal renders the full catalog (≤200 rows) in one view.
  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
class RatingsDto extends PageDto {
  // Query strings arrive as text; coerce before the boolean constraint runs.
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' || value === true
      ? true
      : value === 'false' || value === false
        ? false
        : value,
  )
  @IsBoolean()
  queueOnly?: boolean;
}
class SearchDto {
  @ApiPropertyOptional() @IsString() @Length(2, 64) q!: string;
}
class PaymentAttemptPageView {
  @ApiPropertyOptional({ type: [Object] }) items!: PaymentAttemptListItem[];
  @ApiPropertyOptional({ nullable: true, type: String }) nextCursor!: string | null;
}

/** Admin portal read surface (P14). SUPER_ADMIN only; all reads are bounded. */
@Controller('v1/admin')
@ApiBearerAuth()
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
export class AdminPortalController {
  constructor(@Inject(ADMIN_PORTAL_READS) private readonly reads: AdminPortalReads) {}

  @Get('dashboard')
  @ApiOperation({ operationId: 'adminDashboard' })
  dashboard(@Query() query: DashboardDto) {
    return this.reads.dashboard({ from: query.from, to: query.to, storeId: query.storeId });
  }

  @Get('delivery/fleet')
  @ApiOperation({ operationId: 'adminDeliveryFleet' })
  fleet() {
    return this.reads.fleet();
  }

  @Get('orders/:id/rider-candidates')
  @ApiOperation({ operationId: 'adminOrderRiderCandidates' })
  riderCandidates(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.reads.riderCandidates(id).then((items) => ({ items }));
  }

  @Get('orders/:id/invoice')
  @ApiOperation({ operationId: 'adminOrderInvoice' })
  invoice(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.reads.orderInvoice(id);
  }

  @Get('payments/attempts')
  @ApiOperation({ operationId: 'adminPaymentAttemptsList' })
  @ApiOkResponse({ type: PaymentAttemptPageView })
  paymentAttempts(@Query() query: PaymentAttemptsDto) {
    return this.reads.paymentAttempts(query);
  }

  @Get('refunds')
  @ApiOperation({ operationId: 'adminRefundsList' })
  refunds(@Query() query: RefundsDto) {
    return this.reads.refunds(query);
  }

  @Get('inventory/summary')
  @ApiOperation({ operationId: 'adminInventorySummary' })
  inventorySummary(@Query() query: InventorySummaryDto) {
    return this.reads.inventorySummary({ ...query, search: query.search?.trim() || undefined });
  }

  @Get('ratings')
  @ApiOperation({ operationId: 'adminRatingsList' })
  ratings(@Query() query: RatingsDto) {
    return this.reads.ratings(query);
  }

  @Get('legal-holds')
  @ApiOperation({ operationId: 'adminLegalHoldsList' })
  legalHolds(@Query() query: PageDto) {
    return this.reads.legalHolds(query.cursor, query.limit ?? 50);
  }

  @Get('search')
  @ApiOperation({ operationId: 'adminGlobalSearch' })
  search(@Query() query: SearchDto) {
    return this.reads.search({ q: query.q });
  }
}

@Module({
  imports: [IdentityModule, AdminPortalReadsModule],
  controllers: [AdminPortalController],
})
export class AdminPortalSurfaceModule {}
