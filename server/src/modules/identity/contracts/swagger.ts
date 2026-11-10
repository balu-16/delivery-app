import { ApiProperty } from '@nestjs/swagger';

export class ProblemDto {
  @ApiProperty() type!: string;
  @ApiProperty() title!: string;
  @ApiProperty() status!: number;
  @ApiProperty() code!: string;
  @ApiProperty() detail!: string;
  @ApiProperty() traceId!: string;
}
export class ProfileResponseDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) locale!: string | null;
}
export class PrincipalResponseDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ enum: ['CUSTOMER', 'WORKFORCE'] }) pool!: string;
  @ApiProperty() sub!: string;
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty({ enum: ['ACTIVE', 'BLOCKED', 'DELETED'] }) status!: string;
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty() authVersion!: string;
  @ApiProperty({ type: String, nullable: true }) riderStatus!: string | null;
}
export class RequestIdResponseDto {
  @ApiProperty({ format: 'uuid' }) requestId!: string;
}
export class WorkforceResponseDto {
  @ApiProperty({ format: 'uuid' }) operationId!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
}
export class UploadTargetResponseDto {
  @ApiProperty({ format: 'uuid' }) mediaId!: string;
  @ApiProperty() url!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) fields!: Record<
    string,
    string
  >;
}
export class UrlResponseDto {
  @ApiProperty() url!: string;
}
export class RiderResponseDto extends ProfileResponseDto {
  @ApiProperty({ type: String, nullable: true }) riderStatus!: string | null;
}
class StoreAssignmentResponseDto {
  @ApiProperty({ format: 'uuid' }) storeId!: string;
  @ApiProperty() role!: string;
}
export class StoreResponseDto extends ProfileResponseDto {
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty({ type: [StoreAssignmentResponseDto] }) stores!: StoreAssignmentResponseDto[];
}
export class ConfigValuesResponseDto {
  @ApiProperty() addressMaxPerUser!: number;
  @ApiProperty() addressPinMismatchMetres!: number;
  @ApiProperty() zoneMinAreaM2!: number;
  @ApiProperty() zoneMaxAreaM2!: number;
  @ApiProperty() mapCacheTtlSeconds!: number;
  @ApiProperty() mapMatrixTopK!: number;
  @ApiProperty() mapMatrixMaxPairs!: number;
  @ApiProperty() mapFallbackSpeedKph!: number;
  @ApiProperty() storeBacklogPauseThreshold!: number;
  @ApiProperty() storeNoRidersPauseMinutes!: number;
  @ApiProperty() etaMinMinutes!: number;
  @ApiProperty() etaMaxMinutes!: number;
  @ApiProperty({ type: [String] }) requiredRiderDocuments!: string[];
  @ApiProperty() termsVersion!: string;
  @ApiProperty() privacyVersion!: string;
  @ApiProperty() maxPauseLengthDays!: number;
}
export class FeatureFlagsResponseDto {
  @ApiProperty() wallet_enabled!: boolean;
  @ApiProperty() cod_enabled!: boolean;
  @ApiProperty() subscriptions_enabled!: boolean;
  @ApiProperty() auto_substitution!: boolean;
  @ApiProperty() reinstate_expired_orders!: boolean;
  @ApiProperty() surge_enabled!: boolean;
}
export class ConfigSnapshotResponseDto {
  @ApiProperty({ type: ConfigValuesResponseDto }) config!: ConfigValuesResponseDto;
  @ApiProperty({ type: FeatureFlagsResponseDto }) flags!: FeatureFlagsResponseDto;
}
