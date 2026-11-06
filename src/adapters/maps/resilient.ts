import { createHash } from 'node:crypto';
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
  ) {}
  private async cachedPlaces(
    operation: string,
    input: string,
    query: () => Promise<Place[]>,
  ): Promise<Place[]> {
    const { cacheTtlSeconds } = await this.settings();
    if (!Number.isSafeInteger(cacheTtlSeconds) || cacheTtlSeconds < 1)
      throw new Error('INVALID_MAP_CACHE_TTL');
    const key = `maps:${operation}:${createHash('sha256').update(input).digest('hex')}`;
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
      if (!(error instanceof MapsProviderError) || error.code === 'ExternalServiceRejected')
        throw error;
      return new FakeMaps([], (await this.settings()).speedKph).directions(origin, destination);
    }
  }
  async distanceMatrix(origins: Point[], destinations: Point[]): Promise<RouteEstimate[][]> {
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
    try {
      return await this.remote.distanceMatrix(origins, destinations);
    } catch (error) {
      if (!(error instanceof MapsProviderError) || error.code === 'ExternalServiceRejected')
        throw error;
      return new FakeMaps([], settings.speedKph).distanceMatrix(origins, destinations);
    }
  }
}
