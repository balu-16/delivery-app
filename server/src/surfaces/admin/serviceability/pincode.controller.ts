import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  PINCODE_ADMIN,
  type PincodeAdministration,
} from '../../../modules/serviceability/contracts/pincodes.js';

class CreatePincodesDto {
  @ApiProperty({ type: [String], example: ['520001'] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @Matches(/^\d{6}$/, { each: true })
  pincodes!: string[];
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @Length(0, 120)
  locality?: string;
}
class UpdatePincodeDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty({ maxLength: 120 }) @IsString() @Length(0, 120) locality!: string;
  @ApiProperty() @IsBoolean() active!: boolean;
  @ApiProperty({ pattern: '^[1-9]\\d*$' }) @IsString() @Matches(/^[1-9]\d*$/) version!: string;
}
class PincodeView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() pincode!: string;
  @ApiProperty({ format: 'uuid' }) storeId!: string;
  @ApiProperty() storeName!: string;
  @ApiProperty() storeStatus!: string;
  @ApiProperty() locality!: string;
  @ApiProperty() active!: boolean;
  @ApiProperty() version!: string;
  @ApiProperty() updatedAt!: string;
}
async function response<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    const status =
      code === 'FORBIDDEN'
        ? 403
        : ['PINCODE_NOT_FOUND', 'STORE_NOT_FOUND'].includes(code)
          ? 404
          : ['PINCODE_EXISTS', 'CONCURRENT_MODIFICATION'].includes(code)
            ? 409
            : ['INVALID_PINCODE', 'INVALID_INPUT'].includes(code)
              ? 400
              : 0;
    if (status) throw new HttpException({ code }, status);
    throw error;
  }
}

@Controller('v1/admin/delivery-pincodes')
@ApiBearerAuth()
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
export class AdminPincodeController {
  constructor(@Inject(PINCODE_ADMIN) private readonly admin: PincodeAdministration) {}

  @Get()
  @ApiOkResponse({ type: PincodeView, isArray: true })
  @ApiOperation({ operationId: 'adminListDeliveryPincodes' })
  list(@CurrentPrincipal() p: Principal) {
    return response(() => this.admin.list(p.userId));
  }

  @Post()
  @ApiOperation({ operationId: 'adminCreateDeliveryPincodes' })
  create(@CurrentPrincipal() p: Principal, @Body() body: CreatePincodesDto) {
    return response(() =>
      this.admin.create(p.userId, body.pincodes, body.storeId, body.locality ?? ''),
    );
  }

  @Patch(':id')
  @ApiOperation({ operationId: 'adminUpdateDeliveryPincode' })
  update(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdatePincodeDto,
  ) {
    return response(() => this.admin.update(p.userId, id, body));
  }
}
