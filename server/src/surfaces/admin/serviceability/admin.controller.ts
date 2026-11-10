import {
  Body,
  Controller,
  Delete,
  HttpException,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
} from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { uuidV7 } from '../../../common/ids/ids.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { APP_CONFIG, type AppConfig } from '../../../modules/app-config/contracts/config.js';
import { STORE_MANAGEMENT, ZONES } from '../../../modules/stores/contracts/tokens.js';
import type { StoreManagement } from '../../../modules/stores/contracts/management.js';
import type { Zones } from '../../../modules/stores/contracts/zones.js';

class ZoneDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty({ minLength: 1, maxLength: 120, pattern: '\\S' })
  @IsString()
  @Length(1, 120)
  @Matches(/\S/)
  name!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'GeoJSON Polygon or MultiPolygon in WGS84',
  })
  @IsObject()
  geometry!: object;
  @ApiProperty({ type: 'integer' }) @IsInt() priority!: number;
  @ApiProperty({ type: Boolean }) @IsBoolean() active!: boolean;
}
class UpdateZoneDto extends ZoneDto {
  @ApiProperty({ pattern: '^[1-9]\\d*$' }) @IsString() @Matches(/^[1-9]\d*$/) version!: string;
}
class VersionQuery {
  @ApiProperty({ pattern: '^[1-9]\\d*$' }) @IsString() @Matches(/^[1-9]\d*$/) version!: string;
}
class ZoneVersionView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() version!: string;
  @ApiProperty() cityZoneVersion!: string;
}
class AdminStatusDto {
  @ApiProperty({ enum: ['ONLINE', 'PAUSED'] }) @IsIn(['ONLINE', 'PAUSED']) status!:
    'ONLINE' | 'PAUSED';
  @ApiPropertyOptional({ minLength: 1, maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}
async function response<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const status =
      code === 'FORBIDDEN'
        ? 403
        : ['STORE_NOT_FOUND', 'ZONE_NOT_FOUND'].includes(code)
          ? 404
          : ['CONCURRENT_MODIFICATION', 'ZONE_STORE_IMMUTABLE'].includes(code)
            ? 409
            : [
                  'INVALID_ZONE',
                  'INVALID_ZONE_GEOMETRY',
                  'ZONE_OUTSIDE_BOUNDS_OR_AREA',
                  'INVALID_PAUSE_REASON',
                ].includes(code)
              ? 400
              : 0;
    if (status) throw new HttpException({ code }, status);
    throw error;
  }
}
@Controller('v1/admin')
@ApiBearerAuth()
@ApiResponse({ status: 400, description: 'Invalid input or geometry' })
@ApiResponse({ status: 401, description: 'Invalid token' })
@ApiResponse({ status: 403, description: 'Admin role required' })
@ApiResponse({ status: 404, description: 'Resource not found' })
@ApiResponse({ status: 409, description: 'Version conflict' })
@AuthPolicy({ audience: 'admin', roles: ['ADMIN', 'SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
export class AdminServiceabilityController {
  constructor(
    @Inject(ZONES) private readonly zones: Zones,
    @Inject(STORE_MANAGEMENT) private readonly stores: StoreManagement,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}
  private async area() {
    return {
      minM2: await this.config.get('zoneMinAreaM2'),
      maxM2: await this.config.get('zoneMaxAreaM2'),
    };
  }
  @Post('zones')
  @ApiCreatedResponse({ type: ZoneVersionView })
  @ApiOperation({ operationId: 'adminCreateZone' })
  create(@CurrentPrincipal() principal: Principal, @Body() body: ZoneDto) {
    return response(async () => this.zones.create(body, await this.area(), principal.userId));
  }
  @Patch('zones/:id')
  @ApiOkResponse({ type: ZoneVersionView })
  @ApiOperation({ operationId: 'adminUpdateZone' })
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateZoneDto,
  ) {
    return response(async () =>
      this.zones.update(id, body.version, body, await this.area(), principal.userId),
    );
  }
  @Delete('zones/:id')
  @ApiOkResponse({ type: ZoneVersionView })
  @ApiOperation({ operationId: 'adminDeactivateZone' })
  deactivate(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query() query: VersionQuery,
  ) {
    return response(() => this.zones.deactivate(id, query.version, principal.userId));
  }
  @Post('stores/:id/status')
  @ApiOperation({ operationId: 'adminSetStoreStatus' })
  status(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: AdminStatusDto,
  ) {
    return response(() =>
      this.stores.setStatus({
        storeId: id,
        actorId: principal.userId,
        status: body.status,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
        admin: true,
        correlationId: uuidV7(),
      }),
    );
  }
}
