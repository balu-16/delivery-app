import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';
import { ProblemDto } from '../../identity/contracts/swagger.js';

export class StockBalanceView {
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty({ pattern: '^\\d+$' }) onHand!: string;
  @ApiProperty({ pattern: '^\\d+$' }) reserved!: string;
  @ApiProperty({ pattern: '^\\d+$', description: 'Unreserved quantity in eligible batches' })
  available!: string;
  @ApiProperty({ pattern: '^[1-9]\\d*$' }) version!: string;
}
export class StockItemView extends StockBalanceView {
  @ApiProperty() sku!: string;
  @ApiProperty({ type: String, nullable: true }) barcode!: string | null;
  @ApiProperty() name!: string;
}
export class StockPageView {
  @ApiProperty({ type: [StockItemView] }) items!: StockItemView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class StockReportView {
  @ApiProperty({ type: [StockBalanceView] }) items!: StockBalanceView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ExpiringBatchView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty() batchCode!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ enum: ['ACTIVE', 'QUARANTINED', 'DAMAGED'] }) state!: string;
  @ApiProperty({ pattern: '^\\d+$' }) onHand!: string;
  @ApiProperty({ pattern: '^\\d+$' }) reserved!: string;
}
export class ExpiringPageView {
  @ApiProperty({ type: [ExpiringBatchView] }) items!: ExpiringBatchView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class StockLedgerView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty({ format: 'uuid' }) batchId!: string;
  @ApiProperty() kind!: string;
  @ApiProperty({ pattern: '^-?\\d+$' }) onHandDelta!: string;
  @ApiProperty({ pattern: '^-?\\d+$' }) reservedDelta!: string;
  @ApiProperty({ type: String, nullable: true }) actorId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class StockLedgerPageView {
  @ApiProperty({ type: [StockLedgerView] }) items!: StockLedgerView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class StockChangeView {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Present when a distinct checker is required',
  })
  approvalId?: string;
}
export class ShelfLifeView {
  @ApiProperty({ format: 'uuid' }) categoryId!: string;
  @ApiProperty({ minimum: 0, maximum: 31536000 }) minSeconds!: number;
  @ApiProperty({ pattern: '^[1-9]\\d*$' }) version!: string;
}
export class ShelfLifePageView {
  @ApiProperty({ type: [ShelfLifeView] }) items!: ShelfLifeView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export function InventoryIdempotencyHeader(): MethodDecorator {
  return ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Retained key scoped to the actor, store and stock operation',
    schema: { type: 'string', minLength: 1, maxLength: 150 },
  });
}

/** Shared contract for stock surfaces; domain failures retain their declared safe code. */
export function InventoryApiErrors(): ClassDecorator {
  return applyDecorators(
    ...[
      [400, 'Invalid request'],
      [401, 'Authentication required'],
      [403, 'Role not permitted'],
      [404, 'Resource or store assignment not found'],
      [409, 'Stock, version, approval or idempotency conflict'],
      [429, 'Rate limited; retry after the indicated delay'],
      [503, 'Dependency unavailable'],
    ].map(([status, description]) =>
      ApiResponse({ status: Number(status), description: String(description), type: ProblemDto }),
    ),
  );
}
