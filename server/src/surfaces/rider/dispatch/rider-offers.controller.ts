import {
  Body,
  Controller,
  Get,
  Headers,
  HttpException,
  Inject,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  DeliveryApiErrors,
  DeliveryErrorInterceptor,
  DeliveryIdempotencyHeader,
  DeliveryTaskView,
  OfferPageView,
} from '../../../modules/dispatch/contracts/swagger.js';
import { DELIVERY_TASKS, type DeliveryTasks } from '../../../modules/dispatch/contracts/tasks.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';

class DeclineDto {
  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  reason?: string;
}

export function requireKey(header?: string): string {
  if (!header || header.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
  return header;
}

@Controller('v1/rider')
@ApiBearerAuth()
@DeliveryApiErrors()
@UseInterceptors(DomainErrorInterceptor, DeliveryErrorInterceptor)
@AuthPolicy({ audience: 'rider', roles: ['RIDER'] })
@UseGuards(IdentityGuard)
export class RiderOffersController {
  constructor(@Inject(DELIVERY_TASKS) private readonly tasks: DeliveryTasks) {}

  @Get('offers')
  @ApiOperation({ operationId: 'riderListOffers' })
  @ApiOkResponse({ type: OfferPageView })
  offers(@CurrentPrincipal() p: Principal) {
    return this.tasks.offers(p.userId);
  }

  @Post('offers/:id/accept')
  @ApiOperation({ operationId: 'riderAcceptOffer' })
  @DeliveryIdempotencyHeader()
  @ApiOkResponse({ type: DeliveryTaskView })
  accept(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.tasks.accept(p.userId, id, requireKey(keyHeader));
  }

  @Post('offers/:id/decline')
  @ApiOperation({ operationId: 'riderDeclineOffer' })
  @DeliveryIdempotencyHeader()
  decline(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
    @Body() _body: DeclineDto,
    @Headers('idempotency-key') keyHeader?: string,
  ) {
    return this.tasks.decline(p.userId, id, requireKey(keyHeader));
  }

  @Get('tasks/current')
  @ApiOperation({ operationId: 'riderCurrentTask' })
  @ApiOkResponse({ type: DeliveryTaskView, nullable: true })
  current(@CurrentPrincipal() p: Principal) {
    return this.tasks.currentTask(p.userId);
  }
}
