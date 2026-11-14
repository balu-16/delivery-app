import {
  Controller,
  Headers,
  HttpException,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  INVENTORY_ADJUSTMENTS,
  type InventoryAdjustments,
} from '../../../modules/inventory/contracts/adjustments.js';
import {
  InventoryApiErrors,
  InventoryIdempotencyHeader,
} from '../../../modules/inventory/contracts/swagger.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';

@Controller('v1/admin/inventory')
@ApiBearerAuth()
@InventoryApiErrors()
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class AdminInventoryApprovalController {
  constructor(@Inject(INVENTORY_ADJUSTMENTS) private readonly adjustments: InventoryAdjustments) {}

  @Post('adjustments/:id/approve')
  @ApiOperation({
    operationId: 'adminInventoryApproveAdjustment',
    description:
      'Checker also needs a current STORE_MANAGER assignment at the affected store and must differ from the maker.',
  })
  @InventoryIdempotencyHeader()
  @ApiResponse({ status: 201, description: 'Approval executed or replayed; empty response' })
  approve(
    @CurrentPrincipal() principal: Principal,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length > 150) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    return this.adjustments.approve(principal.userId, id, key);
  }
}
