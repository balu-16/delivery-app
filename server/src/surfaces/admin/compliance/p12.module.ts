import {
  Body,
  Controller,
  Get,
  Inject,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  ADMIN_COMPLIANCE_OPERATIONS,
  ADMIN_QUEUE_OPERATIONS,
  type AdminComplianceOperationsContract,
  type AdminQueueOperationsContract,
} from '../../../modules/compliance/contracts/operations.js';
import { ComplianceOperationsModule } from '../../../modules/compliance/compliance-operations.module.js';
import { ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import {
  ApprovalIdView,
  ExportIdView,
  AdminErasurePageView,
  AdminErasureView,
  FraudPageView,
  FraudDetailView,
  ApprovalPageView,
  ApprovalView,
  ReconciliationView,
  FailedJobView,
  OutboxStatusView,
} from '../../../modules/compliance/contracts/swagger.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  PRIVACY_OPERATIONS,
  type PrivacyOperations,
} from '../../../modules/compliance/contracts/privacy.js';

class PageDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
class ReasonDto {
  @ApiProperty() @IsString() @Length(1, 300) reason!: string;
}
class ReviewDto {
  @ApiProperty({ enum: ['ACKNOWLEDGED', 'DISMISSED', 'ESCALATED', 'RESOLVED', 'REJECTED'] })
  @IsIn(['ACKNOWLEDGED', 'DISMISSED', 'ESCALATED', 'RESOLVED', 'REJECTED'])
  decision!: string;
  @ApiProperty() @IsString() @Length(1, 300) reason!: string;
}
@Controller('v1/admin')
@ApiBearerAuth()
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
export class AdminComplianceController {
  constructor(
    @Inject(ADMIN_COMPLIANCE_OPERATIONS)
    private readonly operations: AdminComplianceOperationsContract,
    @Inject(PRIVACY_OPERATIONS) private readonly privacy: PrivacyOperations,
    @Inject(ADMIN_QUEUE_OPERATIONS) private readonly queue: AdminQueueOperationsContract,
  ) {}
  @Post('users/:id/erasure-requests')
  @ApiOperation({ operationId: 'adminWorkforceErasureRequest' })
  @ApiCreatedResponse({ type: ApprovalIdView })
  async erasureRequest(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return { approvalId: await this.privacy.requestWorkforce(p.userId, id) };
  }
  @Post('erasure-approvals/:id/approve')
  @ApiOperation({ operationId: 'adminWorkforceErasureApprove' })
  erasureApprove(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.privacy.approveWorkforce(p.userId, id);
  }
  @Get('erasure-requests')
  @ApiOperation({ operationId: 'adminErasureRequests' })
  @ApiOkResponse({ type: AdminErasurePageView })
  erasureList(@Query() q: PageDto) {
    return this.privacy.adminList(q.cursor, q.limit ?? 50);
  }
  @Get('erasure-requests/:id')
  @ApiOperation({ operationId: 'adminErasureStatus' })
  @ApiOkResponse({ type: AdminErasureView })
  erasureStatus(@Param('id', ParseUUIDPipe) id: string) {
    return this.privacy.adminStatus(id);
  }
  @Post('erasure-requests/:id/retry')
  @ApiOperation({ operationId: 'adminErasureRetry' })
  erasureRetry(@CurrentPrincipal() p: Principal, @Param('id', ParseUUIDPipe) id: string) {
    return this.privacy.retry(p.userId, id);
  }
  @Post('users/:id/legal-holds')
  @ApiOperation({ operationId: 'adminLegalHoldCreate' })
  @ApiCreatedResponse({ type: ExportIdView })
  async createHold(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return { id: await this.privacy.createHold(p.userId, id, body.reason) };
  }
  @Post('legal-holds/:id/release')
  @ApiOperation({ operationId: 'adminLegalHoldRelease' })
  releaseHold(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ) {
    return this.privacy.releaseHold(p.userId, id, body.reason);
  }
  @Get('ops/failed-jobs/:concern')
  @ApiOperation({ operationId: 'adminFailedJobs' })
  @ApiOkResponse({ type: [FailedJobView] })
  failedJobs(@Param('concern') concern: string) {
    return this.queue.failed(concern);
  }
  @Post('ops/failed-jobs/:concern/:id/replay')
  @ApiOperation({ operationId: 'adminFailedJobReplay' })
  replayJob(
    @CurrentPrincipal() p: Principal,
    @Param('concern') concern: string,
    @Param('id') id: string,
    @Body() body: ReasonDto,
  ) {
    return this.queue.replay(concern, id, p.userId, body.reason);
  }
  @Get('ops/outbox')
  @ApiOperation({ operationId: 'adminOutboxStatus' })
  @ApiOkResponse({ type: OutboxStatusView })
  outbox() {
    return this.queue.outbox();
  }
  @Post('ops/outbox/:id/:consumer/replay')
  @ApiOperation({ operationId: 'adminOutboxReplay' })
  replayOutbox(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('consumer') consumer: string,
    @Body() body: ReasonDto,
  ) {
    return this.queue.replayOutbox(id, consumer, p.userId, body.reason);
  }
  @Get('fraud-signals')
  @ApiOperation({ operationId: 'adminFraudSignals' })
  @ApiOkResponse({ type: FraudPageView })
  fraud(@Query() q: PageDto) {
    return this.operations.list('fraud', q.cursor, q.limit ?? 50);
  }
  @Get('fraud-signals/:id')
  @ApiOperation({ operationId: 'adminFraudSignal' })
  @ApiOkResponse({ type: FraudDetailView })
  fraudDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.operations.detail('fraud', id);
  }
  @Post('fraud-signals/:id/review')
  @ApiOperation({ operationId: 'adminFraudReview' })
  fraudReview(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewDto,
  ) {
    return this.operations.review('fraud', id, p.userId, body.decision, body.reason);
  }
  @Get('payments/reconciliation/:id')
  @ApiOperation({ operationId: 'adminReconciliationDetail' })
  @ApiOkResponse({ type: ReconciliationView })
  reconciliation(@Param('id', ParseUUIDPipe) id: string) {
    return this.operations.detail('reconciliation', id);
  }
  @Post('payments/reconciliation/:id/review')
  @ApiOperation({ operationId: 'adminReconciliationReview' })
  reconciliationReview(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewDto,
  ) {
    return this.operations.review('reconciliation', id, p.userId, body.decision, body.reason);
  }
  @Get('approvals')
  @ApiOperation({ operationId: 'adminApprovals' })
  @ApiOkResponse({ type: ApprovalPageView })
  approvals(@Query() q: PageDto) {
    return this.operations.list('approval', q.cursor, q.limit ?? 50);
  }
  @Get('approvals/:id')
  @ApiOperation({ operationId: 'adminApprovalDetail' })
  @ApiOkResponse({ type: ApprovalView })
  approval(@Param('id', ParseUUIDPipe) id: string) {
    return this.operations.detail('approval', id);
  }
  @Post('approvals/:id/reject')
  @ApiOperation({ operationId: 'adminApprovalReject' })
  reject(
    @CurrentPrincipal() p: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReviewDto,
  ) {
    return this.operations.review('approval', id, p.userId, body.decision, body.reason);
  }
}
@Module({
  imports: [IdentityModule, ComplianceOperationsModule],
  controllers: [AdminComplianceController],
})
export class AdminComplianceSurfaceModule {}
