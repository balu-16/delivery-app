import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  PRIVATE_UPLOADS,
  type PrivateUploadPort,
} from '../../../modules/identity/contracts/uploads.js';
import { SUPPORT, type Support } from '../../../modules/support/contracts/support.js';
import { RATINGS, type Ratings } from '../../../modules/ratings/contracts/ratings.js';
import { PAYOUTS, type Payouts } from '../../../modules/payouts/contracts/payouts.js';
import {
  PAYMENT_REFUNDS,
  type PaymentRefundOperations,
} from '../../../modules/payments/contracts/payments.js';
import {
  ORDER_ADMINISTRATION,
  type OrderAdministration,
} from '../../../modules/orders/contracts/administration.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  TicketMessageDto,
  TicketUpdateDto,
  UploadDto,
  ModerateRatingDto,
  PaidDto,
  SupportRefundDto,
  CannedResponseDto,
  PayoutCorrectionDto,
  P11PageDto,
} from '../../p11-dto.js';
@Controller('v1/admin')
@ApiBearerAuth()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'admin', roles: ['SUPPORT_AGENT', 'ADMIN', 'SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
export class AdminP11Controller {
  constructor(
    @Inject(SUPPORT) private readonly support: Support,
    @Inject(RATINGS) private readonly ratings: Ratings,
    @Inject(PAYOUTS) private readonly payouts: Payouts,
    @Inject(PRIVATE_UPLOADS) private readonly uploads: PrivateUploadPort,
    @Inject(PAYMENT_REFUNDS) private readonly refunds: PaymentRefundOperations,
    @Inject(ORDER_ADMINISTRATION) private readonly orderAdmin: OrderAdministration,
  ) {}
  @Get('canned-responses')
  @ApiOperation({ operationId: 'adminListCannedResponses' })
  canned(@CurrentPrincipal() p: Principal, @Query() page: P11PageDto) {
    return this.support.canned(p.userId, page.cursor, page.limit);
  }
  @Post('canned-responses')
  @ApiOperation({ operationId: 'adminSaveCannedResponse' })
  async saveCanned(@CurrentPrincipal() p: Principal, @Body() body: CannedResponseDto) {
    return { id: await this.support.saveCanned(p.userId, body) };
  }
  @Get('tickets') @ApiOperation({ operationId: 'adminListTickets' }) list(
    @CurrentPrincipal() p: Principal,
    @Query('cursor') cursor?: string,
  ) {
    return this.support.list(p.userId, true, cursor);
  }
  @Get('tickets/:id') @ApiOperation({ operationId: 'adminGetTicket' }) get(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Query() page: P11PageDto,
  ) {
    return this.support.detail(p.userId, id, true, page.cursor, page.limit);
  }
  @Post('tickets/:id/messages') @ApiOperation({ operationId: 'adminTicketMessage' }) async message(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: TicketMessageDto,
    @Headers('idempotency-key') reference?: string,
  ) {
    return { id: await this.support.message(p.userId, id, { ...body, reference }) };
  }
  @Patch('tickets/:id') @ApiOperation({ operationId: 'adminUpdateTicket' }) async update(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: TicketUpdateDto,
  ) {
    await this.support.update(p.userId, id, body);
    return { updated: true };
  }
  @Post('ticket-attachments') @ApiOperation({ operationId: 'adminTicketUploadTarget' }) target(
    @CurrentPrincipal() p: Principal,
    @Body() body: UploadDto,
  ) {
    return this.support.uploadTarget(p.userId, body.contentType, body.size);
  }
  @Get('tickets/:id/attachments/:mediaId')
  @ApiOperation({ operationId: 'adminTicketAttachment' })
  async attachment(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
  ) {
    return { url: await this.support.attachmentUrl(p.userId, id, mediaId) };
  }
  @Patch('ratings/:id/moderation')
  @ApiOperation({ operationId: 'adminModerateRating' })
  async moderate(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: ModerateRatingDto,
  ) {
    await this.ratings.moderate(p.userId, id, body.hidden, body.reason);
    return { updated: true };
  }
  @Post('tickets/:id/refunds')
  @ApiOperation({ operationId: 'adminTicketRefund' })
  async ticketRefund(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: SupportRefundDto,
  ) {
    const orderId = await this.support.orderForStaff(p.userId, id);
    const input = { amountPaise: body.amountPaise, reason: body.reason };
    const reference = `${id}:${body.idempotencyKey}`;
    const approvalId = p.roles.includes('ADMIN')
      ? await this.orderAdmin.requestTicketAdminRefund(p.userId, orderId, input, reference)
      : await this.orderAdmin.requestSupportRefund(p.userId, orderId, input, reference);
    return approvalId.startsWith('direct:')
      ? { status: 'COMMITTED', reference: approvalId.slice(7) }
      : { status: 'APPROVAL_REQUIRED', approvalId };
  }
  @Post('ticket-refund-approvals/:id/execute')
  @ApiOperation({ operationId: 'adminExecuteTicketRefundApproval' })
  async executeTicketRefund(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.orderAdmin.approve(p.userId, id);
    return { approved: true };
  }
  @Get('payouts') @ApiOperation({ operationId: 'adminListPayouts' }) payoutsList(
    @CurrentPrincipal() p: Principal,
    @Query('cursor') cursor?: string,
  ) {
    return this.payouts.list(p.userId, cursor);
  }
  @Post('payouts/:id/approval')
  @ApiOperation({ operationId: 'adminRequestPayoutApproval' })
  async requestApproval(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return { approvalId: await this.payouts.requestApproval(p.userId, id) };
  }
  @Post('payout-approvals/:id/execute')
  @ApiOperation({ operationId: 'adminExecutePayoutApproval' })
  async approve(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.payouts.approve(p.userId, id);
    return { approved: true };
  }
  @Get('payouts/:id/corrections')
  @ApiOperation({ operationId: 'adminListPayoutCorrections' })
  listCorrections(
    @CurrentPrincipal() p: Principal,
    @Param('id') payoutId: string,
    @Query() page: P11PageDto,
  ) {
    return this.payouts.listCorrections(p.userId, payoutId, page.cursor, page.limit);
  }
  @Post('payouts/:id/corrections')
  @ApiOperation({ operationId: 'adminRequestPayoutCorrection' })
  async requestCorrection(
    @CurrentPrincipal() p: Principal,
    @Param('id') payoutId: string,
    @Body() body: PayoutCorrectionDto,
  ) {
    return {
      approvalId: await this.payouts.requestCorrection({ actorId: p.userId, payoutId, ...body }),
    };
  }
  @Post('payout-corrections/:id/settled')
  @ApiOperation({ operationId: 'adminSettlePayoutCorrection' })
  async settleCorrection(
    @CurrentPrincipal() p: Principal,
    @Param('id') correctionId: string,
    @Body() body: PaidDto,
  ) {
    await this.uploads.assertOwnedRegistered(p.userId, body.evidenceMediaId, 'PAYOUT_EVIDENCE');
    await this.payouts.settleCorrection({ actorId: p.userId, correctionId, ...body });
    return { settled: true };
  }
  @Post('payouts/:id/cancel') @ApiOperation({ operationId: 'adminCancelPayout' }) async cancel(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
  ) {
    await this.payouts.cancel(p.userId, id);
    return { cancelled: true };
  }
  @Post('payout-evidence') @ApiOperation({ operationId: 'adminPayoutEvidenceTarget' }) evidence(
    @CurrentPrincipal() p: Principal,
    @Body() body: UploadDto,
  ) {
    return this.uploads.createTarget(p.userId, 'PAYOUT_EVIDENCE', body.contentType, body.size);
  }
  @Post('payouts/:id/paid') @ApiOperation({ operationId: 'adminMarkPayoutPaid' }) async paid(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: PaidDto,
  ) {
    await this.uploads.assertOwnedRegistered(p.userId, body.evidenceMediaId, 'PAYOUT_EVIDENCE');
    await this.payouts.markPaid({ actorId: p.userId, payoutId: id, ...body });
    return { paid: true };
  }
  @Post('refunds/:reference/manual-paid')
  @ApiOperation({ operationId: 'adminMarkManualRefundPaid' })
  async refundPaid(
    @CurrentPrincipal() p: Principal,
    @Param('reference') reference: string,
    @Body() body: PaidDto,
  ) {
    await this.uploads.assertOwnedRegistered(p.userId, body.evidenceMediaId, 'PAYOUT_EVIDENCE');
    return this.refunds.markManualRefundPaid({
      actorId: p.userId,
      refundReference: reference,
      ...body,
    });
  }
}
