import { Controller, Get, Inject, Query, UseGuards, UseInterceptors } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import {
  INVENTORY_PORTAL_READS,
  type InventoryPortalReads,
} from '../../../modules/inventory/contracts/portal-reads.js';
import { InventoryApiErrors, StockItemView } from '../../../modules/inventory/contracts/swagger.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import { StorePageQueryDto, StoreSearchPageQueryDto } from './queries.js';

class ReceiptViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() variantName!: string;
  @ApiProperty() sku!: string;
  @ApiProperty({ format: 'uuid' }) batchId!: string;
  @ApiProperty() batchCode!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty({ pattern: '^-?\\d+$' }) quantity!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) actorId!: string | null;
  @ApiProperty({ type: String, nullable: true }) actorName!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
class ReceiptPageDto {
  @ApiProperty({ type: [ReceiptViewDto] }) items!: ReceiptViewDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
class AdjustmentViewDto {
  @ApiProperty() reference!: string;
  @ApiProperty({ pattern: '^\\d+$' }) counted!: string;
  @ApiProperty({ type: String, nullable: true, pattern: '^-?\\d+$' }) delta!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) variantId!: string | null;
  @ApiProperty({ type: String, nullable: true }) variantName!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) batchId!: string | null;
  @ApiProperty({ type: String, nullable: true }) batchCode!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ format: 'uuid' }) actorId!: string;
  @ApiProperty({ type: String, nullable: true }) actorName!: string | null;
  @ApiProperty({ enum: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'APPLIED'] })
  state!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) approvalId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
class AdjustmentPageDto {
  @ApiProperty({ type: [AdjustmentViewDto] }) items!: AdjustmentViewDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
class CountItemDto {
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) variantId!: string | null;
  @ApiProperty({ type: String, nullable: true }) variantName!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) batchId!: string | null;
  @ApiProperty({ type: String, nullable: true }) batchCode!: string | null;
  @ApiProperty({ type: String, nullable: true, pattern: '^\\d+$' }) counted!: string | null;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
}
class CountViewDto {
  @ApiProperty({ format: 'uuid' }) actorId!: string;
  @ApiProperty({ type: String, nullable: true }) actorName!: string | null;
  @ApiProperty() reference!: string;
  @ApiProperty({ enum: ['APPLIED', 'PENDING', 'EXPIRED', 'REJECTED'] }) state!: string;
  @ApiProperty() approvalRequired!: boolean;
  @ApiProperty({ type: [CountItemDto] }) items!: CountItemDto[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) completedAt!: string | null;
}
class CountPageDto {
  @ApiProperty({ type: [CountViewDto] }) items!: CountViewDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
class BatchViewDto {
  @ApiProperty({ format: 'uuid' }) batchId!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() name!: string;
  @ApiProperty() batchCode!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty({ enum: ['ACTIVE', 'QUARANTINED', 'DAMAGED'] }) state!: string;
  @ApiProperty({ pattern: '^\\d+$' }) onHand!: string;
  @ApiProperty({ pattern: '^\\d+$' }) reserved!: string;
  @ApiProperty({ pattern: '^\\d+$' }) available!: string;
  @ApiProperty({ type: String, nullable: true }) binLocation!: string | null;
  @ApiProperty({ pattern: '^[1-9][0-9]{0,18}$' }) version!: string;
}
class BatchPageDto {
  @ApiProperty({ type: [BatchViewDto] }) items!: BatchViewDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
class InventoryExportViewDto {
  @ApiProperty({ type: [StockItemView] }) items!: StockItemView[];
  @ApiProperty() truncated!: boolean;
}

/** Store-manager inventory history and batch reads (P10 portal). */
@Controller('v1/store/inventory')
@ApiBearerAuth()
@InventoryApiErrors()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'store', roles: ['STORE_MANAGER'] })
@UseGuards(IdentityGuard)
export class StoreInventoryReadsController {
  constructor(@Inject(INVENTORY_PORTAL_READS) private readonly reads: InventoryPortalReads) {}

  @Get('receipts')
  @ApiOperation({ operationId: 'storeInventoryReceiptsHistory' })
  @ApiOkResponse({ type: ReceiptPageDto })
  receipts(@CurrentPrincipal() p: Principal, @Query() q: StorePageQueryDto) {
    return this.reads.receipts(p.userId, q.storeId, q.cursor, q.limit);
  }

  @Get('adjustments')
  @ApiOperation({ operationId: 'storeInventoryAdjustments' })
  @ApiOkResponse({ type: AdjustmentPageDto })
  adjustments(@CurrentPrincipal() p: Principal, @Query() q: StorePageQueryDto) {
    return this.reads.adjustments(p.userId, q.storeId, q.cursor, q.limit);
  }

  @Get('counts')
  @ApiOperation({ operationId: 'storeInventoryCounts' })
  @ApiOkResponse({ type: CountPageDto })
  counts(@CurrentPrincipal() p: Principal, @Query() q: StorePageQueryDto) {
    return this.reads.counts(p.userId, q.storeId, q.cursor, q.limit);
  }

  @Get('batches')
  @ApiOperation({ operationId: 'storeInventoryBatches' })
  @ApiOkResponse({ type: BatchPageDto })
  batches(@CurrentPrincipal() p: Principal, @Query() q: StoreSearchPageQueryDto) {
    return this.reads.batches(p.userId, q.storeId, q.search ?? '', q.cursor, q.limit);
  }

  @Get('export')
  @ApiOperation({ operationId: 'storeInventoryExport' })
  @ApiOkResponse({ type: InventoryExportViewDto })
  export(@CurrentPrincipal() p: Principal, @Query() q: StoreSearchPageQueryDto) {
    return this.reads.exportStock(p.userId, q.storeId, q.search ?? '');
  }
}
