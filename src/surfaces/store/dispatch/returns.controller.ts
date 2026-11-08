import {
  Body,
  Controller,
  Headers,
  Inject,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { DELIVERY_RETURN, type DeliveryReturn } from '../../../modules/dispatch/contracts/tasks.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';

class ReturnItemDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() variantId!: string;
  @ApiProperty({ pattern: '^[1-9][0-9]*$' }) @Matches(/^[1-9][0-9]*$/) quantity!: string;
  @ApiProperty({ nullable: true }) @IsOptional() @IsDateString() expiresAt!: string | null;
}
class ReceiveReturnDto {
  @ApiProperty({ maxLength: 300 }) @IsString() @Length(1, 300) reason!: string;
  @ApiProperty({ type: [ReturnItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items!: ReturnItemDto[];
}
@Controller('v1/store')
@ApiBearerAuth()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'store', roles: ['STORE_MANAGER'] })
@UseGuards(IdentityGuard)
export class StoreDeliveryReturnsController {
  constructor(@Inject(DELIVERY_RETURN) private readonly returns: DeliveryReturn) {}
  @Post('orders/:id/return')
  @ApiOperation({ operationId: 'storeDeliveryReturn' })
  receive(
    @CurrentPrincipal() p: Principal,
    @Param('id') orderId: string,
    @Body() body: ReceiveReturnDto,
    @Headers('idempotency-key') key: string,
  ) {
    return this.returns.receive(p.userId, orderId, body.reason, body.items, key);
  }
}
