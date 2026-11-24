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
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import {
  TEMPLATE_OVERRIDES,
  type TemplateOverrides,
} from '../../../modules/notifications/contracts/template-overrides.js';

class TemplateWriteDto {
  @ApiProperty() @IsString() @MaxLength(200) subject!: string;
  @ApiProperty() @IsString() @MaxLength(2000) body!: string;
  @ApiPropertyOptional() @IsOptional() expectedVersion?: number;
}

/** SUPER_ADMIN notification copy (customize2 §3E): list, publish/restore, history. */
@Controller('v1/admin/notification-templates')
@ApiBearerAuth()
@AuthPolicy({ audience: 'admin', roles: ['SUPER_ADMIN'] })
@UseGuards(IdentityGuard)
@UseInterceptors(DomainErrorInterceptor)
export class NotificationTemplatesController {
  constructor(@Inject(TEMPLATE_OVERRIDES) private readonly templates: TemplateOverrides) {}

  @Get()
  @ApiOperation({ operationId: 'adminListNotificationTemplates' })
  list() {
    return this.templates.list();
  }

  @Put(':templateKey/:locale/:channel')
  @ApiOperation({ operationId: 'adminWriteNotificationTemplate' })
  write(
    @CurrentPrincipal() principal: Principal,
    @Param('templateKey') templateKey: string,
    @Param('locale') locale: string,
    @Param('channel') channel: string,
    @Body() body: TemplateWriteDto,
  ) {
    return this.templates.write(principal.userId, templateKey, locale, channel, body);
  }

  @Get(':templateKey/:locale/:channel/history')
  @ApiOperation({ operationId: 'adminNotificationTemplateHistory' })
  history(
    @Param('templateKey') templateKey: string,
    @Param('locale') locale: string,
    @Param('channel') channel: string,
  ) {
    return this.templates.history(templateKey, locale, channel);
  }
}
