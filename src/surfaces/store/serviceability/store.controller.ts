import { Body, Controller, HttpException, Inject, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { uuidV7 } from '../../../common/ids/ids.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { STORE_MANAGEMENT } from '../../../modules/stores/contracts/tokens.js';
import type { StoreManagement } from '../../../modules/stores/contracts/management.js';

class StoreStatusDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty({ enum: ['ONLINE', 'PAUSED'] }) @IsIn(['ONLINE', 'PAUSED']) status!:
    'ONLINE' | 'PAUSED';
  @ApiPropertyOptional({ minLength: 1, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}
@Controller('v1/store')
@ApiBearerAuth()
@ApiResponse({ status: 400, description: 'Invalid status or missing pause reason' })
@ApiResponse({ status: 401, description: 'Invalid token' })
@ApiResponse({ status: 403, description: 'Store role required' })
@ApiResponse({ status: 404, description: 'Store not assigned' })
@AuthPolicy({ audience: 'store', roles: ['STORE_MANAGER'] })
@UseGuards(IdentityGuard)
export class StoreStatusController {
  constructor(@Inject(STORE_MANAGEMENT) private readonly stores: StoreManagement) {}
  @Post('status')
  @ApiOperation({ operationId: 'storeSetStatus' })
  async status(
    @CurrentPrincipal() principal: Principal,
    @Body() body: StoreStatusDto,
  ): Promise<void> {
    try {
      await this.stores.setStatus({
        storeId: body.storeId,
        actorId: principal.userId,
        status: body.status,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
        admin: false,
        correlationId: uuidV7(),
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const status =
        code === 'FORBIDDEN'
          ? 403
          : code === 'STORE_NOT_FOUND'
            ? 404
            : code === 'INVALID_PAUSE_REASON'
              ? 400
              : 0;
      if (status) throw new HttpException({ code }, status);
      throw error;
    }
  }
}
