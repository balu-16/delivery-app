// Live Ola Maps smoke (plan5 SS5B). Run with the rotated key in server/.env:
//   MAPS_PROVIDER=ola pnpm --dir server maps:ola:smoke
// Instantiates the SAME OlaMaps adapter via buildOlaConfig from process env.
// Never logs the key, URLs, address text, or coordinates. No CLI key argument.
import { buildOlaConfig } from '../src/adapters/maps/config.js';
import { OlaMaps } from '../src/adapters/maps/ola.js';
import type { Point } from '../src/modules/serviceability/contracts/maps.js';

interface LogRecord {
  operation?: string;
  outcome?: string;
  requestId?: string;
  elapsedMs?: number;
  pairs?: number;
}

const logRecords: LogRecord[] = [];
const recorder = (level: string) => (fields: Record<string, unknown>) => {
  const record: LogRecord = {};
  if (typeof fields.operation === 'string') record.operation = fields.operation;
  if (typeof fields.outcome === 'string') record.outcome = fields.outcome;
  if (typeof fields.requestId === 'string') record.requestId = fields.requestId;
  if (typeof fields.elapsedMs === 'number') record.elapsedMs = fields.elapsedMs;
  if (typeof fields.pairs === 'number') record.pairs = fields.pairs;
  logRecords.push({ ...record, outcome: record.outcome ?? level });
};
const logger = {
  info: recorder('info'),
  warn: recorder('warn'),
  error: recorder('error'),
};

interface Row {
  op: string;
  ok: boolean;
  requestId: string | null;
  elapsedMs: number;
  summary: Record<string, unknown>;
}

const rows: Row[] = [];
// The latest per-attempt record carrying a request ID (aggregate logs omit it).
const lastRequestId = (operation: string): string | null =>
  [...logRecords]
    .reverse()
    .find((r) => r.operation === operation && typeof r.requestId === 'string')?.requestId ?? null;

const numberOr = (raw: string | undefined, fallback: number): number => {
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const validPoint = (p: Point): boolean =>
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lng) &&
  Math.abs(p.lat) <= 90 &&
  Math.abs(p.lng) <= 180;

async function run(): Promise<void> {
  if (process.argv.slice(2).length > 0) {
    throw new Error('maps-ola-smoke takes no arguments; the key comes from server/.env only');
  }
  if (process.env.MAPS_PROVIDER !== 'ola') {
    throw new Error('maps-ola-smoke requires MAPS_PROVIDER=ola');
  }
  if (!process.env.OLA_MAPS_API_KEY) {
    throw new Error('OLA_MAPS_API_KEY is required (rotated server key in server/.env)');
  }
  const config = buildOlaConfig({
    OLA_MAPS_API_KEY: process.env.OLA_MAPS_API_KEY,
    OLA_MAPS_BASE_URL: process.env.OLA_MAPS_BASE_URL ?? 'https://api.olamaps.io',
    OLA_MAPS_TIMEOUT_MS: numberOr(process.env.OLA_MAPS_TIMEOUT_MS, 3000),
    OLA_MAPS_MAX_ATTEMPTS: numberOr(process.env.OLA_MAPS_MAX_ATTEMPTS, 2),
    OLA_MAPS_BREAKER_FAILURES: numberOr(process.env.OLA_MAPS_BREAKER_FAILURES, 5),
    OLA_MAPS_BREAKER_COOLDOWN_MS: numberOr(process.env.OLA_MAPS_BREAKER_COOLDOWN_MS, 30000),
    OLA_MAPS_AUTOCOMPLETE_PATH: process.env.OLA_MAPS_AUTOCOMPLETE_PATH ?? '/places/v1/autocomplete',
    OLA_MAPS_DETAILS_PATH: process.env.OLA_MAPS_DETAILS_PATH ?? '/places/v1/details',
    OLA_MAPS_GEOCODE_PATH: process.env.OLA_MAPS_GEOCODE_PATH ?? '/places/v1/geocode',
    OLA_MAPS_REVERSE_PATH: process.env.OLA_MAPS_REVERSE_PATH ?? '/places/v1/reverse-geocode',
    OLA_MAPS_DIRECTIONS_PATH: process.env.OLA_MAPS_DIRECTIONS_PATH ?? '/routing/v1/directions',
    OLA_MAPS_MATRIX_PATH: process.env.OLA_MAPS_MATRIX_PATH ?? '/routing/v1/distanceMatrix/basic',
  });
  const maps = new OlaMaps(config, async () => ({ topK: 5, maxPairs: 50 }), fetch, logger as never);

  const attempt = async <T>(
    op: string,
    fn: () => Promise<T>,
    summarize: (value: T) => Record<string, unknown>,
    isEstimate: (value: T) => boolean,
  ): Promise<T | null> => {
    const started = Date.now();
    try {
      const value = await fn();
      const estimated = isEstimate(value);
      rows.push({
        op,
        ok: !estimated,
        requestId: lastRequestId(op),
        elapsedMs: Date.now() - started,
        summary: { ...summarize(value), ...(estimated ? { estimate: true } : {}) },
      });
      return estimated ? null : value;
    } catch (error) {
      rows.push({
        op,
        ok: false,
        requestId: lastRequestId(op),
        elapsedMs: Date.now() - started,
        summary: { error: error instanceof Error ? error.message : 'UNKNOWN' },
      });
      return null;
    }
  };

  const suggestions = await attempt(
    'autocomplete',
    () => maps.autocomplete('Vijayawada Junction'),
    (v) => ({ count: v.length, nonEmpty: v.length > 0 }),
    (v) => v.length === 0,
  );
  const firstId = suggestions?.[0]?.id;
  const details = await (firstId
    ? attempt(
        'placeDetails',
        () => maps.placeDetails(firstId),
        (v) => ({ finitePoint: validPoint(v.location), hasPincode: v.pincode !== undefined }),
        (v) => !validPoint(v.location),
      )
    : (rows.push({
        op: 'placeDetails',
        ok: false,
        requestId: null,
        elapsedMs: 0,
        summary: { error: 'SKIPPED', reason: 'no suggestion id from autocomplete' },
      }),
      Promise.resolve(null)));
  const geocoded = await attempt(
    'geocode',
    () => maps.geocode('Pandit Nehru Bus Station, Vijayawada'),
    (v) => ({ count: v.length, nonEmpty: v.length > 0 }),
    (v) => v.length === 0,
  );
  const detailsPoint = details && validPoint(details.location) ? details.location : null;
  const geocodePoint =
    geocoded?.[0] && validPoint(geocoded[0].location) ? geocoded[0].location : null;
  const reverseInput = detailsPoint ?? geocodePoint;
  const reversed = await (reverseInput
    ? attempt(
        'reverseGeocode',
        () => maps.reverseGeocode(reverseInput),
        (v) => ({ count: v.length, nonEmpty: v.length > 0 }),
        (v) => v.length === 0,
      )
    : (rows.push({
        op: 'reverseGeocode',
        ok: false,
        requestId: null,
        elapsedMs: 0,
        summary: { error: 'SKIPPED', reason: 'no point from earlier steps' },
      }),
      Promise.resolve(null)));
  const reversePoint =
    reversed?.[0] && validPoint(reversed[0].location) ? reversed[0].location : null;
  const origin = detailsPoint ?? reversePoint ?? geocodePoint;
  const pool = [geocodePoint, reversePoint, detailsPoint].filter((p): p is Point => p !== null);
  const destination = pool.find(
    (p) => origin === null || p.lat !== origin.lat || p.lng !== origin.lng,
  );
  const directions = await (origin && destination
    ? attempt(
        'directions',
        () => maps.directions(origin, destination),
        (v) => ({
          positiveDistance: v.distanceMetres > 0,
          positiveDuration: v.durationSeconds > 0,
          degraded: v.degraded,
        }),
        (v) => !(v.distanceMetres > 0 && v.durationSeconds > 0 && v.degraded === false),
      )
    : (rows.push({
        op: 'directions',
        ok: false,
        requestId: null,
        elapsedMs: 0,
        summary: { error: 'SKIPPED', reason: 'need two distinct points from earlier steps' },
      }),
      Promise.resolve(null)));
  await (origin && destination
    ? attempt(
        'distanceMatrix',
        () => maps.distanceMatrix([origin], [destination]),
        (v) => {
          const cell = v[0]?.[0];
          return {
            rows: v.length,
            cols: v[0]?.length ?? 0,
            positiveDistance: cell !== undefined && cell !== null && cell.distanceMetres > 0,
            positiveDuration: cell !== undefined && cell !== null && cell.durationSeconds > 0,
            degraded: cell?.degraded ?? null,
          };
        },
        (v) => {
          const cell = v[0]?.[0];
          return !(
            v.length === 1 &&
            v[0]?.length === 1 &&
            cell != null &&
            cell.distanceMetres > 0 &&
            cell.durationSeconds > 0 &&
            cell.degraded === false
          );
        },
      )
    : (rows.push({
        op: 'distanceMatrix',
        ok: false,
        requestId: null,
        elapsedMs: 0,
        summary: { error: 'SKIPPED', reason: 'need two distinct points from earlier steps' },
      }),
      Promise.resolve(null)));
  void directions;
}

let setupFailed = false;
try {
  await run();
} catch (error) {
  setupFailed = true;
  process.stdout.write(
    `${JSON.stringify({ op: 'setup', ok: false, error: error instanceof Error ? error.message : 'UNKNOWN' })}\n`,
  );
  for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
  process.exitCode = 1;
}
if (!setupFailed) {
  for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
  if (rows.some((row) => !row.ok)) process.exitCode = 1;
  else process.stdout.write(`${JSON.stringify({ op: 'smoke', ok: true })}\n`);
}
