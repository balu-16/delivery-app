import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
export class ExportIdView {
  @ApiProperty({ format: 'uuid' }) id!: string;
}
export class ExportUrlView {
  @ApiProperty() url!: string;
}
export class ExportJobView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() kind!: string;
  @ApiProperty({ enum: ['QUEUED', 'RUNNING', 'COMPLETE', 'FAILED', 'EXPIRED'] }) status!: string;
  @ApiProperty({ type: String }) row_count!: string;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
  @ApiProperty({ format: 'date-time' }) updated_at!: string;
  @ApiPropertyOptional({ format: 'date-time', nullable: true }) expires_at!: string | null;
}
export class ExportPageView {
  @ApiProperty({ type: [ExportJobView] }) items!: ExportJobView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ReportPageView {
  @ApiProperty({ type: 'array', items: { type: 'object', additionalProperties: true } })
  rows!: Record<string, unknown>[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ErasureView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ type: [String] }) blockers!: string[];
  @ApiProperty({ format: 'date-time' }) created_at!: string;
  @ApiProperty({ format: 'date-time' }) updated_at!: string;
}
export class ApprovalIdView {
  @ApiProperty({ format: 'uuid' }) approvalId!: string;
}
export class AdminErasureView extends ErasureView {
  @ApiProperty({ format: 'uuid' }) user_id!: string;
}
export class AdminErasurePageView {
  @ApiProperty({ type: [AdminErasureView] }) items!: AdminErasureView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class FraudView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() severity!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
}
export class FraudDetailView extends FraudView {
  @ApiProperty({ type: String, nullable: true }) user_id!: string | null;
  @ApiProperty() reference!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) details!: Record<string, unknown>;
  @ApiProperty({ type: String, nullable: true }) reviewed_by!: string | null;
  @ApiProperty({ type: String, nullable: true }) reviewed_at!: string | null;
}
export class FraudPageView {
  @ApiProperty({ type: [FraudView] }) items!: FraudView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ApprovalView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() action!: string;
  @ApiProperty({ format: 'uuid' }) maker_id!: string;
  @ApiProperty({ type: String, nullable: true }) checker_id!: string | null;
  @ApiProperty() required_role!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ format: 'date-time' }) expires_at!: string;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
}
export class ApprovalPageView {
  @ApiProperty({ type: [ApprovalView] }) items!: ApprovalView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ReconciliationView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() severity!: string;
  @ApiProperty() aggregate_type!: string;
  @ApiProperty() aggregate_id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) details!: Record<string, unknown>;
  @ApiProperty() status!: string;
  @ApiProperty({ type: String, nullable: true }) resolved_by!: string | null;
  @ApiProperty({ type: String, nullable: true }) resolved_at!: string | null;
  @ApiProperty({ format: 'date-time' }) created_at!: string;
}
export class FailedJobView {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() attempts!: number;
  @ApiPropertyOptional() failedAt?: number;
}
export class OutboxStatusView {
  @ApiProperty() pending!: string;
  @ApiProperty() suspended!: string;
  @ApiProperty({ type: String, nullable: true }) oldest_pending!: string | null;
  @ApiProperty({ type: String, nullable: true }) latest_processed!: string | null;
}
