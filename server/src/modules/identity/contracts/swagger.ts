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
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
export class UrlResponseDto {
  @ApiProperty() url!: string;
}
export class RiderResponseDto extends ProfileResponseDto {
  @ApiProperty({ type: String, nullable: true }) riderStatus!: string | null;
}
export class RiderBootstrapResponseDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ enum: ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'] })
  status!: string;
  @ApiProperty() groupPending!: boolean;
}
export class RiderApplicationDocumentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() type!: string;
  @ApiProperty({ enum: ['PENDING', 'APPROVED', 'REJECTED'] }) status!: string;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class RiderHomeStoreDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() city!: string;
}
export class RiderApplicationDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ enum: ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'] })
  status!: string;
  @ApiProperty({ type: String, nullable: true }) vehicleType!: string | null;
  @ApiProperty({ type: String, nullable: true }) vehicleNo!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) homeStoreId!: string | null;
  @ApiProperty({ type: RiderHomeStoreDto, nullable: true }) homeStore!: RiderHomeStoreDto | null;
  @ApiProperty({ type: [String] }) requiredDocuments!: string[];
  @ApiProperty({ type: [RiderApplicationDocumentDto] }) documents!: RiderApplicationDocumentDto[];
}
export class RiderOnboardingDto extends RiderApplicationDto {
  @ApiProperty({ type: Number }) maxDocumentBytes!: number;
}
export class RiderOnboardingUpdatedDto {
  @ApiProperty({ type: Boolean }) updated!: boolean;
  @ApiProperty({ type: RiderApplicationDto }) application!: RiderApplicationDto;
}
export class RiderOnboardingStoreDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() city!: string;
}
export class RiderApplicationListItemDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty() email!: string;
  @ApiProperty() status!: string;
}
export class RiderApplicationPageDto {
  @ApiProperty({ type: [RiderApplicationListItemDto] }) items!: RiderApplicationListItemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
class StoreAssignmentResponseDto {
  @ApiProperty({ format: 'uuid' }) storeId!: string;
  @ApiProperty() role!: string;
  @ApiProperty() name!: string;
}
export class StoreResponseDto extends ProfileResponseDto {
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty({ type: [StoreAssignmentResponseDto] }) stores!: StoreAssignmentResponseDto[];
}
class DeliveryFeeSlabResponseDto {
  @ApiProperty({ type: String, nullable: true }) maxOrderValuePaise!: string | null;
  @ApiProperty() feePaise!: string;
}
export class ConfigValuesResponseDto {
  @ApiProperty() minOrderPaise!: string;
  @ApiProperty() maxOrderPaise!: string;
  @ApiProperty() maxCodPaise!: string;
  @ApiProperty({ type: [DeliveryFeeSlabResponseDto] })
  deliveryFeeSlabs!: DeliveryFeeSlabResponseDto[];
  @ApiProperty() freeDeliveryThresholdPaise!: string;
  @ApiProperty() handlingFeePaise!: string;
  @ApiProperty() smallCartThresholdPaise!: string;
  @ApiProperty() smallCartFeePaise!: string;
  @ApiProperty() catalogMaxPerOrder!: number;
  @ApiProperty() maxCartLines!: number;
  @ApiProperty() offerTimeoutSeconds!: number;
  @ApiProperty() riderMaxConcurrentTasks!: number;
  @ApiProperty() cashInHandLimitPaise!: string;
  @ApiProperty() earningsBasePaise!: string;
  @ApiProperty() earningsPerKmPaise!: string;
  @ApiProperty() detentionFreeMinutes!: number;
  @ApiProperty() detentionPerMinutePaise!: string;
  @ApiProperty() deliveryFailureWaitSeconds!: number;
  @ApiProperty() deliveryFailureMinContactAttempts!: number;
  @ApiProperty() agent_proactive_nudges_enabled!: boolean;
  @ApiProperty() agent_nudge_max_per_week!: number;
  @ApiProperty() agent_daily_turn_limit_per_user!: number;
  @ApiProperty() notificationQuietHoursStart!: number;
  @ApiProperty() notificationQuietHoursEnd!: number;
  @ApiProperty() catalogLowStockThreshold!: number;
  @ApiProperty() inventoryExpirySoonDays!: number;
  @ApiProperty() supportFirstResponseSlaHours!: number;
  @ApiProperty() supportResolutionSlaHours!: number;
  @ApiProperty() supportReopenDays!: number;
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
  @ApiProperty() referralIssuanceEnabled!: boolean;
  @ApiProperty() referralRewardPaise!: string;
  @ApiProperty() referralCreditExpiryMonths!: number;
}
export class RevisionMapDto {
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  revisions!: Record<string, string>;
}
export class ConfigChangeResultDto {
  @ApiProperty() key!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) value!: unknown;
  @ApiProperty({ description: 'New revision as a decimal string' }) version!: string;
}
export class ConfigBatchResultDto {
  @ApiProperty({ type: [ConfigChangeResultDto] }) updated!: ConfigChangeResultDto[];
}
export class FeatureFlagsResponseDto {
  @ApiProperty() agent_enabled!: boolean;
  @ApiProperty() customer_location_required!: boolean;
  @ApiProperty() online_payments_enabled!: boolean;
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
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  configRevisions!: Record<string, string>;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  flagRevisions!: Record<string, string>;
}
