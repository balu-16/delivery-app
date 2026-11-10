import {
  Body,
  Controller,
  Get,
  HttpException,
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
import { RATINGS, type Ratings } from '../../../modules/ratings/contracts/ratings.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  TicketCreateDto,
  TicketMessageDto,
  TicketUpdateDto,
  UploadDto,
  RatingDto,
  EditRatingDto,
  P11PageDto,
} from '../../p11-dto.js';
@Controller('v1/customer')
@ApiBearerAuth()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'customer', roles: ['CUSTOMER'] })
@UseGuards(IdentityGuard)
export class CustomerP11Controller {
  constructor(
    @Inject(SUPPORT) private readonly support: Support,
    @Inject(RATINGS) private readonly ratings: Ratings,
  ) {}
  @Post('tickets') @ApiOperation({ operationId: 'customerCreateTicket' }) async create(
    @CurrentPrincipal() p: Principal,
    @Body() body: TicketCreateDto,
    @Headers('idempotency-key') reference?: string,
  ) {
    return { id: await this.support.create(p.userId, { ...body, reference }) };
  }
  @Get('tickets') @ApiOperation({ operationId: 'customerListTickets' }) list(
    @CurrentPrincipal() p: Principal,
    @Query('cursor') cursor?: string,
  ) {
    return this.support.list(p.userId, false, cursor);
  }
  @Get('tickets/:id') @ApiOperation({ operationId: 'customerGetTicket' }) get(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Query() page: P11PageDto,
  ) {
    return this.support.detail(p.userId, id, false, page.cursor, page.limit);
  }
  @Post('tickets/:id/messages')
  @ApiOperation({ operationId: 'customerTicketMessage' })
  async message(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: TicketMessageDto,
    @Headers('idempotency-key') reference?: string,
  ) {
    return { id: await this.support.message(p.userId, id, { ...body, reference }) };
  }
  @Patch('tickets/:id') @ApiOperation({ operationId: 'customerUpdateTicket' }) async update(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: TicketUpdateDto,
  ) {
    await this.support.update(p.userId, id, body);
    return { updated: true };
  }
  @Post('tickets/:id/reopen')
  @ApiOperation({ operationId: 'customerReopenTicket' })
  async reopen(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    await this.support.update(p.userId, id, { status: 'OPEN' });
    return { reopened: true };
  }
  @Post('ticket-attachments') @ApiOperation({ operationId: 'customerTicketUploadTarget' }) target(
    @CurrentPrincipal() p: Principal,
    @Body() body: UploadDto,
  ) {
    return this.support.uploadTarget(p.userId, body.contentType, body.size);
  }
  @Get('tickets/:id/attachments/:mediaId')
  @ApiOperation({ operationId: 'customerTicketAttachment' })
  async attachment(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
  ) {
    return { url: await this.support.attachmentUrl(p.userId, id, mediaId) };
  }
  @Get('ratings/:type/:targetId/aggregate')
  @ApiOperation({ operationId: 'customerRatingAggregate' })
  async aggregate(@Param('type') type: string, @Param('targetId') targetId: string) {
    if (!['ORDER', 'RIDER', 'PRODUCT'].includes(type) || !/^[0-9a-f-]{36}$/i.test(targetId))
      throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return {
      aggregate: await this.ratings.aggregate(type as 'ORDER' | 'RIDER' | 'PRODUCT', targetId),
    };
  }
  @Post('orders/:id/rate') @ApiOperation({ operationId: 'customerRateOrder' }) async rate(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() body: RatingDto,
  ) {
    return { id: await this.ratings.create(p.userId, id, body) };
  }
  @Patch('orders/:id/ratings/:ratingId')
  @ApiOperation({ operationId: 'customerEditRating' })
  async edit(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Param('ratingId') ratingId: string,
    @Body() body: EditRatingDto,
  ) {
    await this.ratings.edit(p.userId, id, ratingId, body);
    return { updated: true };
  }
}
