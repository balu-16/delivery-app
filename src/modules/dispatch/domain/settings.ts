/** Dispatch config keys read optimistically; defaults mirror spec section 23. */
export const DISPATCH_CONFIG_DEFAULTS = {
  dispatchTrigger: 'ON_PICK_START',
  dispatchRadiusM: 3000,
  dispatchRadiusWideningStepsM: [1500, 3000, 5000],
  dispatchMaxAttempts: 5,
  dispatchAutoCancelMinutes: 30,
  dispatchNoRiderAlertAfterAttempts: 2,
  offerTimeoutSeconds: 60,
  offerDeclineCooldownSeconds: 300,
  riderMaxConcurrentTasks: 3,
  riderStaleLocationSeconds: 120,
  riderHeartbeatStaleSeconds: 60,
  riderRedispatchMinutes: 10,
  cashInHandLimitPaise: '2000000',
  deliveryCodeMaxAttempts: 5,
  deliveryFailureWaitSeconds: 300,
  deliveryFailureMinContactAttempts: 2,
  deliveryCodeLockoutSeconds: 300,
  geofenceThresholdMetres: 300,
  dispatchScoreWeightsEta: 0.6,
  dispatchScoreWeightsIdle: 0.25,
  dispatchScoreWeightsAcceptance: 0.15,
  locationRetentionDays: 30,
  etaPublishDeltaMinutes: 1,
} as const;

export type DispatchDefaultKey = keyof typeof DISPATCH_CONFIG_DEFAULTS;

export type DispatchTrigger = 'ON_PICK_START' | 'ON_PACKED';

export function isDispatchTrigger(value: unknown): value is DispatchTrigger {
  return value === 'ON_PICK_START' || value === 'ON_PACKED';
}

/** Radius for a dispatch attempt: base + widening steps, capped at the steps. */
export function radiusForAttempt(
  attempt: number,
  baseMetres: number,
  wideningSteps: readonly number[],
): number {
  if (attempt <= 0) return baseMetres;
  const index = Math.min(attempt, wideningSteps.length) - 1;
  const step = wideningSteps[index];
  return step !== undefined && step > 0 ? step : baseMetres;
}
