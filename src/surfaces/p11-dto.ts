import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  MinLength,
  ArrayMaxSize,
} from 'class-validator';
export class TicketCreateDto {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  category!: string;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() orderId?: string;
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
  @ApiPropertyOptional({ type: [String], maxItems: 5, format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsUUID('all', { each: true })
  mediaIds?: string[];
}
export class TicketMessageDto {
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() internal?: boolean;
  @ApiPropertyOptional({ type: [String], maxItems: 5, format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsUUID('all', { each: true })
  mediaIds?: string[];
}
export class TicketUpdateDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] })
  @IsOptional()
  @IsIn(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'])
  status?: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  assigneeId?: string | null;
}
export class UploadDto {
  @ApiProperty({ enum: ['image/jpeg', 'image/png', 'application/pdf'] })
  @IsString()
  @IsIn(['image/jpeg', 'image/png', 'application/pdf'])
  contentType!: string;
  @ApiProperty({ type: Number, minimum: 1 }) @IsInt() @Min(1) size!: number;
}
export class RatingDto {
  @ApiProperty({ enum: ['ORDER', 'RIDER', 'PRODUCT'] })
  @IsIn(['ORDER', 'RIDER', 'PRODUCT'])
  targetType!: 'ORDER' | 'RIDER' | 'PRODUCT';
  @ApiProperty({ format: 'uuid' }) @IsUUID() targetId!: string;
  @ApiProperty({ type: Number, minimum: 1, maximum: 5 }) @IsInt() @Min(1) @Max(5) stars!: number;
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
export class EditRatingDto {
  @ApiProperty({ type: Number, minimum: 1, maximum: 5 }) @IsInt() @Min(1) @Max(5) stars!: number;
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
export class ModerateRatingDto {
  @ApiProperty() @IsBoolean() hidden!: boolean;
  @ApiProperty({ minLength: 1, maxLength: 300 })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
}
export class PaidDto {
  @ApiProperty({ minLength: 1, maxLength: 150 })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  paymentReference!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() evidenceMediaId!: string;
  @ApiProperty({ minLength: 1, maxLength: 150 })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  idempotencyKey!: string;
}

export class SupportRefundDto {
  @ApiProperty({ minLength: 1, maxLength: 18, pattern: '^[1-9][0-9]*$' })
  @IsString()
  @MinLength(1)
  @MaxLength(18)
  amountPaise!: string;
  @ApiProperty({ minLength: 1, maxLength: 300 })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
  @ApiProperty({ minLength: 1, maxLength: 150 })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  idempotencyKey!: string;
}

export class CannedResponseDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() id?: string;
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  label!: string;
  @ApiProperty({ minLength: 1, maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body!: string;
  @ApiProperty() @IsBoolean() active!: boolean;
}

export class PayoutCorrectionDto {
  @ApiProperty({
    pattern: '^-?[1-9][0-9]{0,17}$',
    description: 'Positive: owed to rider; negative: receivable from rider.',
  })
  @IsString()
  @Matches(/^-?[1-9][0-9]{0,17}$/)
  deltaPaise!: string;
  @ApiProperty({ minLength: 1, maxLength: 300 })
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  reason!: string;
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  reference!: string;
}

export class P11PageDto {
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cursor?: string;
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
