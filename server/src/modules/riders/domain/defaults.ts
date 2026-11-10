/**
 * Default values for rider settings (23.2/23.6), also used by local fixtures.
 * Runtime settings read typed app_config values and propagate configuration errors.
 */
export const RIDER_CONFIG_DEFAULTS = {
  riderMaxConcurrentTasks: 3,
  riderStaleLocationSeconds: 120,
  riderHeartbeatStaleSeconds: 60,
  riderInactivityOfflineMinutes: 30,
  riderMaxContinuousHours: 12,
  cashInHandLimitPaise: '2000000',
  earningsBasePaise: '3000',
  earningsPerKmPaise: '800',
  detentionFreeMinutes: 5,
  detentionPerMinutePaise: '100',
} as const;

export type RiderDefaultKey = keyof typeof RIDER_CONFIG_DEFAULTS;
