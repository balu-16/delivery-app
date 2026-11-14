import type { AppConfig } from '../../app-config/contracts/config.js';
import type { RiderDefaultKey } from '../domain/defaults.js';
import type { TransactionContext } from '../../../platform/database/database.js';

/** Typed reads from app_config; configuration failures propagate to the caller. */
export class RiderSettings {
  constructor(private readonly config: AppConfig) {}
  async earnings() {
    const [basePaise, perKmPaise, detentionFreeMinutes, detentionPerMinutePaise] =
      await Promise.all([
        this.paise('earningsBasePaise'),
        this.paise('earningsPerKmPaise'),
        this.number('detentionFreeMinutes'),
        this.paise('detentionPerMinutePaise'),
      ]);
    return { basePaise, perKmPaise, detentionFreeMinutes, detentionPerMinutePaise };
  }
  async number(key: RiderDefaultKey, tx?: TransactionContext): Promise<number> {
    const value = await this.config.get(key, tx);
    if (typeof value !== 'number') throw new Error('INVALID_CONFIG_TYPE');
    return value;
  }
  async paise(key: RiderDefaultKey, tx?: TransactionContext): Promise<string> {
    const value = await this.config.get(key, tx);
    if (typeof value !== 'string') throw new Error('INVALID_CONFIG_TYPE');
    return value;
  }
}
