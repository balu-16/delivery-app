import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
export class EntityDto {
  @ApiProperty({ minLength: 1, maxLength: 120, pattern: '\\S' })
  @IsString()
  @Length(1, 120)
  @Matches(/\S/)
  name!: string;
}
export class CityDto extends EntityDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'GeoJSON Polygon bounding the city in WGS84',
  })
  @IsObject()
  bounds!: object;
}
export class StoreDto extends EntityDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() legalEntityId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() cityId!: string;
  @ApiProperty({ type: Number, minimum: -90, maximum: 90 }) @IsNumber() @IsLatitude() lat!: number;
  @ApiProperty({ type: Number, minimum: -180, maximum: 180 })
  @IsNumber()
  @IsLongitude()
  lng!: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1000000 })
  @IsInt()
  @Min(0)
  @Max(1000000)
  hourlyCapacity!: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1440 })
  @IsInt()
  @Min(0)
  @Max(1440)
  lastOrderBufferMinutes!: number;
}
class WindowDto {
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1439 })
  @IsInt()
  @Min(0)
  @Max(1439)
  startMinute!: number;
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 1440 })
  @IsInt()
  @Min(0)
  @Max(1440)
  endMinute!: number;
}
class HoursEntryDto extends WindowDto {
  @ApiProperty({ type: 'integer', minimum: 0, maximum: 6 })
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;
}
export class HoursDto {
  @ApiProperty({ type: [HoursEntryDto], maxItems: 100 })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => HoursEntryDto)
  entries!: HoursEntryDto[];
}
export class HolidayDto {
  @ApiProperty({ format: 'date' }) @IsDateString({ strict: true }) @Length(10, 10) day!: string;
  @ApiProperty({ type: Boolean }) @IsBoolean() closed!: boolean;
  @ApiProperty({ type: [WindowDto], maxItems: 20 })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => WindowDto)
  windows!: WindowDto[];
}
export class StaffDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() userId!: string;
  @ApiProperty({ enum: ['PICKER', 'STORE_MANAGER'] }) @IsIn(['PICKER', 'STORE_MANAGER']) role!:
    'PICKER' | 'STORE_MANAGER';
  @ApiProperty({ type: Boolean }) @IsBoolean() active!: boolean;
}
export class PageQuery {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cursor?: string;
}
export class OperationsQuery {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional({ format: 'date' })
  @IsOptional()
  @IsDateString({ strict: true })
  @Length(10, 10)
  holidayCursor?: string;
  @ApiPropertyOptional({
    description: 'User UUID and role separated by a colon',
    pattern: '^[0-9a-fA-F-]{36}:(PICKER|STORE_MANAGER)$',
  })
  @IsOptional()
  @Matches(
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:(PICKER|STORE_MANAGER)$/,
  )
  staffCursor?: string;
}
