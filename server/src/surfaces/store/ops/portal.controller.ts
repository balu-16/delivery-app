import {
  Body,
  Controller,
  Get,
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
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import { PICK_TASKS, type PickTasks } from '../../../modules/picking/contracts/tasks.js';
import type {
  KpiSummary,
  SlaTask,
  StoreStaffMember,
} from '../../../modules/picking/contracts/tasks.js';
import {
  STORE_PORTAL_STORE_READS,
  type StoreDetailsView,
  type StorePortalStoreReads,
  type StoreStatusHistoryEntry,
} from '../../../modules/stores/contracts/management.js';
import {
  STORE_PORTAL_READS,
  type InspectionDraftItem,
  type StorePortalReads,
  type StoreSearchType,
} from '../../../modules/store-portal-reads/contracts/store-portal-reads.js';
import { NOTIFICATION_VIEWS } from '../../../modules/notifications/contracts/notifications.js';
import type { NotificationViews } from '../../../modules/notifications/contracts/notifications.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';

class StoreIdQuery {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
}

class SearchQuery extends StoreIdQuery {
  @ApiProperty({ enum: ['ORDERS', 'CUSTOMERS', 'PRODUCTS'] })
  @IsIn(['ORDERS', 'CUSTOMERS', 'PRODUCTS'])
  type!: StoreSearchType;
  @ApiProperty({ maxLength: 100 }) @IsString() @Length(1, 100) q!: string;
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

class ReturnsQuery extends StoreIdQuery {
  @ApiProperty({ enum: ['ELIGIBLE', 'RECORDED'] }) @IsIn(['ELIGIBLE', 'RECORDED']) tab!:
    'ELIGIBLE' | 'RECORDED';
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
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

class InspectionDraftDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() variantId!: string;
  @ApiProperty({ pattern: '^[1-9][0-9]{0,18}$' }) @IsString() @Length(1, 20) quantity!: string;
  @ApiProperty({ enum: ['SALEABLE', 'DAMAGED', 'EXPIRED'] })
  @IsIn(['SALEABLE', 'DAMAGED', 'EXPIRED'])
  decision!: InspectionDraftItem['decision'];
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @MaxLength(200) note?: string;
}

class SaveDraftDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty({ type: [InspectionDraftDto], maxItems: 100 })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InspectionDraftDto)
  items!: InspectionDraftDto[];
  @ApiPropertyOptional({ maxLength: 500 }) @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class DashboardQuery {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
}

/** Composed store-manager dashboard view (aggregate over picking, store and alerts). */
export interface StoreDashboardView {
  kpis: KpiSummary;
  workload: { staff: StoreStaffMember[]; breaches: SlaTask[] };
  upcomingTasks: Awaited<ReturnType<PickTasks['queue']>>['items'];
  alerts: { unreadNotifications: number };
  store: { status: StoreDetailsView['status']; pauseReason: string | null; version: string };
}

/**
 * Store-manager portal operations surface: dashboard aggregate, authorized
 * search, store facts/status history, and the returns workflow reads +
 * persistent inspection drafts. Picking item actions stay on the picking
 * surface; every route is STORE_MANAGER-scoped per request storeId.
 */
@ApiBearerAuth()
@Controller('v1/store')
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'store', roles: ['STORE_MANAGER'] })
@UseGuards(IdentityGuard)
export class StoreOpsController {
  constructor(
    @Inject(PICK_TASKS) private readonly picking: PickTasks,
    @Inject(STORE_PORTAL_STORE_READS) private readonly stores: StorePortalStoreReads,
    @Inject(STORE_PORTAL_READS) private readonly reads: StorePortalReads,
    @Inject(NOTIFICATION_VIEWS) private readonly notifications: NotificationViews,
  ) {}

  @Get('dashboard')
  @ApiOperation({ operationId: 'storeDashboard' })
  @ApiOkResponse({ schema: { type: 'object' } })
  async dashboard(
    @CurrentPrincipal() p: Principal,
    @Query() q: DashboardQuery,
  ): Promise<StoreDashboardView> {
    const [kpis, staff, breaches, upcoming, unread, store] = await Promise.all([
      this.picking.kpis(p.userId, q.storeId),
      this.picking.staff(p.userId, q.storeId, undefined, 25),
      this.picking.slaBoard(p.userId, q.storeId, undefined, 25),
      this.picking.queue(p.userId, { storeId: q.storeId, scope: 'ALL', limit: 8 }),
      this.notifications.unreadCount(p.userId),
      this.stores.details(p.userId, q.storeId),
    ]);
    return {
      kpis,
      workload: { staff: staff.items, breaches: breaches.items },
      upcomingTasks: upcoming.items,
      alerts: { unreadNotifications: unread },
      store: { status: store.status, pauseReason: store.pauseReason, version: store.version },
    };
  }

  @Get('search')
  @ApiOperation({ operationId: 'storeSearch' })
  search(@CurrentPrincipal() p: Principal, @Query() q: SearchQuery) {
    return this.reads.search(p.userId, q.storeId, q.type, q.q, q.cursor, q.limit);
  }

  @Get('status')
  @ApiOperation({ operationId: 'storeStatusView' })
  async status(
    @CurrentPrincipal() p: Principal,
    @Query() q: StoreIdQuery,
  ): Promise<{ store: StoreDetailsView; history: StoreStatusHistoryEntry[] }> {
    const [store, history] = await Promise.all([
      this.stores.details(p.userId, q.storeId),
      this.stores.statusHistory(p.userId, q.storeId, undefined, 50),
    ]);
    return { store, history: history.items };
  }

  @Get('returns')
  @ApiOperation({ operationId: 'storeReturnsFeed' })
  returnsFeed(@CurrentPrincipal() p: Principal, @Query() q: ReturnsQuery) {
    return q.tab === 'ELIGIBLE'
      ? this.reads.eligibleReturnOrders(p.userId, q.storeId, q.cursor, q.limit)
      : this.reads.recordedReturns(p.userId, q.storeId, q.search ?? '', q.cursor, q.limit);
  }

  @Get('returns/orders/:orderId')
  @ApiOperation({ operationId: 'storeReturnDetail' })
  returnDetail(
    @CurrentPrincipal() p: Principal,
    @Param('orderId') orderId: string,
    @Query() q: StoreIdQuery,
  ) {
    return this.reads.returnDetail(p.userId, q.storeId, orderId);
  }

  @Get('returns/orders/:orderId/draft')
  @ApiOperation({ operationId: 'storeReturnDraft' })
  getDraft(
    @CurrentPrincipal() p: Principal,
    @Param('orderId') orderId: string,
    @Query() q: StoreIdQuery,
  ) {
    return this.reads.getInspectionDraft(p.userId, q.storeId, orderId);
  }

  /** Upsert by order: replaying the same draft is naturally idempotent. */
  @Post('returns/orders/:orderId/draft')
  @ApiOperation({ operationId: 'storeReturnDraftSave' })
  saveDraft(
    @CurrentPrincipal() p: Principal,
    @Param('orderId') orderId: string,
    @Body() d: SaveDraftDto,
  ) {
    return this.reads.saveInspectionDraft(
      p.userId,
      d.storeId,
      orderId,
      d.items.map((item) => ({ ...item, note: item.note ?? null })),
      d.note ?? null,
    );
  }
}
