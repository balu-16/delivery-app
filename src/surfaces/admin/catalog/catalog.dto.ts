import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
export class NameDto {
  @ApiProperty({ minLength: 1, maxLength: 200 }) @IsString() @Length(1, 200) name!: string;
}
export class ProductDto extends NameDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() categoryId!: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) @IsOptional() @IsUUID() brandId?:
    string | null;
  @ApiProperty({ maxLength: 5000 }) @IsString() @MaxLength(5000) description!: string;
  @ApiPropertyOptional({ maxLength: 32, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  hsnCode?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  gstRateBps?: number | null;
  @ApiProperty() @IsBoolean() perishable!: boolean;
  @ApiProperty() @IsBoolean() expiryTracking!: boolean;
}
export class VariantDto extends NameDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() productId!: string;
  @ApiProperty({ maxLength: 100 }) @IsString() @Length(1, 100) sku!: string;
  @ApiPropertyOptional({ nullable: true, maxLength: 100 })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  barcode?: string | null;
}
export class PriceDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() variantId!: string;
  @ApiProperty({ pattern: '^\\d{1,18}$' }) @IsString() @Matches(/^\d{1,18}$/) sellingPaise!: string;
  @ApiProperty({ pattern: '^\\d{1,18}$' }) @IsString() @Matches(/^\d{1,18}$/) mrpPaise!: string;
  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description: 'Omit or set null to activate at database time',
  })
  @IsOptional()
  @IsDateString()
  validFrom?: string | null;
  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @IsDateString()
  validTo?: string | null;
}
export class AssortmentDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() storeId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() variantId!: string;
}
export class SynonymDto {
  @ApiProperty({ maxLength: 64 }) @IsString() @Length(1, 64) term!: string;
  @ApiPropertyOptional({ nullable: true, maxLength: 64 })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  expansion!: string | null;
}

export class PageDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional({ format: 'uuid' }) @IsOptional() @IsUUID() cursor?: string;
}
export class NameView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}
export class ProductView extends NameView {
  @ApiProperty({ format: 'uuid' }) categoryId!: string;
  @ApiProperty({ type: String, nullable: true }) brandId!: string | null;
  @ApiProperty() description!: string;
  @ApiProperty({ type: String, nullable: true }) hsnCode!: string | null;
  @ApiProperty({ type: Number, nullable: true }) gstRateBps!: number | null;
  @ApiProperty() perishable!: boolean;
  @ApiProperty() expiryTracking!: boolean;
  @ApiProperty() published!: boolean;
}
export class VariantView extends NameView {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() sku!: string;
  @ApiProperty({ type: String, nullable: true }) barcode!: string | null;
}
export class NamedPageView {
  @ApiProperty({ type: NameView, isArray: true }) items!: NameView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class ProductPageView {
  @ApiProperty({ type: ProductView, isArray: true }) items!: ProductView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class VariantPageView {
  @ApiProperty({ type: VariantView, isArray: true }) items!: VariantView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
export class PriceResultView {
  @ApiPropertyOptional({ format: 'uuid' }) approvalId?: string;
}

export class SynonymPageDto {
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
  @ApiPropertyOptional({ maxLength: 64 }) @IsOptional() @IsString() @MaxLength(64) cursor?: string;
}
export class SynonymView {
  @ApiProperty() term!: string;
  @ApiProperty() expansion!: string;
}
export class SynonymPageView {
  @ApiProperty({ type: SynonymView, isArray: true }) items!: SynonymView[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
