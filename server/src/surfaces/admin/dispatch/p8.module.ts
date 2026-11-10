import {
  Module,
  Controller,
  Body,
  Param,
  Post,
  Inject,
  Headers,
  UseGuards,
  UseInterceptors,
  HttpException,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiHeader,
  ApiCreatedResponse,
} from '@nestjs/swagger';
import { IsUUID, IsString, Length } from 'class-validator';
import { IdentityModule } from '../../../modules/identity/identity.module.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { DispatchModule } from '../../../modules/dispatch/dispatch.module.js';
import {
  DELIVERY_ASSIGNMENT,
  WRONG_ADDRESS,
  type DeliveryAssignment,
  type WrongAddress,
} from '../../../modules/dispatch/contracts/tasks.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  DeliveryApiErrors,
  DeliveryErrorInterceptor,
  WrongAddressResolutionView,
} from '../../../modules/dispatch/contracts/swagger.js';
class AssignDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() riderId!: string;
  @ApiProperty({ minLength: 1, maxLength: 300 }) @IsString() @Length(1, 300) reason!: string;
}
class ResolveWrongAddressDto {
  @ApiProperty({ minLength: 1, maxLength: 300 }) @IsString() @Length(1, 300) reason!: string;
}
@Controller('v1/admin/orders')
@ApiBearerAuth()
@DeliveryApiErrors()
@UseGuards(IdentityGuard)
@AuthPolicy({ audience: 'admin', roles: ['ADMIN', 'SUPER_ADMIN'] })
@UseInterceptors(DomainErrorInterceptor, DeliveryErrorInterceptor)
export class AdminDispatchController {
  constructor(
    @Inject(DELIVERY_ASSIGNMENT) private readonly assignment: DeliveryAssignment,
    @Inject(WRONG_ADDRESS) private readonly wrongAddress: WrongAddress,
  ) {}
  @Post(':orderId/reassign-rider')
  @ApiOperation({ operationId: 'adminOrderAssignRider' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  assign(
    @CurrentPrincipal() p: Principal,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() body: AssignDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length > 150) throw new HttpException('IDEMPOTENCY_KEY_REQUIRED', 400);
    return this.assignment.assign(orderId, body.riderId, p.userId, body.reason, key);
  }
  @Post(':orderId/wrong-address/resolve')
  @ApiOperation({ operationId: 'adminResolveWrongAddress' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: WrongAddressResolutionView })
  resolveWrongAddress(
    @CurrentPrincipal() p: Principal,
    @Param('orderId', new ParseUUIDPipe()) orderId: string,
    @Body() body: ResolveWrongAddressDto,
    @Headers('idempotency-key') key?: string,
  ) {
    if (!key || key.length > 150) throw new HttpException('IDEMPOTENCY_KEY_REQUIRED', 400);
    return this.wrongAddress.resolve(p.userId, orderId, body.reason, key);
  }
}
@Module({ imports: [IdentityModule, DispatchModule], controllers: [AdminDispatchController] })
export class AdminDispatchSurfaceModule {}
