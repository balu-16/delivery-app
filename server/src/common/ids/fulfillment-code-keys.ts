import type { ConfigService } from '../../config/config.service.js';

/** Versioned master secrets; purpose-specific HMAC keys separate handover and delivery. */
export function fulfillmentCodeKey(runtime: ConfigService, version: number): string {
  const parsed: unknown = JSON.parse(runtime.get('PICKING_CODE_KEYS_JSON'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('INVALID_CODE_KEY_RING');
  const value = (parsed as Record<string, unknown>)[String(version)];
  if (typeof value === 'string' && value.length >= 16) return value;
  if (version === 1) return runtime.get('PICKING_HANDOVER_SECRET');
  throw new Error('CODE_KEY_VERSION_UNAVAILABLE');
}
