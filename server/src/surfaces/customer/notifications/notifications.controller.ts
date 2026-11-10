import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DomainErrorInterceptor } from '../../domain-errors.js';
import {
  DEVICE_TOKENS,
  NOTIFICATION_PREFERENCES,
  NOTIFICATION_VIEWS,
  type DeviceTokens,
  type NotificationPreferences,
  type NotificationViews,
} from '../../../modules/notifications/contracts/notifications.js';
import {
  DeviceTokenDto,
  NotificationApiErrors,
  NotificationPageDto,
  PreferenceDto,
  ReadResultDto,
  RegisterDeviceTokenDto,
  UnregisterDeviceTokenDto,
  UnreadCountDto,
  UpdatePreferencesDto,
} from '../../../modules/notifications/contracts/swagger.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';

export class InboxQueryDto {
  @IsOptional() @IsString() @MaxLength(512) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

/** Customer audience: self-scoped inbox, tokens and preferences (manifest P9). */
@Controller('v1/customer')
@ApiBearerAuth()
@NotificationApiErrors()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'customer', roles: ['CUSTOMER'] })
@UseGuards(IdentityGuard)
export class CustomerNotificationsController {
  constructor(
    @Inject(NOTIFICATION_VIEWS) private readonly views: NotificationViews,
    @Inject(DEVICE_TOKENS) private readonly tokens: DeviceTokens,
    @Inject(NOTIFICATION_PREFERENCES) private readonly preferences: NotificationPreferences,
  ) {}

  @Post('device-tokens')
  @ApiOperation({ operationId: 'customerRegisterDeviceToken' })
  async register(
    @CurrentPrincipal() p: Principal,
    @Body() body: RegisterDeviceTokenDto,
  ): Promise<{ registered: boolean }> {
    await this.tokens.register(p.userId, {
      token: body.token,
      platform: body.platform,
      identifierType: body.identifierType,
      app: 'CUSTOMER',
    });
    return { registered: true };
  }

  @Delete('device-tokens')
  @ApiOperation({ operationId: 'customerUnregisterDeviceToken' })
  async unregister(
    @CurrentPrincipal() p: Principal,
    @Body() body: UnregisterDeviceTokenDto,
  ): Promise<{ removed: boolean }> {
    await this.tokens.unregister(p.userId, body.token);
    return { removed: true };
  }

  @Get('device-tokens')
  @ApiOperation({ operationId: 'customerListDeviceTokens' })
  @ApiOkResponse({ type: [DeviceTokenDto] })
  listTokens(@CurrentPrincipal() p: Principal) {
    return this.tokens.list(p.userId);
  }

  @Get('notification-preferences')
  @ApiOperation({ operationId: 'customerGetNotificationPreferences' })
  @ApiOkResponse({ type: [PreferenceDto] })
  getPreferences(@CurrentPrincipal() p: Principal) {
    return this.preferences.get(p.userId);
  }

  @Patch('notification-preferences')
  @ApiOperation({ operationId: 'customerUpdateNotificationPreferences' })
  @ApiOkResponse({ type: [PreferenceDto] })
  async updatePreferences(@CurrentPrincipal() p: Principal, @Body() body: UpdatePreferencesDto) {
    await this.preferences.set(p.userId, body.updates);
    return this.preferences.get(p.userId);
  }

  @Get('notifications')
  @ApiOperation({ operationId: 'customerInbox' })
  @ApiOkResponse({ type: NotificationPageDto })
  inbox(@CurrentPrincipal() p: Principal, @Query() query: InboxQueryDto) {
    return this.views.inbox(p.userId, query.cursor, query.limit);
  }

  @Get('notifications/unread-count')
  @ApiOperation({ operationId: 'customerUnreadCount' })
  @ApiOkResponse({ type: UnreadCountDto })
  async unreadCount(@CurrentPrincipal() p: Principal): Promise<{ count: number }> {
    return { count: await this.views.unreadCount(p.userId) };
  }

  @Post('notifications/read-all')
  @ApiOperation({ operationId: 'customerReadAllNotifications' })
  @ApiOkResponse({ type: ReadResultDto })
  async readAll(@CurrentPrincipal() p: Principal): Promise<{ updated: number }> {
    return { updated: await this.views.markAllRead(p.userId) };
  }

  @Post('notifications/:id/read')
  @ApiOperation({ operationId: 'customerReadNotification' })
  async read(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
  ): Promise<{ read: boolean }> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    await this.views.markRead(p.userId, id);
    return { read: true };
  }
}
