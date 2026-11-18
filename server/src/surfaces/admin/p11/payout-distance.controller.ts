import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Length, Max, Min } from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { PAYOUTS, type Payouts } from '../../../modules/payouts/contracts/payouts.js';

class DistanceReviewDto {
  @ApiProperty({ minimum: 0, maximum: 500000 })
  @IsInt()
  @Min(0)
  @Max(500000)
  distanceMetres!: number;
  @ApiProperty({ minLength: 1, maxLength: 300 }) @IsString() @Length(1, 300) reason!: string;
}
class DistanceReviewView {
  @ApiProperty({ format: 'uuid' }) earningId!: string;
  @ApiProperty({ format: 'uuid' }) orderId!: string;
  @ApiProperty({ format: 'uuid' }) riderId!: string;
  @ApiProperty() riderName!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() ratePaise!: string;
}
@Controller('v1/admin/rider-distance-reviews')
@ApiBearerAuth()
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
export class AdminDistanceReviewController {
  constructor(@Inject(PAYOUTS) private readonly payouts: Payouts) {}
  @Get()
  @ApiOkResponse({ type: DistanceReviewView, isArray: true })
  @ApiOperation({ operationId: 'adminPendingRiderDistances' })
  list(@CurrentPrincipal() p: Principal) {
    return this.payouts.pendingDistances(p.userId);
  }
  @Post(':earningId')
  @ApiOperation({ operationId: 'adminReviewRiderDistance' })
  async review(
    @CurrentPrincipal() p: Principal,
    @Param('earningId', new ParseUUIDPipe()) id: string,
    @Body() body: DistanceReviewDto,
  ) {
    try {
      await this.payouts.reviewDistance(p.userId, id, body.distanceMetres, body.reason);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const status =
        code === 'FORBIDDEN'
          ? 403
          : code === 'RESOURCE_NOT_FOUND'
            ? 404
            : ['DISTANCE_REVIEW_NOT_REQUIRED', 'DISTANCE_ALREADY_REVIEWED'].includes(code)
              ? 409
              : code === 'INVALID_INPUT'
                ? 400
                : 0;
      if (status) throw new HttpException({ code }, status);
      throw error;
    }
  }
}
