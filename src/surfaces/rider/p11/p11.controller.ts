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
import { SUPPORT, type Support } from '../../../modules/support/contracts/support.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  TicketCreateDto,
  TicketMessageDto,
  TicketUpdateDto,
  UploadDto,
  P11PageDto,
} from '../../p11-dto.js';
@Controller('v1/rider')
@ApiBearerAuth()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'rider', roles: ['RIDER'] })
@UseGuards(IdentityGuard)
export class RiderP11Controller {
  constructor(@Inject(SUPPORT) private readonly support: Support) {}
  @Post('tickets') @ApiOperation({ operationId: 'riderCreateTicket' }) async create(
    @CurrentPrincipal() p: Principal,
    @Body() body: TicketCreateDto,
    @Headers('idempotency-key') reference?: string,
  ) {
    return { id: await this.support.create(p.userId, { ...body, reference }) };
  }
  @Get('tickets') @ApiOperation({ operationId: 'riderListTickets' }) list(
    @CurrentPrincipal() p: Principal,
    @Query('cursor') cursor?: string,
  ) {
    return this.support.list(p.userId, false, cursor);
  }
  @Get('tickets/:id') @ApiOperation({ operationId: 'riderGetTicket' }) get(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Query() page: P11PageDto,
  ) {
    return this.support.detail(p.userId, id, false, page.cursor, page.limit);
  }
  @Post('tickets/:id/messages') @ApiOperation({ operationId: 'riderTicketMessage' }) async message(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: TicketMessageDto,
    @Headers('idempotency-key') reference?: string,
  ) {
    return { id: await this.support.message(p.userId, id, { ...body, reference }) };
  }
  @Patch('tickets/:id') @ApiOperation({ operationId: 'riderUpdateTicket' }) async update(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: TicketUpdateDto,
  ) {
    await this.support.update(p.userId, id, body);
    return { updated: true };
  }
  @Post('tickets/:id/reopen')
  @ApiOperation({ operationId: 'riderReopenTicket' })
  async reopen(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.support.update(p.userId, id, { status: 'OPEN' });
    return { reopened: true };
  }
  @Post('ticket-attachments') @ApiOperation({ operationId: 'riderTicketUploadTarget' }) target(
    @CurrentPrincipal() p: Principal,
    @Body() body: UploadDto,
  ) {
    return this.support.uploadTarget(p.userId, body.contentType, body.size);
  }
  @Get('tickets/:id/attachments/:mediaId')
  @ApiOperation({ operationId: 'riderTicketAttachment' })
  async attachment(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
  ) {
    return { url: await this.support.attachmentUrl(p.userId, id, mediaId) };
  }
}
