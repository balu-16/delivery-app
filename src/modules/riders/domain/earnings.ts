import { moneyString, parseMoney } from '../../../common/money/money.js';
import type { EarningTaskInput, EarningView } from '../contracts/riders.js';
import type { RiderDefaultKey } from './defaults.js';
import { RIDER_CONFIG_DEFAULTS } from './defaults.js';

export interface EarningsConfig {
  basePaise: string;
  perKmPaise: string;
  detentionFreeMinutes: number;
  detentionPerMinutePaise: string;
}

/** Default earnings settings for callers that explicitly use these values. */
export function earningsDefaults(): EarningsConfig {
  return {
    basePaise: RIDER_CONFIG_DEFAULTS.earningsBasePaise,
    perKmPaise: RIDER_CONFIG_DEFAULTS.earningsPerKmPaise,
    detentionFreeMinutes: RIDER_CONFIG_DEFAULTS.detentionFreeMinutes,
    detentionPerMinutePaise: RIDER_CONFIG_DEFAULTS.detentionPerMinutePaise,
  };
}

export type EarningsKey = Extract<
  RiderDefaultKey,
  'earningsBasePaise' | 'earningsPerKmPaise' | 'detentionFreeMinutes' | 'detentionPerMinutePaise'
>;

/**
 * Pure per-task earnings (23.6): base + distance slab + detention + tip,
 * computed exactly once at DELIVERED and stored with UNIQUE(task_id).
 * Distance uses integer metres; paise never loses or creates money.
 */
export function computeEarnings(
  input: EarningTaskInput,
  config: EarningsConfig,
): Omit<EarningView, 'taskId' | 'orderId' | 'computedAt'> {
  const base = parseMoney(config.basePaise);
  const perKm = parseMoney(config.perKmPaise);
  const distanceMetres = Math.max(0, Math.trunc(input.distanceMetres));
  // Rounding: whole metres to whole kilometres, half up, so short hops still
  // contribute a deterministic minimum and the sum never drifts.
  const wholeKm = Math.floor((distanceMetres + 500) / 1000);
  const distance = perKm * BigInt(wholeKm);
  const freeMinutes = Math.max(0, Math.trunc(config.detentionFreeMinutes));
  const billableMinutes = Math.max(0, Math.trunc(input.detentionMinutes) - freeMinutes);
  const detention = parseMoney(config.detentionPerMinutePaise) * BigInt(billableMinutes);
  const tip = parseMoney(input.tipPaise);
  const incentive = 0n;
  const adjustment = 0n;
  const total = base + distance + detention + incentive + tip + adjustment;
  return {
    basePaise: moneyString(base),
    distancePaise: moneyString(distance),
    detentionPaise: moneyString(detention),
    incentivePaise: moneyString(incentive),
    tipPaise: moneyString(tip),
    adjustmentPaise: moneyString(adjustment),
    totalPaise: moneyString(total),
    distanceMetres,
    detentionMinutes: Math.max(0, Math.trunc(input.detentionMinutes)),
  };
}
