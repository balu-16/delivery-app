import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  RIDER_ONBOARDING_SUPPORT,
  RiderOnboardingSupport,
} from './rider-onboarding-support.service.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import { P11PageDto } from '../../p11-dto.js';

class OnboardingTicketBodyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
}

@Controller('v1/rider/onboarding')
@ApiBearerAuth()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'rider', allowPendingRider: true })
@UseGuards(IdentityGuard)
export class RiderOnboardingSupportController {
  constructor(
    @Inject(RIDER_ONBOARDING_SUPPORT)
    private readonly support: RiderOnboardingSupport,
  ) {}
  @Post('tickets')
  @ApiOperation({ operationId: 'riderCreateOnboardingTicket' })
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() body: OnboardingTicketBodyDto,
    @Headers('idempotency-key') reference?: string,
  ) {
    return { id: await this.support.create(principal.userId, body.body, reference) };
  }
  @Get('tickets')
  @ApiOperation({ operationId: 'riderListOnboardingTickets' })
  list(@CurrentPrincipal() principal: Principal, @Query() page: P11PageDto) {
    return this.support.list(principal.userId, page.cursor, page.limit);
  }
  @Get('tickets/:id')
  @ApiOperation({ operationId: 'riderGetOnboardingTicket' })
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query() page: P11PageDto,
  ) {
    return this.support.detail(principal.userId, id, page.cursor, page.limit);
  }
  @Post('tickets/:id/messages')
  @ApiOperation({ operationId: 'riderOnboardingTicketMessage' })
  async message(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body() body: OnboardingTicketBodyDto,
    @Headers('idempotency-key') reference?: string,
  ) {
    return { id: await this.support.message(principal.userId, id, body.body, reference) };
  }
}
