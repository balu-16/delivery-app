import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Put,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  APP_CONTENT,
  type AppContentService,
} from '../../../modules/app-content/contracts/app-content.js';

class AppContentWriteDto {
  @ApiProperty() @IsBoolean() enabled!: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) title?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) body?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsUUID() imageMediaId?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) destination?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() startAt?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() endAt?: string | null;
  @ApiPropertyOptional() @IsOptional() expectedVersion?: number;
}

/** SUPER_ADMIN app content (customize2 §3E): list, publish/disable, history. */
@Controller('v1/admin/app-content')
@ApiBearerAuth()
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class AdminAppContentController {
  constructor(@Inject(APP_CONTENT) private readonly content: AppContentService) {}

  @Get()
  @ApiOperation({ operationId: 'adminListAppContent' })
  list() {
    return this.content.listAdmin();
  }

  @Put(':slot/:locale')
  @ApiOperation({ operationId: 'adminWriteAppContent' })
  write(
    @CurrentPrincipal() principal: Principal,
    @Param('slot') slot: string,
    @Param('locale') locale: string,
    @Body() body: AppContentWriteDto,
  ) {
    return this.content.write(principal.userId, slot, locale, body);
  }

  @Get(':slot/:locale/history')
  @ApiOperation({ operationId: 'adminAppContentHistory' })
  history(@Param('slot') slot: string, @Param('locale') locale: string) {
    return this.content.history(slot, locale);
  }
}
