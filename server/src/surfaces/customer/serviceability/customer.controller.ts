import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpException,
  Inject,
  Optional,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
} from '@nestjs/swagger';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { ADDRESSES } from '../../../modules/addresses/contracts/tokens.js';
import type { AddressOperations } from '../../../modules/addresses/contracts/addresses.js';
import { MAPS, SERVICEABILITY } from '../../../modules/serviceability/contracts/tokens.js';
import type { MapsPort } from '../../../modules/serviceability/contracts/maps.js';
import type { Serviceability } from '../../../modules/serviceability/contracts/serviceability.js';
import { ADMIN_CONFIG, type AdminConfig } from '../../../modules/app-config/contracts/config.js';

class PointQuery {
  @ApiProperty({ type: Number, minimum: -90, maximum: 90 })
  @Type(() => Number)
  @IsLatitude()
  lat!: number;
  @ApiProperty({ type: Number, minimum: -180, maximum: 180 })
  @Type(() => Number)
  @IsLongitude()
  lng!: number;
}
class CoverageQuery {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() addressId?: string;
  @ApiPropertyOptional({ pattern: '^\\d{6}$' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/)
  pincode?: string;
}
class DeliverySettingsView {
  @ApiProperty() locationRequired!: boolean;
}
class TextQuery {
  @ApiProperty({ minLength: 2, maxLength: 200 }) @IsString() @Length(2, 200) input!: string;
}
class DetailsQuery {
  @ApiProperty({ minLength: 1, maxLength: 200 }) @IsString() @Length(1, 200) placeId!: string;
}
class AddressTextFieldsDto {
  @ApiPropertyOptional({ enum: ['HOME', 'WORK', 'OTHER'] })
  @IsOptional()
  @IsIn(['HOME', 'WORK', 'OTHER'])
  label?: 'HOME' | 'WORK' | 'OTHER';
  @ApiProperty({ minLength: 1, maxLength: 200 }) @IsString() @Length(1, 200) line1!: string;
  @ApiPropertyOptional({ maxLength: 200 }) @IsOptional() @IsString() @Length(0, 200) line2?: string;
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @Length(0, 200)
  landmark?: string;
  @ApiProperty({ pattern: '^\\d{6}$', example: '560001' })
  @IsString()
  @Matches(/^\d{6}$/)
  pincode!: string;
  @ApiProperty({ minLength: 1, maxLength: 120 }) @IsString() @Length(1, 120) contactName!: string;
  @ApiProperty({ pattern: '^\\+[1-9]\\d{7,14}$', example: '+919876543210' })
  @IsString()
  @Matches(/^\+[1-9]\d{7,14}$/)
  contactPhone!: string;
}
class AddressFieldsDto extends AddressTextFieldsDto {
  @ApiProperty({ type: Number, minimum: -90, maximum: 90 }) @IsNumber() @IsLatitude() lat!: number;
  @ApiProperty({ type: Number, minimum: -180, maximum: 180 })
  @IsNumber()
  @IsLongitude()
  lng!: number;
}
class PendingAddressDto extends AddressTextFieldsDto {
  @ApiPropertyOptional({ type: Boolean }) @IsOptional() @IsBoolean() makeDefault?: boolean;
}
class ConfirmAddressLocationDto {
  @ApiProperty({ type: Number, minimum: -90, maximum: 90 }) @IsNumber() @IsLatitude() lat!: number;
  @ApiProperty({ type: Number, minimum: -180, maximum: 180 })
  @IsNumber()
  @IsLongitude()
  lng!: number;
  @ApiProperty({ pattern: '^[1-9]\\d*$' }) @IsString() @Matches(/^[1-9]\d*$/) version!: string;
}
class CustomerAddressDto extends AddressFieldsDto {
  @ApiPropertyOptional({ type: Boolean }) @IsOptional() @IsBoolean() makeDefault?: boolean;
}
class UpdateAddressDto extends AddressFieldsDto {
  @ApiProperty({ pattern: '^[1-9]\\d*$' }) @IsString() @Matches(/^[1-9]\d*$/) version!: string;
}
class PointView {
  @ApiProperty() lat!: number;
  @ApiProperty() lng!: number;
}
class AddressView {
  @ApiPropertyOptional({ enum: ['HOME', 'WORK', 'OTHER'] }) label?: 'HOME' | 'WORK' | 'OTHER';
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() line1!: string;
  @ApiPropertyOptional() line2?: string;
  @ApiPropertyOptional() landmark?: string;
  @ApiProperty() pincode!: string;
  @ApiProperty() contactName!: string;
  @ApiProperty() contactPhone!: string;
  @ApiProperty({ type: PointView, nullable: true }) point!: PointView | null;
  @ApiProperty() isDefault!: boolean;
  @ApiProperty() version!: string;
}
class AddressWriteView {
  @ApiProperty({ type: AddressView }) address!: AddressView;
  @ApiProperty() needsConfirmation!: boolean;
  @ApiProperty() degraded!: boolean;
}
class SuggestionView {
  @ApiProperty() id!: string;
  @ApiProperty() description!: string;
}
class PlaceView extends SuggestionView {
  @ApiProperty({ type: PointView }) location!: PointView;
  @ApiPropertyOptional() degraded?: boolean;
}
class ZoneView {
  @ApiPropertyOptional({ enum: ['PINCODE', 'ZONE'] }) kind?: 'PINCODE' | 'ZONE';
  @ApiProperty({ format: 'uuid' }) zoneId!: string;
  @ApiProperty() zoneVersion!: string;
  @ApiProperty() cityZoneVersion!: string;
  @ApiProperty({ format: 'uuid' }) storeId!: string;
}
class EtaView {
  @ApiProperty() minMinutes!: number;
  @ApiProperty() maxMinutes!: number;
}
class ServiceabilityView {
  @ApiProperty() serviceable!: boolean;
  @ApiProperty({ type: String, nullable: true }) storeId!: string | null;
  @ApiProperty({ type: ZoneView, nullable: true }) zone!: ZoneView | null;
  @ApiProperty({ type: EtaView, nullable: true }) etaRange!: EtaView | null;
  @ApiProperty({
    isArray: true,
    enum: [
      'OUTSIDE_ZONE',
      'STORE_CLOSED',
      'STORE_PAUSED',
      'STORE_AT_CAPACITY',
      'NO_RIDERS_AVAILABLE',
    ],
  })
  reasons!: string[];
}
const statuses: Record<string, number> = {
  INVALID_COORDINATES: 400,
  INVALID_PINCODE: 400,
  INVALID_CONTACT_PHONE: 400,
  INVALID_ADDRESS: 400,
  INVALID_VERSION: 400,
  INVALID_TARGET_TIME: 400,
  ADDRESS_NOT_FOUND: 404,
  PLACE_NOT_FOUND: 404,
  ADDRESS_LIMIT_REACHED: 409,
  IDEMPOTENCY_KEY_REUSED: 409,
  CONCURRENT_MODIFICATION: 409,
  ExternalServiceUnavailable: 503,
  ExternalServiceTimeout: 503,
  ExternalServiceRejected: 502,
};
async function result<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const status = statuses[code];
    if (status) throw new HttpException({ code }, status);
    throw error;
  }
}
function address(dto: AddressFieldsDto) {
  return {
    ...(dto.label === undefined ? {} : { label: dto.label }),
    line1: dto.line1,
    ...(dto.line2 === undefined ? {} : { line2: dto.line2 }),
    ...(dto.landmark === undefined ? {} : { landmark: dto.landmark }),
    pincode: dto.pincode,
    contactName: dto.contactName,
    contactPhone: dto.contactPhone,
    point: { lat: dto.lat, lng: dto.lng },
  };
}
@Controller('v1/customer')
@ApiBearerAuth()
@ApiResponse({ status: 400, description: 'Invalid input' })
@ApiResponse({ status: 401, description: 'Invalid token' })
@ApiResponse({ status: 403, description: 'Account or audience denied' })
@ApiResponse({ status: 404, description: 'Resource not found' })
@AuthPolicy({ audience: 'customer' })
@UseGuards(IdentityGuard)
export class CustomerServiceabilityController {
  constructor(
    @Inject(ADDRESSES) private readonly addresses: AddressOperations,
    @Inject(SERVICEABILITY) private readonly serviceability: Serviceability,
    @Inject(MAPS) private readonly maps: MapsPort,
    @Optional() @Inject(ADMIN_CONFIG) private readonly config?: AdminConfig,
  ) {}
  @Get('addresses')
  @ApiOkResponse({ type: AddressView, isArray: true })
  @ApiOperation({ operationId: 'customerListAddresses' })
  list(@CurrentPrincipal() principal: Principal) {
    return result(() => this.addresses.list(principal.userId));
  }
  @Post('addresses')
  @ApiCreatedResponse({ type: AddressWriteView })
  @ApiOperation({ operationId: 'customerCreateAddress' })
  create(@CurrentPrincipal() principal: Principal, @Body() dto: CustomerAddressDto) {
    return result(() => this.addresses.create(principal.userId, address(dto), dto.makeDefault));
  }
  @Post('addresses/pending')
  @ApiCreatedResponse({ type: AddressWriteView })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Stable request ID used to safely retry saving the same address.',
  })
  @ApiOperation({ operationId: 'customerCreatePendingAddress' })
  createPending(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: PendingAddressDto,
    @Headers('idempotency-key') reference?: string,
  ) {
    if (!reference) throw new HttpException({ code: 'IDEMPOTENCY_KEY_REQUIRED' }, 400);
    if (reference.length > 150 || !/^[\x21-\x7e]+$/.test(reference))
      throw new HttpException({ code: 'INVALID_IDEMPOTENCY_KEY' }, 400);
    return result(() =>
      this.addresses.create(
        principal.userId,
        {
          ...(dto.label === undefined ? {} : { label: dto.label }),
          line1: dto.line1,
          ...(dto.line2 === undefined ? {} : { line2: dto.line2 }),
          ...(dto.landmark === undefined ? {} : { landmark: dto.landmark }),
          pincode: dto.pincode,
          contactName: dto.contactName,
          contactPhone: dto.contactPhone,
          point: null,
        },
        dto.makeDefault,
        reference,
      ),
    );
  }
  @Patch('addresses/:id/location')
  @ApiOkResponse({ type: AddressWriteView })
  @ApiOperation({ operationId: 'customerConfirmAddressLocation' })
  confirmLocation(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ConfirmAddressLocationDto,
  ) {
    return result(async () => {
      const current = (await this.addresses.list(principal.userId)).find((item) => item.id === id);
      if (!current) throw new Error('ADDRESS_NOT_FOUND');
      if (current.point?.lat === dto.lat && current.point?.lng === dto.lng)
        return { address: current, needsConfirmation: false, degraded: false };
      return this.addresses.update(
        principal.userId,
        id,
        { ...current, point: { lat: dto.lat, lng: dto.lng } },
        dto.version,
      );
    });
  }
  @Patch('addresses/:id')
  @ApiOkResponse({ type: AddressWriteView })
  @ApiOperation({ operationId: 'customerUpdateAddress' })
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateAddressDto,
  ) {
    return result(() => this.addresses.update(principal.userId, id, address(dto), dto.version));
  }
  @Post('addresses/:id/default')
  @ApiOperation({ operationId: 'customerSetDefaultAddress' })
  setDefault(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return result(() => this.addresses.setDefault(principal.userId, id));
  }
  @Delete('addresses/:id') @ApiOperation({ operationId: 'customerDeleteAddress' }) remove(
    @CurrentPrincipal() principal: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return result(() => this.addresses.remove(principal.userId, id));
  }
  @Get('serviceability')
  @ApiOkResponse({ type: ServiceabilityView })
  @ApiOperation({ operationId: 'customerCheckServiceability' })
  check(@CurrentPrincipal() principal: Principal, @Query() query: CoverageQuery) {
    return result(async () => {
      const saved = query.addressId
        ? (await this.addresses.list(principal.userId)).find((a) => a.id === query.addressId)
        : undefined;
      if (query.addressId && !saved) throw new Error('ADDRESS_NOT_FOUND');
      const pincode = saved?.pincode ?? query.pincode;
      if (!pincode) throw new Error('INVALID_PINCODE');
      return this.serviceability.check({ pincode, targetTime: new Date() });
    });
  }
  @Get('delivery-settings')
  @ApiOkResponse({ type: DeliverySettingsView })
  @ApiOperation({ operationId: 'customerDeliverySettings' })
  async deliverySettings() {
    return {
      locationRequired: this.config ? await this.config.flag('customer_location_required') : true,
    };
  }
  @Get('places/autocomplete')
  @ApiOkResponse({ type: SuggestionView, isArray: true })
  @ApiOperation({ operationId: 'customerAutocompletePlaces' })
  autocomplete(@Query() query: TextQuery) {
    return result(() => this.maps.autocomplete(query.input));
  }
  @Get('places/details')
  @ApiOkResponse({ type: PlaceView })
  @ApiOperation({ operationId: 'customerPlaceDetails' })
  details(@Query() query: DetailsQuery) {
    return result(() => this.maps.placeDetails(query.placeId));
  }
  @Get('places/reverse')
  @ApiOkResponse({ type: PlaceView, isArray: true })
  @ApiOperation({ operationId: 'customerReverseGeocode' })
  reverse(@Query() point: PointQuery) {
    return result(() => this.maps.reverseGeocode(point));
  }
}
