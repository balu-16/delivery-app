import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional, ApiResponse } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import { ProblemDto } from '../../identity/contracts/swagger.js';

export const CATEGORY_VALUES = [
  'ORDER_UPDATES',
  'PAYMENTS',
  'WALLET',
  'RIDING',
  'STORE_OPS',
  'ADMIN',
  'PROMOTIONS',
] as const;
export const PLATFORM_VALUES = ['ANDROID', 'IOS', 'WEB'] as const;
export const APP_VALUES = ['CUSTOMER', 'RIDER', 'STORE', 'ADMIN'] as const;

export class NotificationViewDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['PUSH', 'EMAIL', 'INBOX'] }) channel!: string;
  @ApiProperty() templateKey!: string;
  @ApiProperty() title!: string;
  @ApiProperty() body!: string;
  @ApiProperty({
    enum: ['ORDER_UPDATES', 'PAYMENTS', 'WALLET', 'RIDING', 'STORE_OPS', 'ADMIN', 'PROMOTIONS'],
  })
  category!: string;
  @ApiProperty({ enum: ['TRANSACTIONAL', 'PROMOTIONAL'] }) class!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) payload!: Record<string, unknown>;
  @ApiProperty({ enum: ['PENDING', 'SENT', 'FAILED', 'SKIPPED', 'QUIET_HELD'] }) status!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) readAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) sentAt!: string | null;
}
export class NotificationPageDto {
  @ApiProperty({ type: [NotificationViewDto] }) items!: NotificationViewDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class UnreadCountDto {
  @ApiProperty({ minimum: 0 }) count!: number;
}
export class ReadResultDto {
  @ApiProperty({ minimum: 0 }) updated!: number;
}
export class DeviceTokenDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() token!: string;
  @ApiProperty({ enum: ['ANDROID', 'IOS', 'WEB'] }) platform!: string;
  @ApiProperty({ enum: ['FCM_TOKEN', 'FID'] }) identifierType!: string;
  @ApiProperty({ enum: ['CUSTOMER', 'RIDER', 'STORE', 'ADMIN'] }) app!: string;
  @ApiProperty() active!: boolean;
  @ApiProperty({ format: 'date-time' }) lastSeenAt!: string;
}
export class PreferenceDto {
  @ApiProperty({
    enum: ['ORDER_UPDATES', 'PAYMENTS', 'WALLET', 'RIDING', 'STORE_OPS', 'ADMIN', 'PROMOTIONS'],
  })
  category!: string;
  @ApiProperty() enabled!: boolean;
}
export class RegisterDeviceTokenDto {
  @ApiProperty({ minLength: 16, maxLength: 4096 })
  @IsString()
  @Length(16, 4096)
  token!: string;
  @ApiProperty({ enum: PLATFORM_VALUES })
  @IsIn(PLATFORM_VALUES)
  platform!: (typeof PLATFORM_VALUES)[number];
  @ApiPropertyOptional({ enum: ['FCM_TOKEN', 'FID'], default: 'FCM_TOKEN' })
  @IsOptional()
  @IsIn(['FCM_TOKEN', 'FID'])
  identifierType?: 'FCM_TOKEN' | 'FID';
  @ApiPropertyOptional({ enum: APP_VALUES })
  @IsOptional()
  @IsIn(APP_VALUES)
  app?: (typeof APP_VALUES)[number];
}
export class UnregisterDeviceTokenDto {
  @ApiProperty({ minLength: 16, maxLength: 4096 })
  @IsString()
  @Length(16, 4096)
  token!: string;
}
export class UpdatePreferenceDto {
  @ApiProperty({ enum: CATEGORY_VALUES })
  @IsIn(CATEGORY_VALUES)
  category!: (typeof CATEGORY_VALUES)[number];
  @ApiProperty() @IsBoolean() enabled!: boolean;
}
export class UpdatePreferencesDto {
  @ApiProperty({ type: [UpdatePreferenceDto] })
  @ValidateNested({ each: true })
  @Type(() => UpdatePreferenceDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(CATEGORY_VALUES.length)
  updates!: UpdatePreferenceDto[];
}

/** Shared error contract for notification surfaces; ownership misses stay 404. */
export function NotificationApiErrors(): ClassDecorator {
  return applyDecorators(
    ...[
      [400, 'Invalid input or cursor'],
      [401, 'Authentication required'],
      [403, 'Role not permitted'],
      [404, 'Resource not found for this owner'],
      [429, 'Rate limited; retry after the indicated delay'],
    ].map(([status, description]) =>
      ApiResponse({ status: Number(status), description: String(description), type: ProblemDto }),
    ),
  );
}
