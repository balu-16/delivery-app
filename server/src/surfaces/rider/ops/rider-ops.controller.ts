import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  IsISO8601,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  DeliveryApiErrors,
  DeliveryErrorInterceptor,
} from '../../../modules/dispatch/contracts/swagger.js';
import {
  RIDER_CASH,
  RIDER_EARNINGS,
  RIDER_OPERATIONS,
  type RiderCash,
  type RiderEarnings,
  type RiderOperations,
} from '../../../modules/riders/contracts/riders.js';
import { LOCATION_INGEST } from '../../../modules/tracking/contracts/tokens.js';
import type {
  LocationIngest,
  LocationPointInput,
} from '../../../modules/tracking/contracts/tracking.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';

class HeartbeatDto {
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-90) @Max(90) lat?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(-180) @Max(180) lng?: number;
}
class BreakDto {
  @ApiProperty() @IsBoolean() onBreak!: boolean;
}

class LocationPointDto {
  @ApiProperty({ format: 'date-time' }) @IsISO8601() ts!: string;
  @ApiProperty({ minimum: -90, maximum: 90 })
  @Type(() => Number)
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;
  @ApiProperty({ minimum: -180, maximum: 180 })
  @Type(() => Number)
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(0) accuracyM?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(0) speedMps?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isMock?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  batteryPct?: number;
}

class LocationBatchDto {
  @ApiProperty({ type: [LocationPointDto], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => LocationPointDto)
  points!: LocationPointDto[];
}

class EarningsQueryDto {
  @ApiPropertyOptional({ maxLength: 512 }) @IsOptional() @IsString() cursor?: string;
  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

@Controller('v1/rider')
@ApiBearerAuth()
@DeliveryApiErrors()
@UseInterceptors(DomainErrorInterceptor, DeliveryErrorInterceptor)
@AuthPolicy({ audience: 'rider', roles: ['RIDER'] })
@UseGuards(IdentityGuard)
export class RiderOpsController {
  @Post('status/break')
  @ApiOperation({ operationId: 'riderSetBreak' })
  setBreak(@CurrentPrincipal() p: Principal, @Body() body: BreakDto) {
    return this.riders.setBreak(p.userId, body.onBreak);
  }
  constructor(
    @Inject(RIDER_OPERATIONS) private readonly riders: RiderOperations,
    @Inject(LOCATION_INGEST) private readonly ingest: LocationIngest,
    @Inject(RIDER_EARNINGS) private readonly earnings: RiderEarnings,
    @Inject(RIDER_CASH) private readonly cash: RiderCash,
  ) {}

  @Post('status/online')
  @ApiOperation({ operationId: 'riderGoOnline' })
  online(@CurrentPrincipal() p: Principal) {
    return this.riders.goOnline(p.userId, 'status-online');
  }

  @Post('status/offline')
  @ApiOperation({ operationId: 'riderGoOffline' })
  offline(@CurrentPrincipal() p: Principal) {
    return this.riders.goOffline(p.userId, 'status-offline');
  }

  @Post('heartbeat')
  @ApiOperation({ operationId: 'riderHeartbeat' })
  heartbeat(@CurrentPrincipal() p: Principal, @Body() body: HeartbeatDto) {
    return this.riders.heartbeat(p.userId, body);
  }

  @Post('location')
  @ApiOperation({ operationId: 'riderLocation' })
  location(@CurrentPrincipal() p: Principal, @Body() body: LocationBatchDto) {
    const points: LocationPointInput[] = body.points.map((point) => ({
      ts: point.ts,
      lat: point.lat,
      lng: point.lng,
      accuracyM: point.accuracyM,
      speedMps: point.speedMps,
      isMock: point.isMock,
      batteryPct: point.batteryPct,
    }));
    return this.ingest.ingestBatch(p.userId, points);
  }

  @Get('earnings')
  @ApiOperation({ operationId: 'riderEarnings' })
  earningsList(@CurrentPrincipal() p: Principal, @Query() q: EarningsQueryDto) {
    return this.earnings.forRider(p.userId, q.cursor, q.limit);
  }

  @Get('cash-in-hand')
  @ApiOperation({ operationId: 'riderCashInHand' })
  cashInHand(@CurrentPrincipal() p: Principal) {
    return this.cash.cashInHand(p.userId);
  }
}
