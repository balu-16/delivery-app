import type { OlaConfig } from './ola.js';

export const OLA_MAPS_OFFICIAL_ORIGIN = 'https://api.olamaps.io';

/** Minimal structured input shared by the app factory and the live smoke. */
export interface OlaConfigInput {
  OLA_MAPS_API_KEY: string;
  OLA_MAPS_BASE_URL: string;
  OLA_MAPS_TIMEOUT_MS: number;
  OLA_MAPS_MAX_ATTEMPTS: number;
  OLA_MAPS_BREAKER_FAILURES: number;
  OLA_MAPS_BREAKER_COOLDOWN_MS: number;
  OLA_MAPS_AUTOCOMPLETE_PATH: string;
  OLA_MAPS_DETAILS_PATH: string;
  OLA_MAPS_GEOCODE_PATH: string;
  OLA_MAPS_REVERSE_PATH: string;
  OLA_MAPS_DIRECTIONS_PATH: string;
  OLA_MAPS_MATRIX_PATH: string;
}

const isPlaceholderKey = (value: string): boolean => {
  const normalized = value.trim();
  if (!normalized) return true;
  if (/^(placeholder|changeme|change-me)$/i.test(normalized)) return true;
  if (normalized.includes('<') || normalized.includes('>')) return true;
  if (/\s/.test(normalized)) return true;
  return false;
};

const isRelativePath = (value: string): boolean =>
  /^\/(?!\/)(?!.*\.\.)[A-Za-z0-9/_-]+$/.test(value);

/** Validate identity, origin and paths once for both server and smoke use. */
export function buildOlaConfig(env: OlaConfigInput): OlaConfig {
  if (isPlaceholderKey(env.OLA_MAPS_API_KEY)) throw new Error('INVALID_OLA_MAPS_API_KEY');
  let parsed: URL;
  try {
    parsed = new URL(env.OLA_MAPS_BASE_URL);
  } catch {
    throw new Error('INVALID_OLA_MAPS_BASE_URL');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.origin !== OLA_MAPS_OFFICIAL_ORIGIN ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  )
    throw new Error('INVALID_OLA_MAPS_BASE_URL');
  const paths = {
    autocomplete: env.OLA_MAPS_AUTOCOMPLETE_PATH,
    details: env.OLA_MAPS_DETAILS_PATH,
    geocode: env.OLA_MAPS_GEOCODE_PATH,
    reverse: env.OLA_MAPS_REVERSE_PATH,
    directions: env.OLA_MAPS_DIRECTIONS_PATH,
    matrix: env.OLA_MAPS_MATRIX_PATH,
  } as const;
  if (Object.values(paths).some((path) => !isRelativePath(path)))
    throw new Error('INVALID_MAPS_PATH');
  return {
    baseUrl: OLA_MAPS_OFFICIAL_ORIGIN,
    apiKey: env.OLA_MAPS_API_KEY,
    timeoutMs: env.OLA_MAPS_TIMEOUT_MS,
    maxAttempts: env.OLA_MAPS_MAX_ATTEMPTS,
    breakerFailures: env.OLA_MAPS_BREAKER_FAILURES,
    breakerCooldownMs: env.OLA_MAPS_BREAKER_COOLDOWN_MS,
    paths: { ...paths },
  };
}
