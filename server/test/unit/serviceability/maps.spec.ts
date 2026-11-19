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
) as {
  directions: unknown;
  matrix: unknown;
  directionsMultiLeg: unknown;
  matrixMixed: unknown;
  placeWithPincode: unknown;
  placeWithBadPincode: unknown;
};
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
  it('returns empty lists for valid zero-result and empty-ok envelopes', async () => {
    const fetcher: typeof fetch = async (request) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith('autocomplete')) return Response.json({ status: 'zero_results' });
      if (url.pathname.endsWith('reverse-geocode'))
        return Response.json({ status: 'ok', results: [] });
      return Response.json({ status: 'zero_results' });
    };
    const maps = new OlaMaps(config, settings, fetcher);
    await expect(maps.autocomplete('nowhere')).resolves.toEqual([]);
    await expect(maps.geocode('nowhere')).resolves.toEqual([]);
    await expect(maps.reverseGeocode(origin)).resolves.toEqual([]);
    const okEmpty: typeof fetch = async () => Response.json({ status: 'ok', predictions: [] });
    await expect(new OlaMaps(config, settings, okEmpty).autocomplete('q')).resolves.toEqual([]);
  });
  it('extracts a six-digit postal_code pincode and omits absent or malformed ones', async () => {
    const fixture = routingFixture;
    const fetcher: typeof fetch = async (request) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith('details'))
        return Response.json(
          url.searchParams.get('place_id') === 'bad'
            ? { status: 'ok', result: fixture.placeWithBadPincode }
            : { status: 'ok', result: fixture.placeWithPincode },
        );
      return Response.json({ status: 'ok', geocodingResults: [fixture.placeWithPincode] });
    };
    const maps = new OlaMaps(config, settings, fetcher);
    await expect(maps.geocode('Vijayawada Junction')).resolves.toEqual([
      {
        id: 'ola-platform:pin',
        description: 'Vijayawada Junction, Vijayawada, Andhra Pradesh 520001, India',
        location: { lat: 16.5169, lng: 80.6169 },
        pincode: '520001',
      },
    ]);
    const bad = await maps.placeDetails('bad');
    expect(bad).not.toHaveProperty('pincode');
    const bare = { place_id: 'x', formatted_address: 'X', geometry: { location: origin } };
    const bareMaps = new OlaMaps(config, settings, async () =>
      Response.json({ status: 'ok', result: bare }),
    );
    expect(await bareMaps.placeDetails('x')).not.toHaveProperty('pincode');
  });
  it('sums multi-leg directions from the fixture', async () => {
    const fetcher: typeof fetch = async () => Response.json(routingFixture.directionsMultiLeg);
    await expect(
      new OlaMaps(config, settings, fetcher).directions(origin, destination),
    ).resolves.toEqual({
      distanceMetres: 3500,
      durationSeconds: 600,
      degraded: false,
    });
  });
  it('rejects credentials and permanent 4xx once; only credentials suppress repeats', async () => {
    for (const status of [401, 403]) {
      let calls = 0;
      const maps = new OlaMaps(config, settings, async () => {
        calls++;
        return new Response('no', { status });
      });
      await expect(maps.autocomplete('x')).rejects.toMatchObject({
        code: 'ExternalServiceRejected',
      });
      expect(calls).toBe(1);
      // Suppressed: the repeat fails fast without a provider call.
      await expect(maps.autocomplete('x')).rejects.toMatchObject({
        code: 'ExternalServiceUnavailable',
      });
      expect(calls).toBe(1);
    }
    // A permanent 4xx ends the call without suppression: the next call retries.
    let calls400 = 0;
    const maps400 = new OlaMaps(config, settings, async () => {
      calls400++;
      return new Response('no', { status: 400 });
    });
    await expect(maps400.autocomplete('x')).rejects.toMatchObject({
      code: 'ExternalServiceRejected',
    });
    await expect(maps400.autocomplete('x')).rejects.toMatchObject({
      code: 'ExternalServiceRejected',
    });
    expect(calls400).toBe(2);
  });
  it('pauses after a 429 for at least the Retry-After window', async () => {
    let calls = 0;
    const maps = new OlaMaps(config, settings, async () => {
      calls++;
      return new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '120' },
      });
    });
    await expect(maps.autocomplete('x')).rejects.toMatchObject({
      code: 'ExternalServiceUnavailable',
    });
    expect(calls).toBe(1);
    // Breaker is open for the longer of cooldown and Retry-After: no provider call.
    await expect(maps.autocomplete('x')).rejects.toMatchObject({
      code: 'ExternalServiceUnavailable',
    });
    expect(calls).toBe(1);
  });
  it('maps malformed JSON to a rejected error without retry', async () => {
    let calls = 0;
    const maps = new OlaMaps(config, settings, async () => {
      calls++;
      return new Response('not-json{{{', { status: 200 });
    });
    await expect(maps.autocomplete('x')).rejects.toMatchObject({
      code: 'ExternalServiceRejected',
    });
    expect(calls).toBe(1);
  });
  it('maps redirect failures to a rejected error without retry', async () => {
    let calls = 0;
    const maps = new OlaMaps(config, settings, async () => {
      calls++;
      throw new Error('redirect mode is set to "error"');
    });
    await expect(maps.autocomplete('x')).rejects.toMatchObject({
      code: 'ExternalServiceRejected',
    });
    expect(calls).toBe(1);
  });
  it('retries transient 5xx within the attempt limit and stops at the limit', async () => {
    const retryConfig = { ...config, maxAttempts: 2, timeoutMs: 1000, breakerFailures: 5 };
    let calls = 0;
    const flaky: typeof fetch = async () => {
      calls++;
      if (calls === 1) return new Response('boom', { status: 500 });
      return Response.json({ status: 'ok', predictions: [] });
    };
    // Autocomplete is single-attempt by contract: the 500 surfaces immediately.
    await expect(new OlaMaps(retryConfig, settings, flaky).autocomplete('x')).rejects.toMatchObject(
      { code: 'ExternalServiceUnavailable' },
    );
    expect(calls).toBe(1);
    calls = 0;
    const alwaysDown: typeof fetch = async () => {
      calls++;
      return new Response('down', { status: 503 });
    };
    const down = new OlaMaps(retryConfig, settings, alwaysDown);
    await expect(down.directions(origin, destination)).rejects.toMatchObject({
      code: 'ExternalServiceUnavailable',
    });
    expect(calls).toBe(2);
    calls = 0;
    const recovers: typeof fetch = async () => {
      calls++;
      return calls === 1
        ? new Response('boom', { status: 502 })
        : Response.json(routingFixture.directions);
    };
    await expect(
      new OlaMaps(retryConfig, settings, recovers).directions(origin, destination),
    ).resolves.toEqual({
      distanceMetres: 3836,
      durationSeconds: 698,
      degraded: false,
    });
    expect(calls).toBe(2);
  });
  it('enforces the total time budget across retried attempts', async () => {
    const slow: typeof fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return Response.json({ status: 'ok', predictions: [] });
    };
    const budgeted = { ...config, timeoutMs: 30, maxAttempts: 3, breakerFailures: 5 };
    const started = Date.now();
    await expect(new OlaMaps(budgeted, settings, slow).autocomplete('x')).rejects.toMatchObject({
      code: 'ExternalServiceTimeout',
    });
    const elapsed = Date.now() - started;
    // A single autocomplete attempt plus the budget gate: well under 3x the budget.
    expect(elapsed).toBeLessThan(90);
  });
  it('times out slowly resolving fetches', async () => {
    const slow: typeof fetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return Response.json({ status: 'ok', predictions: [] });
    };
    await expect(new OlaMaps(config, settings, slow).geocode('x')).rejects.toMatchObject({
      code: 'ExternalServiceTimeout',
    });
  });
  it('keeps request IDs on the wire and sanitizes logs and errors', async () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = {
      info: (fields: Record<string, unknown>) => records.push(fields),
      warn: (fields: Record<string, unknown>) => records.push(fields),
      error: (fields: Record<string, unknown>) => records.push(fields),
    };
    const headers: unknown[] = [];
    const urls: string[] = [];
    const fetcher: typeof fetch = async (request, init) => {
      urls.push(String(request));
      headers.push(init?.headers);
      return Response.json({
        status: 'ok',
        geocodingResults: [
          {
            place_id: 'p1',
            formatted_address: 'Secret Family Address Lane 42',
            geometry: { location: { lat: 16.5169, lng: 80.6169 } },
          },
        ],
      });
    };
    const maps = new OlaMaps(config, settings, fetcher, logger as never);
    await maps.geocode('Secret Family Address Lane 42');
    expect(headers[0]).toMatchObject({ 'X-Request-Id': expect.any(String) });
    expect(urls[0]).toContain('api_key=fixture');
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain('fixture');
    expect(serialized).not.toContain('api_key');
    expect(serialized).not.toContain('Secret Family');
    expect(serialized).not.toContain('16.5169');
    expect(serialized).not.toContain('api.olamaps.io');
    expect(records[0]).toMatchObject({
      operation: 'geocode',
      outcome: 'success',
      requestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      ),
    });
    expect(records[0]?.elapsedMs).toEqual(expect.any(Number));
    // Error messages stay code-only.
    const failing = new OlaMaps(config, settings, async () => new Response('x', { status: 401 }));
    const failure = await failing.autocomplete('Hidden Home Town').catch((e: unknown) => e);
    expect(String(failure)).not.toContain('Hidden Home Town');
    expect(String(failure)).not.toContain('fixture');
  });
  it('encodes query parameters and joins matrix points latitude-first with pipes', async () => {
    const calls: URL[] = [];
    const fetcher: typeof fetch = async (request) => {
      const url = new URL(String(request));
      calls.push(url);
      if (url.pathname.endsWith('basic'))
        return Response.json({
          status: 'SUCCESS',
          rows: [
            { elements: [{ status: 'OK', distance: 100, duration: 10 }] },
            { elements: [{ status: 'OK', distance: 200, duration: 20 }] },
          ],
        });
      return Response.json({ status: 'ok', predictions: [] });
    };
    const maps = new OlaMaps(config, settings, fetcher);
    await maps.autocomplete('Vijayawada Junction & Co');
    expect(calls[0]?.searchParams.get('input')).toBe('Vijayawada Junction & Co');
    expect(calls[0]?.toString()).not.toContain('Junction & Co');
    await maps.distanceMatrix([origin, destination], [origin]);
    expect(calls[1]?.searchParams.get('origins')).toBe('12.9,77.6|13,77.7');
    expect(calls[1]?.searchParams.get('destinations')).toBe('12.9,77.6');
  });
  it('preserves valid matrix cells and falls back only to failed cells', async () => {
    const mixed = routingFixture.matrixMixed;
    const fetcher: typeof fetch = async () => Response.json(mixed);
    const ola = new OlaMaps(config, settings, fetcher);
    const resilient = new ResilientMaps(
      ola,
      { get: async () => null, set: async () => undefined },
      settings,
      'ola',
    );
    const matrix = await resilient.distanceMatrix([origin], [origin, destination]);
    expect(matrix[0]?.[0]).toEqual({ distanceMetres: 3000, durationSeconds: 600, degraded: false });
    expect(matrix[0]?.[1]?.degraded).toBe(true);
    expect(matrix[0]?.[1]?.distanceMetres).toBeGreaterThan(0);
  });
  it('uses whole-batch estimates after key rejection, timeout, or bad envelope', async () => {
    const variants: Array<{ name: string; fetcher: typeof fetch }> = [
      { name: 'rejected-key', fetcher: async () => new Response('no', { status: 401 }) },
      {
        name: 'timeout',
        fetcher: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return Response.json({ status: 'ok', predictions: [] });
        },
      },
      {
        name: 'bad-envelope',
        fetcher: async () => Response.json({ status: 'SUCCESS', rows: [{ elements: [] }] }),
      },
    ];
    for (const variant of variants) {
      const ola = new OlaMaps(config, settings, variant.fetcher);
      const resilient = new ResilientMaps(
        ola,
        { get: async () => null, set: async () => undefined },
        settings,
        'ola',
      );
      const matrix = await resilient.distanceMatrix([origin], [destination]);
      expect(variant.name ? matrix : null).toHaveLength(1);
      expect(matrix[0]?.[0]?.degraded).toBe(true);
    }
  });
  it('enforces Ola pair and topK caps before any provider call', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return Response.json(routingFixture.matrix);
    };
    const ola = new OlaMaps(config, settings, fetcher);
    await expect(ola.distanceMatrix([origin, origin, origin], [destination])).rejects.toThrow(
      'MATRIX_BUDGET_EXCEEDED',
    );
    expect(calls).toBe(0);
    const resilient = new ResilientMaps(
      ola,
      { get: async () => null, set: async () => undefined },
      settings,
      'ola',
    );
    await expect(
      resilient.distanceMatrix(
        [origin],
        [destination, destination, destination, destination, destination],
      ),
    ).rejects.toThrow('MATRIX_BUDGET_EXCEEDED');
    expect(calls).toBe(0);
  });
  it('namespaces expiring place caches by provider and serves stale as degraded', async () => {
    const keys: string[] = [];
    const store = new Map<string, string>();
    const cache = {
      get: async (key: string) => {
        keys.push(key);
        return store.get(key) ?? null;
      },
      set: async (key: string, value: string) => {
        store.set(key, value);
      },
    };
    const place = {
      id: 'p1',
      description: 'Cached Place',
      location: { lat: 12.9, lng: 77.6 },
    };
    const remote = {
      autocomplete: async () => [{ id: 'p1', description: 'x' }],
      placeDetails: async () => place,
      geocode: async () => [place],
      reverseGeocode: async () => [place],
      directions: async () => ({ distanceMetres: 1, durationSeconds: 1, degraded: false }),
      distanceMatrix: async () => [[{ distanceMetres: 1, durationSeconds: 1, degraded: false }]],
    };
    const resilient = new ResilientMaps(remote as never, cache, settings, 'ola');
    await resilient.geocode('Cached Place');
    expect(keys.some((key) => key.startsWith('maps:ola:geocode:'))).toBe(true);
    const staleKey = [...store.keys()].find((key) => key.endsWith(':stale'));
    expect(staleKey).toBeDefined();
    // Expire the fresh entry so the stale path is reachable; a transient
    // failure then serves stale flagged degraded.
    for (const key of [...store.keys()]) if (!key.endsWith(':stale')) store.delete(key);
    const timingOut = {
      ...remote,
      geocode: async () => {
        throw new MapsProviderError('ExternalServiceTimeout');
      },
    };
    const degradedFromStale = await new ResilientMaps(
      timingOut as never,
      cache,
      settings,
      'ola',
    ).geocode('Cached Place');
    expect(degradedFromStale[0]?.degraded).toBe(true);
  });
});
