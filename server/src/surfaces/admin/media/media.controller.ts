import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  Body,
  Controller,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiCreatedResponse,
  ApiResponse,
} from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { CATALOG_MEDIA, type CatalogMedia } from '../../../modules/media/contracts/storage.js';
class TargetDto {
  @ApiProperty({ enum: ['PRODUCT_IMAGE', 'CATALOG_IMPORT'] })
  @IsIn(['PRODUCT_IMAGE', 'CATALOG_IMPORT'])
  purpose!: 'PRODUCT_IMAGE' | 'CATALOG_IMPORT';
  @ApiProperty() @IsString() contentType!: string;
  @ApiProperty() @IsInt() @Min(1) size!: number;
}
class RegisterDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() productId?: string;
}
class TargetView {
  @ApiProperty({ format: 'uuid' }) mediaId!: string;
  @ApiProperty() url!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) fields!: Record<
    string,
    string
  >;
}
@ApiResponse({ status: 400, description: 'Invalid media' })
@ApiResponse({ status: 401, description: 'Authentication required' })
@ApiResponse({ status: 403, description: 'Insufficient role' })
@ApiResponse({ status: 404, description: 'Resource not found' })
@ApiResponse({ status: 503, description: 'Storage unavailable' })
@Controller('v1/admin/catalog/media')
@ApiBearerAuth()
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class AdminCatalogMediaController {
  constructor(@Inject(CATALOG_MEDIA) private readonly media: CatalogMedia) {}
  @Post('targets')
  @ApiOperation({ operationId: 'adminCreateCatalogMediaTarget' })
  @ApiCreatedResponse({ type: TargetView })
  target(@CurrentPrincipal() p: Principal, @Body() d: TargetDto) {
    return this.media.target(p.userId, d.purpose, d.contentType, d.size);
  }
  @Post(':id/register') @ApiOperation({ operationId: 'adminRegisterCatalogMedia' }) register(
    @CurrentPrincipal() p: Principal,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() d: RegisterDto,
  ) {
    return this.media.register(p.userId, id, d.productId);
  }
}
