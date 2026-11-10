import { applyDecorators } from '@nestjs/common';
import { ApiHeader, ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';
import { ProblemDto } from '../../identity/contracts/swagger.js';

export class FefoBatchView {
  @ApiProperty({ format: 'uuid' }) batchId!: string;
  @ApiProperty() batchCode!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) expiresAt!: string | null;
  @ApiProperty({ pattern: '^\\d+$' }) availableQty!: string;
}
export class PickItemView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() orderItemId!: string;
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) substituteVariantId!:
    string | null;
  @ApiProperty({ maxLength: 300 }) name!: string;
  @ApiProperty({ pattern: '^[1-9][0-9]{0,18}$' }) expectedQty!: string;
  @ApiProperty({ pattern: '^\\d+$' }) pickedQty!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) batchId!: string | null;
  @ApiProperty({ enum: ['PENDING', 'PICKED', 'SHORT', 'SUBSTITUTED'] }) status!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['OUT_OF_STOCK', 'DAMAGED', 'EXPIRED', 'NOT_FOUND'],
  })
  shortReason!: string | null;
  @ApiPropertyOptional({ type: [FefoBatchView] }) fefoSuggestions?: FefoBatchView[];
}
export class PickTaskView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty({ format: 'uuid' }) storeId!: string;
  @ApiProperty({ enum: ['PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] })
  status!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) assignedTo!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) startedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) slaDueAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) completedAt!: string | null;
  @ApiProperty({ pattern: '^[1-9]\\d*$' }) version!: string;
  @ApiProperty({ type: [PickItemView] }) items!: PickItemView[];
}
export class PickTaskPageView {
  @ApiProperty({ type: [PickTaskView] }) items!: PickTaskView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ClaimResultView {
  @ApiProperty({ type: PickTaskView }) task!: PickTaskView;
}
export class PackResultView {
  @ApiProperty({ format: 'date-time' }) packedAt!: string;
}
export class HandoverResultView {
  @ApiProperty({ enum: ['VERIFIED', 'OVERRIDE'] }) state!: string;
}
export class StoreOrderSummaryView {
  @ApiProperty() orderId!: string;
  @ApiProperty({ type: String, nullable: true }) orderNumber!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty() itemCount!: number;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) placedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) pickTaskId!: string | null;
  @ApiProperty({ type: String, nullable: true }) pickTaskStatus!: string | null;
}
export class StoreOrderPageView {
  @ApiProperty({ type: [StoreOrderSummaryView] }) items!: StoreOrderSummaryView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class StoreStaffMemberView {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ['PICKER', 'STORE_MANAGER'] }) role!: string;
  @ApiProperty() activeTasks!: number;
}
export class StoreStaffPageView {
  @ApiProperty({ type: [StoreStaffMemberView] }) items!: StoreStaffMemberView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class KpiSummaryView {
  @ApiProperty() openTasks!: number;
  @ApiProperty() completedToday!: number;
  @ApiProperty() slaBreachesToday!: number;
  @ApiProperty({ pattern: '^\\d+$' }) avgPickSeconds!: string;
  @ApiProperty({ pattern: '^\\d+$' }) shortRateBps!: string;
  @ApiProperty() backlog!: number;
}
export class SlaTaskView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() orderId!: string;
  @ApiProperty({ enum: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] }) status!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) assignedTo!: string | null;
  @ApiProperty({ format: 'date-time' }) slaDueAt!: string;
  @ApiProperty() breached!: boolean;
}
export class SlaBoardView {
  @ApiProperty({ type: [SlaTaskView] }) items!: SlaTaskView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export function PickIdempotencyHeader(): MethodDecorator {
  return ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Retained key scoped to the actor, store and picking operation',
    schema: { type: 'string', minLength: 1, maxLength: 150 },
  });
}

/** Shared contract for store fulfillment surfaces; domain failures retain their declared safe code. */
export function PickingApiErrors(): ClassDecorator {
  return applyDecorators(
    ...[
      [400, 'Invalid request'],
      [401, 'Authentication required'],
      [403, 'Role not permitted'],
      [404, 'Resource or store assignment not found'],
      [409, 'Task state, scan, attempt or idempotency conflict'],
      [429, 'Rate limited; retry after the indicated delay'],
      [503, 'Fulfillment dependency unavailable'],
    ].map(([status, description]) =>
      ApiResponse({ status: Number(status), description: String(description), type: ProblemDto }),
    ),
  );
}
