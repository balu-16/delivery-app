import { createHash } from 'node:crypto';
import type pino from 'pino';
import type {
  MapsCache,
  MapsPort,
  Place,
  Point,
  RouteEstimate,
  Suggestion,
} from '../../modules/serviceability/contracts/maps.js';
import { FakeMaps } from './fake.js';
import { MapsProviderError } from './ola.js';

type MapsLogger = Pick<pino.Logger, 'info' | 'warn' | 'error'>;

/** Cache keys contain hashes, never plaintext addresses or coordinates. */
export class ResilientMaps implements MapsPort {
  constructor(
    private readonly remote: MapsPort,
    private readonly cache: MapsCache,
    private readonly settings: () => Promise<{
      cacheTtlSeconds: number;
      speedKph: number;
      topK: number;
      maxPairs: number;
    }>,
    private readonly provider: string = 'unknown',
    private readonly logger?: MapsLogger,
  ) {}
  private async cachedPlaces(
    operation: string,
    input: string,
    query: () => Promise<Place[]>,
  ): Promise<Place[]> {
    const { cacheTtlSeconds } = await this.settings();
    if (!Number.isSafeInteger(cacheTtlSeconds) || cacheTtlSeconds < 1)
      throw new Error('INVALID_MAP_CACHE_TTL');
    const key = `maps:${this.provider}:${operation}:${createHash('sha256').update(input).digest('hex')}`;
    const fresh = await this.cache.get(key).catch(() => null);
    if (fresh) return JSON.parse(fresh) as Place[];
    try {
      const result = await query();
      if (result.length) {
        const data = JSON.stringify(result);
        await Promise.all([
          this.cache.set(key, data, cacheTtlSeconds),
          this.cache.set(`${key}:stale`, data, cacheTtlSeconds * 2),
        ]).catch(() => undefined);
      }
      return result;
    } catch (error) {
      if (!(error instanceof MapsProviderError) || error.code === 'ExternalServiceRejected')
        throw error;
      const stale = await this.cache.get(`${key}:stale`).catch(() => null);
      if (!stale) throw error;
      return (JSON.parse(stale) as Place[]).map((item) => ({ ...item, degraded: true }));
    }
  }
  autocomplete(input: string): Promise<Suggestion[]> {
    return this.remote.autocomplete(input);
  }
  async placeDetails(id: string): Promise<Place> {
    const places = await this.cachedPlaces('details', id, async () => [
      await this.remote.placeDetails(id),
    ]);
    if (!places[0]) throw new Error('PLACE_NOT_FOUND');
    return places[0];
  }
  geocode(address: string): Promise<Place[]> {
    const normalized = address.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');
    return this.cachedPlaces('geocode', normalized, () => this.remote.geocode(address));
  }
  reverseGeocode(point: Point): Promise<Place[]> {
    return this.cachedPlaces('reverse', `${point.lat},${point.lng}`, () =>
      this.remote.reverseGeocode(point),
    );
  }
  async directions(origin: Point, destination: Point): Promise<RouteEstimate> {
    try {
      return await this.remote.directions(origin, destination);
    } catch (error) {
      if (!(error instanceof MapsProviderError)) throw error;
      const estimate = await new FakeMaps([], (await this.settings()).speedKph).directions(
        origin,
        destination,
      );
      this.logger?.warn({ operation: 'directions', outcome: 'fallback' }, 'maps estimate fallback');
      return estimate;
    }
  }
  async distanceMatrix(
    origins: Point[],
    destinations: Point[],
  ): Promise<(RouteEstimate | null)[][]> {
    const settings = await this.settings();
    if (
      !Number.isSafeInteger(settings.topK) ||
      settings.topK < 1 ||
      !Number.isSafeInteger(settings.maxPairs) ||
      settings.maxPairs < 1 ||
      settings.maxPairs > 50 ||
      origins.length < 1 ||
      destinations.length < 1 ||
      origins.length > settings.topK ||
      origins.length * destinations.length > settings.maxPairs
    )
      throw new Error('MATRIX_BUDGET_EXCEEDED');
    const pairs = origins.length * destinations.length;
    try {
      const remote = await this.remote.distanceMatrix(origins, destinations);
      if (remote.length !== origins.length)
        throw new MapsProviderError('ExternalServiceUnavailable');
      if (remote.some((row) => row.length !== destinations.length))
        throw new MapsProviderError('ExternalServiceUnavailable');
      let fallbackCells = 0;
      const fallback = new FakeMaps([], settings.speedKph);
      const filled: RouteEstimate[][] = [];
      for (let i = 0; i < origins.length; i++) {
        const row: RouteEstimate[] = [];
        for (let j = 0; j < destinations.length; j++) {
          const cell = remote[i]?.[j];
          if (cell) {
            row.push(cell);
          } else {
            row.push(await fallback.directions(origins[i]!, destinations[j]!));
            fallbackCells += 1;
          }
        }
        filled.push(row);
      }
      if (fallbackCells > 0)
        this.logger?.warn(
          { operation: 'distanceMatrix', outcome: 'partial_fallback', pairs, fallbackCells },
          'maps estimate fallback',
        );
      else
        this.logger?.info(
          { operation: 'distanceMatrix', outcome: 'success', pairs, fallbackCells },
          'maps provider request',
        );
      return filled;
    } catch (error) {
      if (!(error instanceof MapsProviderError)) throw error;
      const whole = await new FakeMaps([], settings.speedKph).distanceMatrix(origins, destinations);
      this.logger?.warn(
        { operation: 'distanceMatrix', outcome: 'fallback', pairs, fallbackCells: pairs },
        'maps estimate fallback',
      );
      return whole;
    }
  }
}
