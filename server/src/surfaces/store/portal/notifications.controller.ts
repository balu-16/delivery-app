import {
  Controller,
  HttpException,
  Inject,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import {
  NOTIFICATION_VIEWS,
  type NotificationViews,
} from '../../../modules/notifications/contracts/notifications.js';
import { NotificationApiErrors } from '../../../modules/notifications/contracts/swagger.js';
import { AuthPolicy, CurrentPrincipal } from '../../../modules/identity/contracts/http.js';
import { IdentityGuard } from '../../../modules/identity/contracts/identity-guard.js';
import type { Principal } from '../../../modules/identity/contracts/identity.js';
import { DomainErrorInterceptor } from '../../domain-errors.js';

class UnreadResultDto {
  @ApiProperty({ enum: ['OK'] }) status!: string;
}

/** Store audience: persisted mark-unread on the shared inbox (P10 portal). */
@Controller('v1/store/notifications')
@ApiBearerAuth()
@NotificationApiErrors()
@UseInterceptors(DomainErrorInterceptor)
@AuthPolicy({ audience: 'store', roles: ['STORE_MANAGER'] })
@UseGuards(IdentityGuard)
export class StoreNotificationsUnreadController {
  constructor(@Inject(NOTIFICATION_VIEWS) private readonly views: NotificationViews) {}

  @Post(':id/unread')
  @ApiOperation({ operationId: 'storeNotificationUnread' })
  @ApiOkResponse({ type: UnreadResultDto })
  async unread(
    @CurrentPrincipal() p: Principal,
    @Param('id') id: string,
  ): Promise<{ status: 'OK' }> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpException({ code: 'INVALID_INPUT' }, 400);
    await this.views.markUnread(p.userId, id);
    return { status: 'OK' };
  }
}
