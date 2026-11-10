import {
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  DeliveryApiErrors,
  DeliveryCodeView,
  DeliveryErrorInterceptor,
  OrderTrackingView,
} from '../../../modules/dispatch/contracts/swagger.js';
import {
  CUSTOMER_TRACKING,
  type CustomerTracking,
} from '../../../modules/dispatch/contracts/tasks.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';

const UUID = /^[0-9a-f-]{36}$/i;

function assertOrderId(orderId: string): string {
  if (!UUID.test(orderId)) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
  return orderId;
}

@Controller('v1/customer/orders')
@ApiBearerAuth()
@DeliveryApiErrors()
@UseInterceptors(DomainErrorInterceptor, DeliveryErrorInterceptor)
@AuthPolicy({ audience: 'customer', roles: ['CUSTOMER'] })
@UseGuards(IdentityGuard)
export class CustomerTrackingController {
  constructor(@Inject(CUSTOMER_TRACKING) private readonly reads: CustomerTracking) {}

  @Get(':id/tracking')
  @ApiOperation({ operationId: 'customerOrderTracking' })
  @ApiOkResponse({ type: OrderTrackingView })
  tracking(@CurrentPrincipal() p: Principal, @Param('id') orderId: string) {
    return this.reads.tracking(assertOrderId(orderId), p.userId);
  }

  @Get(':id/delivery-code')
  @ApiOperation({ operationId: 'customerOrderDeliveryCode' })
  @ApiOkResponse({ type: DeliveryCodeView })
  deliveryCode(@CurrentPrincipal() p: Principal, @Param('id') orderId: string) {
    return this.reads.deliveryCode(assertOrderId(orderId), p.userId);
  }
}
