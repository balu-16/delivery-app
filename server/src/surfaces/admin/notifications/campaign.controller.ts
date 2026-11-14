import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  PUSH_CAMPAIGNS,
  type PushCampaigns,
} from '../../../modules/notifications/contracts/campaigns.js';

class TargetDto {
  @ApiProperty({ enum: ['ALL', 'USERS', 'PLATFORM'] }) @IsIn(['ALL', 'USERS', 'PLATFORM']) mode!:
    'ALL' | 'USERS' | 'PLATFORM';
  @ApiProperty({ enum: ['CUSTOMER', 'RIDER', 'STORE', 'ADMIN'], isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsIn(['CUSTOMER', 'RIDER', 'STORE', 'ADMIN'], { each: true })
  apps!: ('CUSTOMER' | 'RIDER' | 'STORE' | 'ADMIN')[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsUUID('all', { each: true })
  userIds?: string[];
  @ApiPropertyOptional({ enum: ['ANDROID', 'WEB'] })
  @IsOptional()
  @IsIn(['ANDROID', 'WEB'])
  platform?: 'ANDROID' | 'WEB';
}
class PreviewDto {
  @ApiProperty({ type: TargetDto }) @ValidateNested() @Type(() => TargetDto) target!: TargetDto;
  @ApiProperty({ enum: ['PROMOTIONAL', 'OPERATIONAL'] })
  @IsIn(['PROMOTIONAL', 'OPERATIONAL'])
  kind!: 'PROMOTIONAL' | 'OPERATIONAL';
}
class CreateDto extends PreviewDto {
  @ApiProperty() @IsString() @Length(1, 100) title!: string;
  @ApiProperty() @IsString() @Length(1, 500) body!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2048) clickAction?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2048) imageUrl?: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @IsOptional()
  @IsObject()
  data?: Record<string, string>;
}
@Controller('v1/admin/push-campaigns')
@ApiBearerAuth()
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class PushCampaignController {
  constructor(@Inject(PUSH_CAMPAIGNS) private readonly campaigns: PushCampaigns) {}
  @Post('preview')
  @ApiOperation({ operationId: 'adminPreviewPushCampaign' })
  preview(@Body() body: PreviewDto) {
    return this.campaigns.preview(body);
  }
  @Post()
  @ApiOperation({ operationId: 'adminCreatePushCampaign' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  create(
    @CurrentPrincipal() principal: Principal,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: CreateDto,
  ) {
    return this.campaigns.create(principal.userId, key ?? '', body);
  }
  @Get()
  @ApiOperation({ operationId: 'adminListPushCampaigns' })
  list(@Query('cursor') cursor?: string) {
    return this.campaigns.list(cursor);
  }
  @Get(':id')
  @ApiOperation({ operationId: 'adminGetPushCampaign' })
  detail(@Param('id', ParseUUIDPipe) id: string, @Query('cursor') cursor?: string) {
    return this.campaigns.detail(id, cursor);
  }
}
