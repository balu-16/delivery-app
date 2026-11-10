import { readFileSync } from 'node:fs';
import { OlaMaps, MapsProviderError, type OlaConfig } from '../../../src/adapters/maps/ola.js';
import { FakeMaps } from '../../../src/adapters/maps/fake.js';
import { ResilientMaps } from '../../../src/adapters/maps/resilient.js';
import { Addresses } from '../../../src/modules/addresses/application/addresses.js';
import type { AddressRepository } from '../../../src/modules/addresses/contracts/addresses.js';

// Documented response fields and request shapes: https://maps.olakrutrim.com/apidocs,
// routing directions and distanceMatrix/basic examples, checked 2026-11-06.
// Places and geocoding fields and zero-result variants are from the provider's published
// https://maps.olakrutrim.com/openapi/ola-maps-apis-oas.yaml, checked 2026-11-06.
const routingFixture = JSON.parse(
  readFileSync(new URL('./fixtures/ola-routing.json', import.meta.url), 'utf8'),
) as { directions: unknown; matrix: unknown };
const config: OlaConfig = {
  baseUrl: 'https://api.olamaps.io',
  apiKey: 'fixture',
  timeoutMs: 20,
  maxAttempts: 1,
  breakerFailures: 1,
  breakerCooldownMs: 10000,
  paths: {
    autocomplete: '/places/v1/autocomplete',
    details: '/places/v1/details',
    geocode: '/places/v1/geocode',
    reverse: '/places/v1/reverse-geocode',
    directions: '/routing/v1/directions',
    matrix: '/routing/v1/distanceMatrix/basic',
  },
};
const origin = { lat: 12.9, lng: 77.6 },
  destination = { lat: 13, lng: 77.7 };
const settings = async () => ({ cacheTtlSeconds: 60, speedKph: 20, topK: 2, maxPairs: 4 });
describe('maps provider contracts and degradation', () => {
  it('translates documented autocomplete, details, forward and reverse response envelopes', async () => {
    const item = {
      place_id: 'ola-platform:1',
      formatted_address: 'Mumbai, India',
      geometry: { location: { lat: 19.115354, lng: 72.873658 } },
    };
    const calls: URL[] = [];
    const fetcher: typeof fetch = async (request) => {
      const url = new URL(String(request));
      calls.push(url);
      if (url.pathname.endsWith('autocomplete'))
        return Response.json({
          status: 'ok',
          predictions: [{ place_id: item.place_id, description: item.formatted_address }],
        });
      if (url.pathname.endsWith('details'))
        return Response.json(
          url.searchParams.get('place_id') === 'missing'
            ? { status: 'zero_results' }
            : { status: 'ok', result: item },
        );
      if (url.pathname.endsWith('reverse-geocode'))
        return Response.json({ status: 'ok', results: [item] });
      return Response.json({ status: 'ok', geocodingResults: [item] });
    };
    const maps = new OlaMaps(config, settings, fetcher);
    const expected = {
      id: item.place_id,
      description: item.formatted_address,
      location: item.geometry.location,
    };
    expect(await maps.autocomplete('Mumbai')).toEqual([
      { id: item.place_id, description: item.formatted_address },
    ]);
    expect(await maps.placeDetails(item.place_id)).toEqual(expected);
    expect(await maps.geocode('Mumbai')).toEqual([expected]);
    expect(await maps.reverseGeocode(origin)).toEqual([expected]);
    await expect(maps.placeDetails('missing')).rejects.toThrow('PLACE_NOT_FOUND');
    expect(calls[2]?.searchParams.get('address')).toBe('Mumbai');
    expect(calls[3]?.searchParams.get('latlng')).toBe('12.9,77.6');
  });
  it('uses documented methods, parameters and numeric routing fields', async () => {
    const calls: Array<{ url: URL; method: string | undefined }> = [];
    const fetcher: typeof fetch = async (request, init) => {
      const url = new URL(String(request));
      calls.push({ url, method: init?.method });
      return Response.json(
        url.pathname.endsWith('basic') ? routingFixture.matrix : routingFixture.directions,
      );
    };
    const maps = new OlaMaps(config, settings, fetcher);
    expect(await maps.directions(origin, destination)).toEqual({
      distanceMetres: 3836,
      durationSeconds: 698,
      degraded: false,
    });
    expect(await maps.distanceMatrix([origin], [destination])).toEqual([
      [{ distanceMetres: 3224, durationSeconds: 719, degraded: false }],
    ]);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url.searchParams.get('origin')).toBe('12.9,77.6');
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.url.searchParams.get('destinations')).toBe('13,77.7');
    await expect(maps.distanceMatrix([origin, origin, origin], [destination])).rejects.toThrow(
      'MATRIX_BUDGET_EXCEEDED',
    );
    expect(calls).toHaveLength(2);
  });
  it('opens the breaker and falls back to haversine without provider calls per ping', async () => {
    let calls = 0;
    const maps = new OlaMaps(config, settings, async () => {
      calls++;
      throw new Error('network');
    });
    const cache = { get: async () => null, set: async () => undefined };
    const resilient = new ResilientMaps(maps, cache, settings);
    expect((await resilient.directions(origin, destination)).degraded).toBe(true);
    expect((await resilient.directions(origin, destination)).degraded).toBe(true);
    expect(calls).toBe(1);
    await expect(maps.autocomplete('abc')).rejects.toBeInstanceOf(MapsProviderError);
  });
  it('flags a geocode/pin mismatch and permits address writes when maps fail', async () => {
    const draft = {
      line1: 'Road',
      pincode: '560001',
      contactName: 'A',
      contactPhone: '+919876543210',
      point: origin,
    };
    const repository = {
      create: async (_user: string, value: typeof draft) => ({
        ...value,
        id: 'address',
        isDefault: true,
        version: '1',
      }),
    } as unknown as AddressRepository;
    const remote = new FakeMaps(
      [{ id: 'x', description: 'Road, 560001', location: destination }],
      20,
    );
    const addresses = new Addresses(
      repository,
      async () => 10,
      remote,
      async () => 100,
    );
    expect(await addresses.create('u', draft)).toMatchObject({
      needsConfirmation: true,
      degraded: false,
    });
    const unavailable = new Addresses(
      repository,
      async () => 10,
      {
        ...remote,
        geocode: async () => {
          throw new Error('offline');
        },
      } as unknown as FakeMaps,
      async () => 100,
    );
    expect(await unavailable.create('u', draft)).toMatchObject({
      needsConfirmation: false,
      degraded: true,
    });
  });
});
