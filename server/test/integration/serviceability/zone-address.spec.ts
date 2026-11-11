import { resolve } from 'node:path';
import { sql } from 'kysely';
import { runner } from 'node-pg-migrate';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { PostgresAddresses } from '../../../src/modules/addresses/infrastructure/postgres-addresses.js';
import { PostgresZones } from '../../../src/modules/stores/infrastructure/postgres-zones.js';
import { PostgresStoreAvailability } from '../../../src/modules/stores/infrastructure/postgres-availability.js';
import { PostgresServiceability } from '../../../src/modules/serviceability/infrastructure/postgres-serviceability.js';
import { ServiceabilityQuery } from '../../../src/modules/serviceability/application/serviceability.js';
import { ConfigService as AppConfigService } from '../../../src/modules/app-config/infrastructure/config-service.js';
import { PostgresCapacityClaims } from '../../../src/modules/serviceability/infrastructure/postgres-capacity.js';
import { PostgresStoreSignals } from '../../../src/modules/stores/infrastructure/store-signals.js';
import { PostgresStoreAdministration } from '../../../src/modules/stores/infrastructure/store-administration.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { createApplication } from '../../../src/bootstrap.js';
import type { Redis } from 'ioredis';
import { PLATFORM_REDIS } from '../../../src/platform/contracts/runtime.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { createAwsTestQueues, trackAwsTestRateKeys } from '../../helpers/aws-test-queues.js';

let services: TestServices;
let db: DatabaseHandle;
const entity = uuidV7(),
  city = uuidV7(),
  store = uuidV7(),
  user = uuidV7();
const area = { minM2: 1, maxM2: 10_000_000_000 };
const polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [77.5, 12.9],
      [77.7, 12.9],
      [77.7, 13.1],
      [77.5, 13.1],
      [77.5, 12.9],
    ],
  ],
};
const draft = {
  line1: '1 Road',
  pincode: '560001',
  contactName: 'A',
  contactPhone: '+919876543210',
  point: { lat: 13, lng: 77.6 },
};
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
  db = createDatabase(services.databaseUrl);
  await sql`INSERT INTO legal_entities(id,name) VALUES (${entity},'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES (${city},'city', ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES (${store},${entity},${city},'store',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',2)`.execute(
    db.db,
  );
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${user},'CUSTOMER','sub','test@example.com','test')`.execute(
    db.db,
  );
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);

describe('P2 serviceability against PostGIS', () => {
  it('validates polygons and includes boundary points', async () => {
    const zones = new PostgresZones(db.db);
    await expect(
      zones.create(
        {
          storeId: store,
          name: 'bad',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [77.5, 12.9],
                [77.7, 13.1],
                [77.7, 12.9],
                [77.5, 13.1],
                [77.5, 12.9],
              ],
            ],
          },
          priority: 1,
          active: true,
        },
        area,
      ),
    ).rejects.toThrow('INVALID_ZONE_GEOMETRY');
    const zone = await zones.create(
      { storeId: store, name: 'zone', geometry: polygon, priority: 1, active: true },
      area,
    );
    const repository = new PostgresServiceability(
      db.db,
      'Asia/Kolkata',
      new PostgresStoreAvailability(db.db, 'Asia/Kolkata'),
      async () => false,
    );
    const result = await repository.findCandidate({
      lat: 12.9,
      lng: 77.5,
      targetTime: new Date('2026-11-02T12:00:00Z'),
    });
    expect(result?.zone.zoneId).toBe(zone.id);
    expect(
      await repository.findCandidate({
        lat: 12.8,
        lng: 77.5,
        targetTime: new Date('2026-11-02T12:00:00Z'),
      }),
    ).toBeNull();
  });
  it('uses a single caller connection and isolates transactional zone changes from the cache', async () => {
    const single = createDatabase(services.databaseUrl, 1);
    const ownStore = uuidV7();
    const ownZone = uuidV7();
    const input = { lat: 13.5, lng: 77.6, targetTime: new Date('2026-11-02T12:00:00Z') };
    const cache = new Map<string, string>();
    try {
      await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES (${ownStore},${entity},${city},'transaction',ST_SetSRID(ST_MakePoint(77.6,13.5),4326)::geography,'ONLINE',2)`.execute(
        single.db,
      );
      await sql`INSERT INTO store_hours(store_id,weekday,start_minute,end_minute) SELECT ${ownStore},d,0,1440 FROM generate_series(0,6) d`.execute(
        single.db,
      );
      await sql`INSERT INTO zones(id,store_id,name,polygon,priority,active) VALUES (${ownZone},${ownStore},'transaction',ST_Multi(ST_GeomFromText('POLYGON((77.5 13.4,77.7 13.4,77.7 13.6,77.5 13.6,77.5 13.4))',4326)),1,true)`.execute(
        single.db,
      );
      const config = new AppConfigService(single.db);
      const signals = new PostgresStoreSignals(single.db, async (tx) => ({
        backlog: await config.get('storeBacklogPauseThreshold', tx),
        minutes: await config.get('storeNoRidersPauseMinutes', tx),
      }));
      const repository = new PostgresServiceability(
        single.db,
        'Asia/Kolkata',
        new PostgresStoreAvailability(single.db, 'Asia/Kolkata'),
        (id, at, tx) => signals.noRiders(id, at, tx),
        {
          get: async (key) => cache.get(key) ?? null,
          set: async (key, value) => {
            cache.set(key, value);
          },
        },
      );
      const query = new ServiceabilityQuery(repository, async (tx) => ({
        minMinutes: await config.get('etaMinMinutes', tx),
        maxMinutes: await config.get('etaMaxMinutes', tx),
      }));
      expect((await query.check(input)).serviceable).toBe(true);
      const originalCache = [...cache.entries()];
      const rollback = new Error('rollback');
      await expect(
        single.db.transaction().execute(async (tx) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const checked = await Promise.race([
              query.check(input, tx),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('transaction check timed out')),
                  process.env.AWS_P13_INTEGRATION === 'yes' ? 15000 : 3000,
                );
              }),
            ]);
            expect(checked.serviceable).toBe(true);
            await sql`UPDATE zones SET active=false WHERE id=${ownZone}`.execute(tx);
            expect((await query.check(input, tx)).reasons).toEqual(['OUTSIDE_ZONE']);
            expect([...cache.entries()]).toEqual(originalCache);
            throw rollback;
          } finally {
            if (timer) clearTimeout(timer);
          }
        }),
      ).rejects.toBe(rollback);
      expect((await query.check(input)).serviceable).toBe(true);
      expect([...cache.entries()]).toEqual(originalCache);
    } finally {
      await single.close();
    }
  });
  it('serializes concurrent defaults and retains one after delete', async () => {
    const repository = new PostgresAddresses(db.db);
    const made = await Promise.all(
      Array.from({ length: 8 }, () => repository.create(user, draft, 10, true)),
    );
    expect((await repository.list(user)).filter((address) => address.isDefault)).toHaveLength(1);
    await Promise.all(made.slice(0, 4).map((address) => repository.remove(user, address.id)));
    const remaining = await repository.list(user);
    expect(remaining).toHaveLength(4);
    expect(remaining.filter((address) => address.isDefault)).toHaveLength(1);
    await Promise.allSettled([
      repository.remove(user, remaining[0]!.id),
      repository.setDefault(user, remaining[1]!.id),
      repository.create(user, draft, 10, true),
      repository.setDefault(user, remaining[0]!.id),
    ]);
    const afterRace = await repository.list(user);
    expect(afterRace.filter((address) => address.isDefault)).toHaveLength(1);
  });
  it('admits only available capacity under competing claims', async () => {
    const claims = new PostgresCapacityClaims(db.db);
    const slot = new Date('2026-11-03T05:30:00Z');
    const result = await Promise.all(
      Array.from({ length: 10 }, (_, i) => claims.claim(store, slot, `order-${i}`)),
    );
    expect(result.filter((value) => value === 'CLAIMED')).toHaveLength(2);
    expect(result.filter((value) => value === 'AT_CAPACITY')).toHaveLength(8);
    const id = result.findIndex((value) => value === 'CLAIMED');
    expect(await claims.claim(store, slot, `order-${id}`)).toBe('ALREADY_CLAIMED');
    expect(await claims.claim(store, new Date('2026-11-03T06:12:00Z'), 'same-local-hour')).toBe(
      'AT_CAPACITY',
    );
  });
  it('orders overlaps by priority then distance and preserves zone version snapshots', async () => {
    const second = uuidV7();
    await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES (${second},${entity},${city},'near',ST_SetSRID(ST_MakePoint(77.501,12.901),4326)::geography,'ONLINE',2)`.execute(
      db.db,
    );
    const zones = new PostgresZones(db.db);
    const low = await zones.create(
      { storeId: second, name: 'near', geometry: polygon, priority: 1, active: true },
      area,
    );
    const cached = new Map<string, string>();
    const repository = new PostgresServiceability(
      db.db,
      'Asia/Kolkata',
      new PostgresStoreAvailability(db.db, 'Asia/Kolkata'),
      async () => false,
      {
        get: async (key) => cached.get(key) ?? null,
        set: async (key, value) => {
          cached.set(key, value);
        },
      },
    );
    const input = { lat: 12.9, lng: 77.5, targetTime: new Date('2026-11-02T12:00:00Z') };
    const snapshot = (await repository.findCandidate(input))!.zone;
    expect(snapshot.zoneId).toBe(low.id);
    const changed = await zones.update(
      low.id,
      low.version,
      { storeId: second, name: 'near', geometry: polygon, priority: 0, active: true },
      area,
    );
    expect((await repository.findCandidate(input))!.zone.storeId).toBe(store);
    expect(snapshot.zoneVersion).toBe('1');
    expect(changed.version).toBe('2');
  });
  it('persists auto-pause and does not overwrite a manual pause', async () => {
    const id = uuidV7();
    await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES (${id},${entity},${city},'signals',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',2)`.execute(
      db.db,
    );
    const signals = new PostgresStoreSignals(db.db, async () => ({ backlog: 2, minutes: 15 }));
    await signals.observe(id, 3, true, uuidV7());
    const result = await sql<{
      status: string;
      pause_reason: string;
    }>`SELECT status,pause_reason FROM stores WHERE id=${id}`.execute(db.db);
    expect(result.rows[0]).toEqual({ status: 'PAUSED', pause_reason: 'AUTO_PICK_BACKLOG' });
    await sql`UPDATE stores SET pause_reason='manual' WHERE id=${id}`.execute(db.db);
    await signals.observe(id, 5, false, uuidV7());
    const history = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM store_status_history WHERE store_id=${id}`.execute(
      db.db,
    );
    expect(history.rows[0]?.count).toBe('1');
    const timed = uuidV7();
    await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES (${timed},${entity},${city},'timed',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',2)`.execute(
      db.db,
    );
    await signals.observe(timed, 0, false, uuidV7());
    await sql`UPDATE store_operational_signals SET no_riders_since=clock_timestamp()-interval '16 minutes' WHERE store_id=${timed}`.execute(
      db.db,
    );
    await Promise.all([signals.evaluateDue(uuidV7()), signals.evaluateDue(uuidV7())]);
    const timedResult = await sql<{
      status: string;
      pause_reason: string;
    }>`SELECT status,pause_reason FROM stores WHERE id=${timed}`.execute(db.db);
    expect(timedResult.rows[0]).toEqual({ status: 'PAUSED', pause_reason: 'AUTO_NO_RIDERS' });
    const timedHistory = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM store_status_history WHERE store_id=${timed}`.execute(
      db.db,
    );
    expect(timedHistory.rows[0]?.count).toBe('1');
  });
  it('locks admin authority for configuration writes and evaluates target-slot hours', async () => {
    const admin = uuidV7(),
      ordinary = uuidV7();
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${admin},'WORKFORCE','admin','admin@example.com','admin'),(${ordinary},'WORKFORCE','ordinary','ordinary@example.com','ordinary')`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${admin},'ADMIN'),(${ordinary},'PICKER')`.execute(
      db.db,
    );
    const service = new PostgresStoreAdministration(db.db, new DatabaseIdentityAccess(db.db));
    await expect(service.hours(ordinary, store, [])).rejects.toThrow('FORBIDDEN');
    await service.hours(admin, store, [{ weekday: 1, startMinute: 1320, endMinute: 120 }]);
    const availability = new PostgresStoreAvailability(db.db, 'Asia/Kolkata');
    expect(await availability.isOpenAt(store, new Date('2026-11-02T17:30:00Z'))).toBe(true);
    await service.holiday(admin, store, { day: '2026-11-03', closed: true, windows: [] });
    expect(await availability.isOpenAt(store, new Date('2026-11-02T19:00:00Z'))).toBe(false);
    const aud = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM audit_log WHERE actor_id=${admin} AND subject_id=${store}`.execute(
      db.db,
    );
    expect(aud.rows[0]?.count).toBe('2');
    const claims = new PostgresCapacityClaims(db.db);
    const slot = new Date('2030-01-01T10:00:00Z');
    const config = {
      legalEntityId: entity,
      cityId: city,
      name: 'store',
      lat: 13,
      lng: 77.6,
      lastOrderBufferMinutes: 0,
    };
    expect(await claims.claim(store, slot, 'capacity-first')).toBe('CLAIMED');
    await service.saveStore(admin, { ...config, hourlyCapacity: 1 }, store);
    const candidate = new PostgresServiceability(
      db.db,
      'Asia/Kolkata',
      availability,
      async () => false,
    );
    await new PostgresZones(db.db).create(
      { storeId: store, name: 'capacity zone', geometry: polygon, priority: 100, active: true },
      area,
    );
    expect(
      (await candidate.findCandidate({ lat: 12.9, lng: 77.5, targetTime: slot }))
        ?.capacityRemaining,
    ).toBe(false);
    expect(await claims.claim(store, slot, 'capacity-second')).toBe('AT_CAPACITY');
    await service.saveStore(admin, { ...config, hourlyCapacity: 3 }, store);
    expect(
      (await candidate.findCandidate({ lat: 12.9, lng: 77.5, targetTime: slot }))
        ?.capacityRemaining,
    ).toBe(true);
    expect(await claims.claim(store, slot, 'capacity-second')).toBe('CLAIMED');
    expect(await claims.claim(store, slot, 'capacity-third')).toBe('CLAIMED');
    expect(await claims.claim(store, slot, 'capacity-fourth')).toBe('AT_CAPACITY');
    await service.saveStore(admin, { ...config, hourlyCapacity: 2 }, store);
  });
  it(
    'enforces audience, role, strict DTOs and address ownership over HTTP',
    async () => {
      const other = uuidV7(),
        support = uuidV7(),
        picker = uuidV7(),
        manager = uuidV7();
      await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${other},'CUSTOMER','other','other@example.com','other'),(${support},'WORKFORCE','support','support@example.com','support'),(${picker},'WORKFORCE','picker','picker@example.com','picker'),(${manager},'WORKFORCE','manager','manager@example.com','manager')`.execute(
        db.db,
      );
      await sql`INSERT INTO user_roles(user_id,role) VALUES (${user},'CUSTOMER'),(${other},'CUSTOMER'),(${support},'SUPPORT_AGENT'),(${picker},'PICKER'),(${manager},'STORE_MANAGER')`.execute(
        db.db,
      );
      await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${picker},${store},'PICKER'),(${manager},${store},'STORE_MANAGER')`.execute(
        db.db,
      );
      const testQueues =
        process.env.AWS_P13_INTEGRATION === 'yes' ? await createAwsTestQueues() : null;
      try {
        const env = readEnv({
          NODE_ENV: 'test',
          LOG_LEVEL: 'silent',
          APP_ROLE: 'all',
          DATABASE_URL: services.databaseUrl,
          REDIS_URL: services.redisUrl,
          ...(testQueues
            ? {
                CACHE_AUTH: 'elasticache-iam',
                CACHE_URL: process.env.CACHE_URL,
                CACHE_IAM_NAME: process.env.CACHE_IAM_NAME,
                CACHE_IAM_USER: process.env.CACHE_IAM_USER,
                AWS_REGION: process.env.AWS_REGION,
                AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID,
                QUEUE_TRANSPORT: 'sqs',
                SQS_QUEUE_PREFIX: testQueues.prefix,
              }
            : {}),
        });
        const tokens = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, db.db);
        const customer = await tokens.issue('CUSTOMER', 'sub', 'customer', 'access');
        const another = await tokens.issue('CUSTOMER', 'other', 'customer', 'access');
        const limited = await tokens.issue('WORKFORCE', 'support', 'admin', 'access');
        const adminToken = await tokens.issue('WORKFORCE', 'admin', 'admin', 'access');
        const pickerToken = await tokens.issue('WORKFORCE', 'picker', 'store', 'access');
        const managerToken = await tokens.issue('WORKFORCE', 'manager', 'store', 'access');
        const app = await createApplication(env);
        const redis = app.get<Redis>(PLATFORM_REDIS);
        const cleanRateKeys = testQueues ? trackAwsTestRateKeys(redis) : undefined;
        try {
          const server = app.getHttpAdapter().getInstance();
          expect(
            (
              await server.inject({
                method: 'POST',
                url: '/v1/admin/legal-entities',
                headers: { authorization: `Bearer ${limited}` },
                payload: { name: 'denied' },
              })
            ).statusCode,
          ).toBe(403);
          const restricted = [
            { method: 'GET', url: '/v1/admin/legal-entities' },
            { method: 'GET', url: '/v1/admin/cities' },
            { method: 'GET', url: '/v1/admin/stores' },
            { method: 'GET', url: '/v1/admin/zones' },
            { method: 'GET', url: `/v1/admin/stores/${store}/operations` },
            {
              method: 'PATCH',
              url: `/v1/admin/legal-entities/${entity}`,
              payload: { name: 'denied' },
            },
            { method: 'DELETE', url: `/v1/admin/legal-entities/${entity}` },
            {
              method: 'POST',
              url: '/v1/admin/cities',
              payload: { name: 'denied', bounds: polygon },
            },
            {
              method: 'PATCH',
              url: `/v1/admin/cities/${city}`,
              payload: { name: 'denied', bounds: polygon },
            },
            { method: 'DELETE', url: `/v1/admin/cities/${city}` },
            {
              method: 'POST',
              url: '/v1/admin/stores',
              payload: {
                name: 'denied',
                legalEntityId: entity,
                cityId: city,
                lat: 13,
                lng: 77.6,
                hourlyCapacity: 1,
                lastOrderBufferMinutes: 0,
              },
            },
            {
              method: 'PATCH',
              url: `/v1/admin/stores/${store}`,
              payload: {
                name: 'denied',
                legalEntityId: entity,
                cityId: city,
                lat: 13,
                lng: 77.6,
                hourlyCapacity: 1,
                lastOrderBufferMinutes: 0,
              },
            },
            {
              method: 'PATCH',
              url: `/v1/admin/stores/${store}/cod`,
              payload: { enabled: true, version: '1' },
            },
            { method: 'DELETE', url: `/v1/admin/stores/${store}` },
            { method: 'PUT', url: `/v1/admin/stores/${store}/hours`, payload: { entries: [] } },
            {
              method: 'PUT',
              url: `/v1/admin/stores/${store}/holidays`,
              payload: { day: '2026-11-03', closed: true, windows: [] },
            },
            { method: 'DELETE', url: `/v1/admin/stores/${store}/holidays/2026-11-03` },
            {
              method: 'PUT',
              url: `/v1/admin/stores/${store}/staff`,
              payload: { userId: support, role: 'PICKER', active: true },
            },
            {
              method: 'POST',
              url: `/v1/admin/stores/${store}/status`,
              payload: { status: 'ONLINE' },
            },
            {
              method: 'POST',
              url: '/v1/admin/zones',
              payload: {
                storeId: store,
                name: 'denied',
                geometry: polygon,
                priority: 1,
                active: true,
              },
            },
          ] as const;
          for (const operation of restricted) {
            const denied = await server.inject({
              ...operation,
              headers: { authorization: `Bearer ${limited}` },
            });
            expect([operation.method, operation.url, denied.statusCode]).toEqual([
              operation.method,
              operation.url,
              403,
            ]);
          }
          const currentStore = await sql<{
            version: string;
          }>`SELECT version::text FROM stores WHERE id=${store}`.execute(db.db);
          const version = currentStore.rows[0]!.version;
          const invalidCod = await server.inject({
            method: 'PATCH',
            url: `/v1/admin/stores/${store}/cod`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { enabled: 'true', version },
          });
          expect(invalidCod.statusCode).toBe(400);
          const enabledCod = await server.inject({
            method: 'PATCH',
            url: `/v1/admin/stores/${store}/cod`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { enabled: true, version },
          });
          expect(enabledCod.statusCode).toBe(200);
          const updatedCod = enabledCod.json() as { enabled: boolean; version: string };
          expect(updatedCod.enabled).toBe(true);
          const staleCod = await server.inject({
            method: 'PATCH',
            url: `/v1/admin/stores/${store}/cod`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { enabled: false, version },
          });
          expect(staleCod.statusCode).toBe(409);
          const auditCod = await sql<{
            details: { before: boolean; after: boolean };
          }>`SELECT details FROM audit_log WHERE action='STORE_COD_CHANGED' AND subject_id=${store}`.execute(
            db.db,
          );
          expect(auditCod.rows[0]?.details).toEqual({ before: false, after: true });
          const disabledCod = await server.inject({
            method: 'PATCH',
            url: `/v1/admin/stores/${store}/cod`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { enabled: false, version: updatedCod.version },
          });
          expect(disabledCod.statusCode).toBe(200);
          // Deny by role before parsing even a malformed body or path.
          expect(
            (
              await server.inject({
                method: 'PATCH',
                url: '/v1/admin/zones/not-a-uuid',
                headers: { authorization: `Bearer ${limited}` },
                payload: {},
              })
            ).statusCode,
          ).toBe(403);
          expect(
            (
              await server.inject({
                method: 'DELETE',
                url: '/v1/admin/zones/not-a-uuid',
                headers: { authorization: `Bearer ${limited}` },
              })
            ).statusCode,
          ).toBe(403);
          expect(
            (
              await server.inject({
                method: 'POST',
                url: '/v1/store/status',
                headers: { authorization: `Bearer ${pickerToken}` },
                payload: {},
              })
            ).statusCode,
          ).toBe(403);
          expect(
            (
              await server.inject({
                method: 'POST',
                url: '/v1/store/status',
                headers: { authorization: `Bearer ${managerToken}` },
                payload: { storeId: uuidV7(), status: 'ONLINE' },
              })
            ).statusCode,
          ).toBe(404);
          const firstPage = await server.inject({
            method: 'GET',
            url: '/v1/admin/stores?limit=1',
            headers: { authorization: `Bearer ${adminToken}` },
          });
          expect(firstPage.statusCode).toBe(200);
          expect(firstPage.json().items).toHaveLength(1);
          expect(firstPage.json().nextCursor).toBe(firstPage.json().items[0].id);
          const secondPage = await server.inject({
            method: 'GET',
            url: `/v1/admin/stores?limit=1&cursor=${firstPage.json().nextCursor}`,
            headers: { authorization: `Bearer ${adminToken}` },
          });
          expect(secondPage.statusCode).toBe(200);
          expect(secondPage.json().items[0].id).not.toBe(firstPage.json().items[0].id);
          expect(
            (
              await server.inject({
                method: 'GET',
                url: '/v1/admin/stores?limit=101',
                headers: { authorization: `Bearer ${adminToken}` },
              })
            ).statusCode,
          ).toBe(400);
          await sql`INSERT INTO store_holidays(store_id,day,closed) VALUES(${store},'2026-11-04',true)`.execute(
            db.db,
          );
          const operations = await server.inject({
            method: 'GET',
            url: `/v1/admin/stores/${store}/operations?limit=1`,
            headers: { authorization: `Bearer ${adminToken}` },
          });
          expect(operations.statusCode).toBe(200);
          expect(operations.json().holidays).toHaveLength(1);
          expect(operations.json().staff).toHaveLength(1);
          const next = await server.inject({
            method: 'GET',
            url: `/v1/admin/stores/${store}/operations?limit=1&holidayCursor=${operations.json().nextHolidayCursor}&staffCursor=${operations.json().nextStaffCursor}`,
            headers: { authorization: `Bearer ${adminToken}` },
          });
          expect(next.statusCode).toBe(200);
          expect(next.json().holidays[0].day).not.toBe(operations.json().holidays[0].day);
          expect(next.json().staff[0].user_id).not.toBe(operations.json().staff[0].user_id);
          const created = await server.inject({
            method: 'POST',
            url: '/v1/admin/legal-entities',
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { name: 'New entity' },
          });
          expect(created.statusCode).toBe(201);
          const referenced = await server.inject({
            method: 'DELETE',
            url: `/v1/admin/legal-entities/${entity}`,
            headers: { authorization: `Bearer ${adminToken}` },
          });
          expect(referenced.statusCode).toBe(409);
          expect(referenced.json()).toMatchObject({ code: 'RESOURCE_CONFLICT', status: 409 });
          const entityId = created.json().id as string;
          expect(
            (
              await server.inject({
                method: 'PATCH',
                url: `/v1/admin/legal-entities/${entityId}`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { name: 'Renamed' },
              })
            ).statusCode,
          ).toBe(200);
          expect(
            (
              await server.inject({
                method: 'DELETE',
                url: `/v1/admin/legal-entities/${entityId}`,
                headers: { authorization: `Bearer ${adminToken}` },
              })
            ).statusCode,
          ).toBe(200);
          expect(
            (
              await server.inject({
                method: 'GET',
                url: '/v1/admin/stores',
                headers: { authorization: `Bearer ${customer}` },
              })
            ).statusCode,
          ).toBe(401);
          expect(
            (
              await server.inject({
                method: 'POST',
                url: '/v1/customer/addresses',
                headers: { authorization: `Bearer ${customer}` },
                payload: { ...draft, lat: 13, lng: 77.6, unexpected: true },
              })
            ).statusCode,
          ).toBe(400);
          const mine = await new PostgresAddresses(db.db).create(user, draft, 10, true);
          expect(
            (
              await server.inject({
                method: 'DELETE',
                url: `/v1/customer/addresses/${mine.id}`,
                headers: { authorization: `Bearer ${another}` },
              })
            ).statusCode,
          ).toBe(404);
          await sql`DELETE FROM store_hours WHERE store_id=${store}`.execute(db.db);
          for (let day = 0; day < 7; day++)
            await sql`INSERT INTO store_hours(store_id,weekday,start_minute,end_minute) VALUES(${store},${day},0,1440)`.execute(
              db.db,
            );
          await sql`DELETE FROM store_holidays WHERE store_id=${store}`.execute(db.db);
          const auth = { authorization: `Bearer ${customer}` };
          const good = await server.inject({
            method: 'GET',
            url: '/v1/customer/serviceability?lat=12.9&lng=77.5',
            headers: auth,
          });
          expect(good.statusCode).toBe(200);
          expect(good.json()).toMatchObject({ serviceable: true, storeId: store, reasons: [] });
          await sql`UPDATE stores SET status='PAUSED',pause_reason='manual' WHERE id=${store}`.execute(
            db.db,
          );
          const paused = await server.inject({
            method: 'GET',
            url: '/v1/customer/serviceability?lat=12.9&lng=77.5',
            headers: auth,
          });
          expect(paused.json()).toMatchObject({ serviceable: false, reasons: ['STORE_PAUSED'] });
          const outside = await server.inject({
            method: 'GET',
            url: '/v1/customer/serviceability?lat=12.8&lng=77.5',
            headers: auth,
          });
          expect(outside.json()).toMatchObject({ serviceable: false, reasons: ['OUTSIDE_ZONE'] });
        } finally {
          try {
            await cleanRateKeys?.();
          } finally {
            await app.close();
          }
        }
      } finally {
        await testQueues?.close();
      }
    },
    process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 30000,
  );
});
