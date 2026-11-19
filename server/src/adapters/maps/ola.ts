import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { z } from 'zod';
import type {
  MapsPort,
  Place,
  Point,
  RouteEstimate,
  Suggestion,
} from '../../modules/serviceability/contracts/maps.js';

export interface OlaConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxAttempts: number;
  breakerFailures: number;
  breakerCooldownMs: number;
  paths: {
    autocomplete: string;
    details: string;
    geocode: string;
    reverse: string;
    directions: string;
    matrix: string;
  };
}

const location = z.object({
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});

// Response shapes follow https://maps.olakrutrim.com/openapi/ola-maps-apis-oas.yaml.
const addressComponent = z.object({
  types: z.array(z.string()).optional().default([]),
  long_name: z.string().optional(),
  short_name: z.string().optional(),
});
const place = z.object({
  place_id: z.string(),
  formatted_address: z.string(),
  geometry: z.object({ location }),
  address_components: z.array(addressComponent).optional(),
});
const predictions = z.object({
  status: z.enum(['ok', 'zero_results']),
  predictions: z
    .array(z.object({ place_id: z.string(), description: z.string() }))
    .optional()
    .default([]),
});
const details = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), result: place }),
  z.object({ status: z.literal('zero_results') }),
]);
const geocoding = z.object({
  status: z.enum(['ok', 'zero_results']),
  geocodingResults: z.array(place).optional().default([]),
});
const reverse = z.object({
  status: z.enum(['ok', 'zero_results']),
  results: z.array(place).optional().default([]),
});
const routes = z.object({
  status: z.string().optional(),
  routes: z
    .array(
      z.object({
        legs: z
          .array(
            z.object({
              distance: z.number().finite().nonnegative(),
              duration: z.number().finite().nonnegative(),
            }),
          )
          .min(1),
      }),
    )
    .optional(),
});
const matrixElement = z.object({
  distance: z.number().finite().nonnegative().optional(),
  duration: z.number().finite().nonnegative().optional(),
  status: z.string().optional(),
});
const matrix = z.object({
  status: z.string().optional(),
  rows: z.array(
    z.object({
      elements: z.array(matrixElement),
    }),
  ),
});

const extractPincode = (
  components: z.infer<typeof addressComponent>[] | undefined,
): string | undefined => {
  if (!components) return undefined;
  const postal = components.find((component) => component.types.includes('postal_code'));
  if (!postal) return undefined;
  const candidate = postal.long_name ?? postal.short_name;
  if (typeof candidate !== 'string') return undefined;
  const trimmed = candidate.trim();
  return /^\d{6}$/.test(trimmed) ? trimmed : undefined;
};

const convertPlace = (p: z.infer<typeof place>): Place => {
  const pincode = extractPincode(p.address_components);
  return {
    id: p.place_id,
    description: p.formatted_address,
    location: p.geometry.location,
    ...(pincode ? { pincode } : {}),
  };
};
const coord = (p: Point) => `${p.lat},${p.lng}`;

export class MapsProviderError extends Error {
  constructor(
    readonly code:
      'ExternalServiceUnavailable' | 'ExternalServiceRejected' | 'ExternalServiceTimeout',
    readonly immediate = false,
  ) {
    super(code);
  }
}

type MapsLogger = Pick<pino.Logger, 'info' | 'warn' | 'error'>;
const silentLogger: MapsLogger = pino({ level: 'silent' });

const parseRetryAfterMs = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta >= 0 ? delta : 0;
  }
  return undefined;
};

/** API URLs/methods follow Ola's public reference, 2026-11-06. */
export class OlaMaps implements MapsPort {
  private failures = 0;
  private openUntil = 0;
  private halfOpen = false;
  constructor(
    private readonly config: OlaConfig,
    private readonly budget: () => Promise<{ topK: number; maxPairs: number }>,
    private readonly fetcher: typeof fetch = fetch,
    private readonly logger: MapsLogger = silentLogger,
  ) {}
  private suppress(ms: number): void {
    this.failures = Math.max(this.failures, this.config.breakerFailures);
    this.openUntil = Math.max(this.openUntil, Date.now() + ms);
  }
  private markSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }
  private recordFailure(): void {
    this.failures += 1;
    if (this.failures >= this.config.breakerFailures || this.halfOpen)
      this.openUntil = Date.now() + this.config.breakerCooldownMs;
  }
  private log(
    level: 'info' | 'warn' | 'error',
    fields: Record<string, string | number | undefined>,
    message: string,
  ): void {
    this.logger[level](fields, message);
  }
  private async call(
    operation: string,
    path: string,
    params: Record<string, string>,
    method: 'GET' | 'POST' = 'GET',
    options?: { maxAttempts?: number; pairs?: number },
  ): Promise<unknown> {
    if (this.openUntil > Date.now() || (this.openUntil !== 0 && this.halfOpen))
      throw new MapsProviderError('ExternalServiceUnavailable');
    if (this.openUntil !== 0) this.halfOpen = true;
    const base = new URL(this.config.baseUrl);
    if (!/^\/(?!\/)(?!.*\.\.)/.test(path)) throw new Error('INVALID_MAPS_PATH');
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new Error('INVALID_MAPS_PATH');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('api_key', this.config.apiKey);
    try {
      const start = Date.now();
      const deadline = start + this.config.timeoutMs;
      const configuredAttempts = Math.min(
        Math.max(options?.maxAttempts ?? this.config.maxAttempts, 1),
        3,
      );
      let lastError: MapsProviderError = new MapsProviderError('ExternalServiceUnavailable');
      for (let attempt = 0; attempt < configuredAttempts; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          lastError = new MapsProviderError('ExternalServiceTimeout');
          this.log(
            'warn',
            {
              operation,
              attempt,
              outcome: 'timeout',
              elapsedMs: Date.now() - start,
              pairs: options?.pairs,
            },
            'maps provider request',
          );
          break;
        }
        const requestId = randomUUID();
        const attemptStart = Date.now();
        const attemptElapsed = () => Date.now() - attemptStart;
        try {
          const remainingForFetch = Math.max(deadline - Date.now(), 1);
          let raceTimer: ReturnType<typeof setTimeout> | undefined;
          const timeoutPromise = new Promise<never>((_, reject) => {
            raceTimer = setTimeout(() => {
              this.log(
                'warn',
                {
                  operation,
                  attempt,
                  outcome: 'timeout',
                  elapsedMs: attemptElapsed(),
                  requestId,
                  pairs: options?.pairs,
                },
                'maps provider request',
              );
              reject(new MapsProviderError('ExternalServiceTimeout'));
            }, remainingForFetch);
            if (typeof (raceTimer as { unref?: unknown }).unref === 'function')
              (raceTimer as { unref: () => void }).unref();
          });
          let response: Response;
          try {
            response = await Promise.race([
              this.fetcher(url, {
                method,
                redirect: 'error',
                headers: { 'X-Request-Id': requestId },
                signal: AbortSignal.timeout(remainingForFetch),
              }),
              timeoutPromise,
            ]);
          } finally {
            if (raceTimer) clearTimeout(raceTimer);
          }
          if (!response.ok) {
            const status = response.status;
            if (status === 401 || status === 403) {
              this.suppress(this.config.breakerCooldownMs);
              this.log(
                'warn',
                {
                  operation,
                  attempt,
                  outcome: 'credential_rejected',
                  elapsedMs: attemptElapsed(),
                  requestId,
                  pairs: options?.pairs,
                },
                'maps provider request',
              );
              throw new MapsProviderError('ExternalServiceRejected');
            }
            if (status === 429) {
              const retryMs = parseRetryAfterMs(response.headers.get('retry-after'));
              this.suppress(Math.max(this.config.breakerCooldownMs, retryMs ?? 0));
              this.log(
                'warn',
                {
                  operation,
                  attempt,
                  outcome: 'quota',
                  elapsedMs: attemptElapsed(),
                  requestId,
                  pairs: options?.pairs,
                },
                'maps provider request',
              );
              throw new MapsProviderError('ExternalServiceUnavailable', true);
            }
            if (status < 500) {
              this.log(
                'warn',
                {
                  operation,
                  attempt,
                  outcome: 'rejected',
                  elapsedMs: attemptElapsed(),
                  requestId,
                  pairs: options?.pairs,
                },
                'maps provider request',
              );
              throw new MapsProviderError('ExternalServiceRejected');
            }
            this.log(
              'error',
              {
                operation,
                attempt,
                outcome: 'unavailable',
                elapsedMs: attemptElapsed(),
                requestId,
                pairs: options?.pairs,
              },
              'maps provider request',
            );
            throw new MapsProviderError('ExternalServiceUnavailable');
          }
          let body: string;
          {
            const remainingForBody = Math.max(deadline - Date.now(), 1);
            let bodyTimer: ReturnType<typeof setTimeout> | undefined;
            const bodyTimeout = new Promise<never>((_, reject) => {
              bodyTimer = setTimeout(() => {
                this.log(
                  'warn',
                  {
                    operation,
                    attempt,
                    outcome: 'timeout',
                    elapsedMs: attemptElapsed(),
                    requestId,
                    pairs: options?.pairs,
                  },
                  'maps provider request',
                );
                reject(new MapsProviderError('ExternalServiceTimeout'));
              }, remainingForBody);
              if (typeof (bodyTimer as { unref?: unknown }).unref === 'function')
                (bodyTimer as { unref: () => void }).unref();
            });
            try {
              body = await Promise.race([response.text(), bodyTimeout]);
            } finally {
              if (bodyTimer) clearTimeout(bodyTimer);
            }
          }
          if (Date.now() > deadline) {
            lastError = new MapsProviderError('ExternalServiceTimeout');
            this.log(
              'warn',
              {
                operation,
                attempt,
                outcome: 'timeout',
                elapsedMs: Date.now() - start,
                requestId,
                pairs: options?.pairs,
              },
              'maps provider request',
            );
            break;
          }
          if (body.length > 1_048_576) {
            this.log(
              'warn',
              {
                operation,
                attempt,
                outcome: 'invalid_response',
                elapsedMs: attemptElapsed(),
                requestId,
                pairs: options?.pairs,
              },
              'maps provider request',
            );
            throw new MapsProviderError('ExternalServiceRejected');
          }
          let value: unknown;
          try {
            value = JSON.parse(body);
          } catch {
            this.log(
              'warn',
              {
                operation,
                attempt,
                outcome: 'invalid_response',
                elapsedMs: attemptElapsed(),
                requestId,
                pairs: options?.pairs,
              },
              'maps provider request',
            );
            throw new MapsProviderError('ExternalServiceRejected');
          }
          this.log(
            'info',
            {
              operation,
              attempt,
              outcome: 'success',
              elapsedMs: attemptElapsed(),
              requestId,
              pairs: options?.pairs,
            },
            'maps provider request',
          );
          return value;
        } catch (error) {
          if (error instanceof MapsProviderError) {
            if (error.code === 'ExternalServiceRejected') throw error;
            if (error.immediate) throw error;
            lastError = error;
          } else {
            const name = error instanceof Error ? error.name : '';
            const message = error instanceof Error ? error.message : '';
            if (/redirect/i.test(message)) {
              this.log(
                'warn',
                {
                  operation,
                  attempt,
                  outcome: 'rejected',
                  elapsedMs: attemptElapsed(),
                  requestId,
                  pairs: options?.pairs,
                },
                'maps provider request',
              );
              throw new MapsProviderError('ExternalServiceRejected');
            }
            lastError =
              name === 'TimeoutError' || name === 'AbortError'
                ? new MapsProviderError('ExternalServiceTimeout')
                : new MapsProviderError('ExternalServiceUnavailable');
            if (attempt + 1 >= configuredAttempts) {
              this.log(
                lastError.code === 'ExternalServiceTimeout' ? 'warn' : 'error',
                {
                  operation,
                  attempt,
                  outcome: lastError.code === 'ExternalServiceTimeout' ? 'timeout' : 'unavailable',
                  elapsedMs: attemptElapsed(),
                  requestId,
                  pairs: options?.pairs,
                },
                'maps provider request',
              );
            }
          }
          if (attempt + 1 < configuredAttempts) {
            const remainingAfterError = deadline - Date.now();
            if (remainingAfterError <= 0) {
              lastError = new MapsProviderError('ExternalServiceTimeout');
              this.recordFailure();
              throw lastError;
            }
            const backoff = Math.floor(Math.random() * 100 * (attempt + 1));
            if (backoff >= remainingAfterError) {
              lastError = new MapsProviderError('ExternalServiceTimeout');
              this.recordFailure();
              throw lastError;
            }
            await delay(backoff);
          }
        }
      }
      this.recordFailure();
      throw lastError;
    } finally {
      this.halfOpen = false;
    }
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      this.recordFailure();
      throw new MapsProviderError('ExternalServiceRejected');
    }
    this.markSuccess();
    return result.data;
  }
  async autocomplete(input: string): Promise<Suggestion[]> {
    const data = this.parse(
      predictions,
      await this.call('autocomplete', this.config.paths.autocomplete, { input }, 'GET', {
        maxAttempts: 1,
      }),
    );
    return data.predictions.map((p) => ({ id: p.place_id, description: p.description }));
  }
  async placeDetails(id: string): Promise<Place> {
    const data = this.parse(
      details,
      await this.call('placeDetails', this.config.paths.details, { place_id: id }),
    );
    if (data.status === 'zero_results') throw new Error('PLACE_NOT_FOUND');
    return convertPlace(data.result);
  }
  async geocode(address: string): Promise<Place[]> {
    return this.parse(
      geocoding,
      await this.call('geocode', this.config.paths.geocode, { address }),
    ).geocodingResults.map(convertPlace);
  }
  async reverseGeocode(point: Point): Promise<Place[]> {
    return this.parse(
      reverse,
      await this.call('reverseGeocode', this.config.paths.reverse, { latlng: coord(point) }),
    ).results.map(convertPlace);
  }
  async directions(origin: Point, destination: Point): Promise<RouteEstimate> {
    const data = this.parse(
      routes,
      await this.call(
        'directions',
        this.config.paths.directions,
        { origin: coord(origin), destination: coord(destination) },
        'POST',
      ),
    );
    const status = data.status?.toUpperCase();
    const route = data.routes?.[0];
    if ((status === 'OK' || status === 'SUCCESS') && route && route.legs.length > 0) {
      const legs = route.legs;
      return {
        distanceMetres: legs.reduce((sum, leg) => sum + leg.distance, 0),
        durationSeconds: legs.reduce((sum, leg) => sum + leg.duration, 0),
        degraded: false,
      };
    }
    const noRoute =
      status === 'ZERO_RESULTS' ||
      status === 'NO_ROUTE' ||
      status === 'NOT_FOUND' ||
      !data.routes ||
      data.routes.length === 0;
    if (noRoute) throw new MapsProviderError('ExternalServiceUnavailable');
    throw new MapsProviderError('ExternalServiceRejected');
  }
  async distanceMatrix(
    origins: Point[],
    destinations: Point[],
  ): Promise<(RouteEstimate | null)[][]> {
    const { topK, maxPairs } = await this.budget();
    if (
      !Number.isSafeInteger(topK) ||
      topK < 1 ||
      !Number.isSafeInteger(maxPairs) ||
      maxPairs < 1 ||
      maxPairs > 50 ||
      origins.length < 1 ||
      destinations.length < 1 ||
      origins.length > topK ||
      origins.length * destinations.length > maxPairs
    )
      throw new Error('MATRIX_BUDGET_EXCEEDED');
    const pairs = origins.length * destinations.length;
    const data = this.parse(
      matrix,
      await this.call(
        'distanceMatrix',
        this.config.paths.matrix,
        {
          origins: origins.map(coord).join('|'),
          destinations: destinations.map(coord).join('|'),
        },
        'GET',
        { pairs },
      ),
    );
    const envelope = data.status?.toUpperCase();
    if (envelope === 'FAILURE' || envelope === 'BAD_REQUEST' || envelope === 'ERROR') {
      this.log(
        'warn',
        { operation: 'distanceMatrix', outcome: 'unavailable', pairs },
        'maps provider request',
      );
      throw new MapsProviderError('ExternalServiceUnavailable');
    }
    if (data.rows.length !== origins.length) {
      this.log(
        'warn',
        { operation: 'distanceMatrix', outcome: 'unavailable', pairs },
        'maps provider request',
      );
      throw new MapsProviderError('ExternalServiceUnavailable');
    }
    if (data.rows.some((row) => row.elements.length !== destinations.length)) {
      this.log(
        'warn',
        { operation: 'distanceMatrix', outcome: 'unavailable', pairs },
        'maps provider request',
      );
      throw new MapsProviderError('ExternalServiceUnavailable');
    }
    const mapped = data.rows.map((row) =>
      row.elements.map((item): RouteEstimate | null => {
        const ok =
          item.status === 'OK' &&
          typeof item.distance === 'number' &&
          Number.isFinite(item.distance) &&
          item.distance >= 0 &&
          typeof item.duration === 'number' &&
          Number.isFinite(item.duration) &&
          item.duration >= 0;
        if (!ok) return null;
        return {
          distanceMetres: item.distance!,
          durationSeconds: item.duration!,
          degraded: false,
        };
      }),
    );
    let fallbackCells = 0;
    for (const row of mapped) for (const cell of row) if (cell === null) fallbackCells += 1;
    this.log(
      'info',
      { operation: 'distanceMatrix', outcome: 'success', pairs, fallbackCells },
      'maps provider request',
    );
    return mapped;
  }
}
