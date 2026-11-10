import { setTimeout as delay } from 'node:timers/promises';
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
const place = z.object({
  place_id: z.string(),
  formatted_address: z.string(),
  geometry: z.object({ location }),
});
const predictions = z.object({
  status: z.enum(['ok', 'zero_results']),
  predictions: z.array(z.object({ place_id: z.string(), description: z.string() })),
});
const details = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), result: place }),
  z.object({ status: z.literal('zero_results') }),
]);
const geocoding = z.object({
  status: z.enum(['ok', 'zero_results']),
  geocodingResults: z.array(place),
});
const reverse = z.object({ status: z.enum(['ok', 'zero_results']), results: z.array(place) });
const routes = z.object({
  routes: z
    .array(
      z.object({
        legs: z
          .array(
            z.object({ distance: z.number().nonnegative(), duration: z.number().nonnegative() }),
          )
          .min(1),
      }),
    )
    .min(1),
});
const matrix = z.object({
  rows: z.array(
    z.object({
      elements: z.array(
        z.object({
          distance: z.number().nonnegative(),
          duration: z.number().nonnegative(),
          status: z.literal('OK'),
        }),
      ),
    }),
  ),
});
const convertPlace = (p: z.infer<typeof place>): Place => ({
  id: p.place_id,
  description: p.formatted_address,
  location: p.geometry.location,
});
const coord = (p: Point) => `${p.lat},${p.lng}`;
export class MapsProviderError extends Error {
  constructor(
    readonly code:
      'ExternalServiceUnavailable' | 'ExternalServiceRejected' | 'ExternalServiceTimeout',
  ) {
    super(code);
  }
}
/** API URLs/methods follow Ola's public reference, 2026-11-06. */
export class OlaMaps implements MapsPort {
  private failures = 0;
  private openUntil = 0;
  private halfOpen = false;
  constructor(
    private readonly config: OlaConfig,
    private readonly budget: () => Promise<{ topK: number; maxPairs: number }>,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  private async call(
    path: string,
    params: Record<string, string>,
    method: 'GET' | 'POST' = 'GET',
  ): Promise<unknown> {
    if (this.openUntil > Date.now() || (this.openUntil !== 0 && this.halfOpen))
      throw new MapsProviderError('ExternalServiceUnavailable');
    if (this.openUntil !== 0) this.halfOpen = true;
    const url = new URL(path, this.config.baseUrl);
    if (url.origin !== new URL(this.config.baseUrl).origin) throw new Error('INVALID_MAPS_PATH');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    url.searchParams.set('api_key', this.config.apiKey);
    try {
      let lastError: MapsProviderError = new MapsProviderError('ExternalServiceUnavailable');
      for (let attempt = 0; attempt < this.config.maxAttempts; attempt++) {
        try {
          const response = await this.fetcher(url, {
            method,
            redirect: 'error',
            signal: AbortSignal.timeout(this.config.timeoutMs),
          });
          if (!response.ok) {
            if (response.status < 500 && response.status !== 429)
              throw new MapsProviderError('ExternalServiceRejected');
            throw new MapsProviderError('ExternalServiceUnavailable');
          }
          const body = await response.text();
          if (body.length > 1_048_576) throw new MapsProviderError('ExternalServiceRejected');
          const value: unknown = JSON.parse(body);
          this.failures = 0;
          this.openUntil = 0;
          return value;
        } catch (error) {
          if (error instanceof MapsProviderError && error.code === 'ExternalServiceRejected')
            throw error;
          lastError =
            error instanceof DOMException && error.name === 'TimeoutError'
              ? new MapsProviderError('ExternalServiceTimeout')
              : new MapsProviderError('ExternalServiceUnavailable');
          if (attempt + 1 < this.config.maxAttempts)
            await delay(Math.floor(Math.random() * 100 * (attempt + 1)));
        }
      }
      this.failures += 1;
      if (this.failures >= this.config.breakerFailures || this.halfOpen)
        this.openUntil = Date.now() + this.config.breakerCooldownMs;
      throw lastError;
    } finally {
      this.halfOpen = false;
    }
  }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new MapsProviderError('ExternalServiceRejected');
    return result.data;
  }
  async autocomplete(input: string): Promise<Suggestion[]> {
    const data = this.parse(
      predictions,
      await this.call(this.config.paths.autocomplete, { input }),
    );
    return data.predictions.map((p) => ({ id: p.place_id, description: p.description }));
  }
  async placeDetails(id: string): Promise<Place> {
    const data = this.parse(details, await this.call(this.config.paths.details, { place_id: id }));
    if (data.status === 'zero_results') throw new Error('PLACE_NOT_FOUND');
    return convertPlace(data.result);
  }
  async geocode(address: string): Promise<Place[]> {
    return this.parse(
      geocoding,
      await this.call(this.config.paths.geocode, { address }),
    ).geocodingResults.map(convertPlace);
  }
  async reverseGeocode(point: Point): Promise<Place[]> {
    return this.parse(
      reverse,
      await this.call(this.config.paths.reverse, { latlng: coord(point) }),
    ).results.map(convertPlace);
  }
  async directions(origin: Point, destination: Point): Promise<RouteEstimate> {
    const data = this.parse(
      routes,
      await this.call(
        this.config.paths.directions,
        { origin: coord(origin), destination: coord(destination) },
        'POST',
      ),
    );
    const legs = data.routes[0]!.legs;
    return {
      distanceMetres: legs.reduce((sum, leg) => sum + leg.distance, 0),
      durationSeconds: legs.reduce((sum, leg) => sum + leg.duration, 0),
      degraded: false,
    };
  }
  async distanceMatrix(origins: Point[], destinations: Point[]): Promise<RouteEstimate[][]> {
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
    const data = this.parse(
      matrix,
      await this.call(this.config.paths.matrix, {
        origins: origins.map(coord).join('|'),
        destinations: destinations.map(coord).join('|'),
      }),
    );
    if (
      data.rows.length !== origins.length ||
      data.rows.some((row) => row.elements.length !== destinations.length)
    )
      throw new MapsProviderError('ExternalServiceRejected');
    return data.rows.map((row) =>
      row.elements.map((item) => ({
        distanceMetres: item.distance,
        durationSeconds: item.duration,
        degraded: false,
      })),
    );
  }
}
