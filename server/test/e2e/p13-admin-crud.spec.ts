import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { jest } from '@jest/globals';
import { sql } from 'kysely';
import type { Redis } from 'ioredis';
import { LocalTokenAdapter } from '../../src/adapters/auth/local.js';
import { createApplication } from '../../src/bootstrap.js';
import { uuidV7 } from '../../src/common/ids/ids.js';
import { readEnv } from '../../src/config/env.schema.js';
import { PLATFORM_REDIS } from '../../src/platform/contracts/runtime.js';
import { createAwsTestQueues, trackAwsTestRateKeys } from '../helpers/aws-test-queues.js';
import { closeP5World, createP5World, type P5World } from '../helpers/p5-world.js';

const aws = process.env.AWS_P13_INTEGRATION === 'yes';
if (aws) jest.setTimeout(600000);
let world: P5World;
let app: NestFastifyApplication;
let testQueues: Awaited<ReturnType<typeof createAwsTestQueues>> | undefined;
let clearRateKeys: (() => Promise<void>) | undefined;
let admin: string;
let support: string;
let superAdmin: string;
beforeAll(
  async () => {
    world = await createP5World();
    if (aws) testQueues = await createAwsTestQueues();
    const supportId = uuidV7();
    const superId = uuidV7();
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${supportId}::uuid,'WORKFORCE','p13-support','p13-support@example.invalid','Support'),(${superId}::uuid,'WORKFORCE','p13-super','p13-super@example.invalid','Super')`.execute(
      world.db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES (${supportId}::uuid,'SUPPORT_AGENT'),(${superId}::uuid,'SUPER_ADMIN')`.execute(
      world.db.db,
    );
    const env = readEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      APP_ROLE: 'admin',
      DATABASE_URL: world.services.databaseIamUrl ?? world.services.databaseUrl,
      REDIS_URL: world.services.redisUrl,
      ...(aws
        ? {
            DATABASE_AUTH: 'iam',
            AWS_REGION: process.env.AWS_REGION,
            AWS_ACCOUNT_ID: process.env.AWS_ACCOUNT_ID,
            DB_ACQUIRE_TIMEOUT_MS: '30000',
            CACHE_AUTH: 'elasticache-iam',
            CACHE_URL: process.env.CACHE_URL,
            CACHE_IAM_NAME: process.env.CACHE_IAM_NAME,
            CACHE_IAM_USER: process.env.CACHE_IAM_USER,
            QUEUE_TRANSPORT: 'sqs',
            SQS_QUEUE_PREFIX: testQueues!.prefix,
          }
        : {}),
      RATE_LIMIT_DEFAULT_PER_MIN: '5000',
      RATE_LIMIT_AUTH_PER_MIN: '5000',
    });
    const tokens = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, world.db.db);
    admin = await tokens.issue('WORKFORCE', 'p5-admin', 'admin', 'access');
    support = await tokens.issue('WORKFORCE', 'p13-support', 'admin', 'access');
    superAdmin = await tokens.issue('WORKFORCE', 'p13-super', 'admin', 'access');
    app = await createApplication(env);
    if (aws) clearRateKeys = trackAwsTestRateKeys(app.get<Redis>(PLATFORM_REDIS));
  },
  aws ? 300000 : 120000,
);
afterAll(
  async () => {
    try {
      await clearRateKeys?.();
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          await testQueues?.close();
        } finally {
          if (world) await closeP5World(world);
        }
      }
    }
  },
  aws ? 300000 : 120000,
);

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
async function call(method: Method, url: string, payload?: object, token = admin) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload ? { payload } : {}),
    });
}
async function expectStatus(
  method: Method,
  url: string,
  status: number,
  payload?: object,
  token = admin,
) {
  const response = await call(method, url, payload, token);
  expect({
    method,
    url,
    status: response.statusCode,
    body: response.statusCode === status ? '' : response.body,
  }).toEqual({ method, url, status, body: '' });
  return response;
}
const cityBounds = {
  type: 'Polygon',
  coordinates: [
    [
      [77.0, 12.0],
      [77.9, 12.0],
      [77.9, 13.9],
      [77.0, 13.9],
      [77.0, 12.0],
    ],
  ],
};
const zoneGeometry = {
  type: 'Polygon',
  coordinates: [
    [
      [77.51, 12.91],
      [77.52, 12.91],
      [77.52, 12.92],
      [77.51, 12.92],
      [77.51, 12.91],
    ],
  ],
};

it('manages entities, cities, stores and zones with role checks, strict bodies, version fencing and audits', async () => {
  const invalidWrites: Array<[Method, string, object]> = [
    ['POST', '/v1/admin/legal-entities', { name: 'Denied entity' }],
    ['POST', '/v1/admin/cities', { name: 'Denied city', bounds: cityBounds }],
    [
      'POST',
      '/v1/admin/stores',
      {
        name: 'Denied store',
        legalEntityId: world.entity,
        cityId: world.city,
        lat: 13,
        lng: 77.6,
        hourlyCapacity: 4,
        lastOrderBufferMinutes: 0,
      },
    ],
    [
      'POST',
      '/v1/admin/zones',
      {
        name: 'Denied zone',
        storeId: world.store,
        geometry: zoneGeometry,
        priority: 1,
        active: true,
      },
    ],
  ];
  for (const [method, url, payload] of invalidWrites) {
    await expectStatus(method, url, 403, payload, support);
    await expectStatus(method, url, 400, { ...payload, unexpected: 'canary' });
  }
  const restricted: Array<[Method, string, object?]> = [
    ['GET', '/v1/admin/legal-entities'],
    ['GET', '/v1/admin/cities'],
    ['GET', '/v1/admin/stores'],
    ['GET', '/v1/admin/zones'],
    ['PATCH', `/v1/admin/legal-entities/${world.entity}`, { name: 'Denied' }],
    ['DELETE', `/v1/admin/legal-entities/${world.entity}`],
    ['PATCH', `/v1/admin/cities/${world.city}`, { name: 'Denied', bounds: cityBounds }],
    ['DELETE', `/v1/admin/cities/${world.city}`],
    [
      'PATCH',
      `/v1/admin/stores/${world.store}`,
      {
        name: 'Denied',
        legalEntityId: world.entity,
        cityId: world.city,
        lat: 13,
        lng: 77.6,
        hourlyCapacity: 4,
        lastOrderBufferMinutes: 0,
      },
    ],
    ['DELETE', `/v1/admin/stores/${world.store}`],
    ['GET', `/v1/admin/stores/${world.store}/operations`],
    ['PUT', `/v1/admin/stores/${world.store}/hours`, { entries: [] }],
    [
      'PUT',
      `/v1/admin/stores/${world.store}/holidays`,
      { day: '2027-01-01', closed: true, windows: [] },
    ],
    ['DELETE', `/v1/admin/stores/${world.store}/holidays/2027-01-01`],
    [
      'PATCH',
      `/v1/admin/zones/${uuidV7()}`,
      {
        storeId: world.store,
        name: 'Denied',
        geometry: zoneGeometry,
        priority: 1,
        active: true,
        version: '1',
      },
    ],
    ['DELETE', `/v1/admin/zones/${uuidV7()}?version=1`],
  ];
  for (const [method, url, payload] of restricted)
    await expectStatus(method, url, 403, payload, support);
  const denied = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM audit_log WHERE actor_id=(SELECT id FROM users WHERE cognito_sub='p13-support')`.execute(
    world.db.db,
  );
  expect(denied.rows[0]?.count).toBe('0');
  for (const path of ['legal-entities', 'cities', 'stores', 'zones'])
    await expectStatus('GET', `/v1/admin/${path}`, 200);
  const removable = (
    await expectStatus('POST', '/v1/admin/legal-entities', 201, { name: 'P13 Removable' })
  ).json().id as string;
  await expectStatus('DELETE', `/v1/admin/legal-entities/${removable}`, 200);
  const removableCity = (
    await expectStatus('POST', '/v1/admin/cities', 201, {
      name: 'P13 Removable City',
      bounds: cityBounds,
    })
  ).json().id as string;
  await expectStatus('DELETE', `/v1/admin/cities/${removableCity}`, 200);
  const entity = (
    await expectStatus('POST', '/v1/admin/legal-entities', 201, { name: 'P13 Entity' })
  ).json().id as string;
  await expectStatus('PATCH', `/v1/admin/legal-entities/${entity}`, 200, {
    name: 'P13 Entity Revised',
  });
  const city = (
    await expectStatus('POST', '/v1/admin/cities', 201, { name: 'P13 City', bounds: cityBounds })
  ).json().id as string;
  await expectStatus('PATCH', `/v1/admin/cities/${city}`, 200, {
    name: 'P13 City Revised',
    bounds: cityBounds,
  });
  const removableStoreData = {
    name: 'P13 Removable Store',
    legalEntityId: world.entity,
    cityId: world.city,
    lat: 13,
    lng: 77.6,
    hourlyCapacity: 10,
    lastOrderBufferMinutes: 0,
  };
  const removableStore = (
    await expectStatus('POST', '/v1/admin/stores', 201, removableStoreData)
  ).json().id as string;
  await expectStatus('DELETE', `/v1/admin/stores/${removableStore}`, 200);
  const storeData = {
    name: 'P13 Store',
    legalEntityId: entity,
    cityId: city,
    lat: 13,
    lng: 77.6,
    hourlyCapacity: 20,
    lastOrderBufferMinutes: 5,
  };
  const store = (await expectStatus('POST', '/v1/admin/stores', 201, storeData)).json()
    .id as string;
  await expectStatus('PATCH', `/v1/admin/stores/${store}`, 200, {
    ...storeData,
    name: 'P13 Store Revised',
  });
  await expectStatus('GET', `/v1/admin/stores/${store}/operations`, 200);
  await expectStatus('POST', `/v1/admin/stores/${store}/status`, 201, {
    status: 'PAUSED',
    reason: 'Maintenance',
  });
  await expectStatus('PUT', `/v1/admin/stores/${store}/staff`, 200, {
    userId: world.admin,
    role: 'STORE_MANAGER',
    active: false,
  });
  await expectStatus('PUT', `/v1/admin/stores/${store}/hours`, 200, {
    entries: [{ weekday: 1, startMinute: 60, endMinute: 120 }],
  });
  await expectStatus('PUT', `/v1/admin/stores/${store}/holidays`, 200, {
    day: '2027-01-01',
    closed: true,
    windows: [],
  });
  await expectStatus('DELETE', `/v1/admin/stores/${store}/holidays/2027-01-01`, 200);
  const zoneData = {
    storeId: store,
    name: 'P13 Zone',
    geometry: zoneGeometry,
    priority: 1,
    active: true,
  };
  const zone = (await expectStatus('POST', '/v1/admin/zones', 201, zoneData)).json() as {
    id: string;
    version: string;
  };
  const updated = (
    await expectStatus('PATCH', `/v1/admin/zones/${zone.id}`, 200, {
      ...zoneData,
      name: 'P13 Zone Revised',
      version: zone.version,
    })
  ).json() as { version: string };
  await expectStatus('PATCH', `/v1/admin/zones/${zone.id}`, 409, {
    ...zoneData,
    version: zone.version,
  });
  await expectStatus('DELETE', `/v1/admin/zones/${zone.id}?version=${updated.version}`, 200);
  await expectStatus('DELETE', `/v1/admin/legal-entities/${entity}`, 409);
  const actions = await sql<{
    action: string;
  }>`SELECT action FROM audit_log WHERE actor_id=${world.admin}::uuid`.execute(world.db.db);
  const seen = new Set(actions.rows.map((r) => r.action));
  for (const action of [
    'LEGAL_ENTITY_SAVED',
    'CITY_SAVED',
    'STORE_SAVED',
    'STORE_HOURS_CHANGED',
    'STORE_HOLIDAY_CHANGED',
    'ZONE_CREATED',
    'ZONE_UPDATED',
    'ZONE_DEACTIVATED',
  ])
    expect(seen.has(action)).toBe(true);
});

it('manages catalog names, products, variants, assortment, prices and synonyms with validation and audits', async () => {
  for (const path of ['categories', 'brands', 'products', 'variants', 'synonyms'])
    await expectStatus('GET', `/v1/admin/catalog/${path}`, 200);
  const restricted: Array<[Method, string, object?]> = [
    ...['categories', 'brands', 'products', 'variants', 'synonyms'].map(
      (path): [Method, string] => ['GET', `/v1/admin/catalog/${path}`],
    ),
    ...['categories', 'brands', 'products', 'variants'].flatMap(
      (path): Array<[Method, string, object?]> => [
        ['GET', `/v1/admin/catalog/${path}/${uuidV7()}`],
        ['PUT', `/v1/admin/catalog/${path}/${uuidV7()}`, { name: 'Denied' }],
        ['DELETE', `/v1/admin/catalog/${path}/${uuidV7()}`],
      ],
    ),
    ['POST', '/v1/admin/catalog/assortment', { storeId: world.store, variantId: uuidV7() }],
    [
      'POST',
      '/v1/admin/catalog/prices',
      { storeId: world.store, variantId: uuidV7(), sellingPaise: '10', mrpPaise: '20' },
    ],
    ['PUT', '/v1/admin/catalog/synonyms', { term: 'denied', expansion: 'denied' }],
  ];
  for (const [method, url, payload] of restricted)
    await expectStatus(method, url, 403, payload, support);

  for (const path of ['categories', 'brands']) {
    const url = `/v1/admin/catalog/${path}`;
    await expectStatus('POST', url, 403, { name: `Denied ${path}` }, support);
    await expectStatus('POST', url, 400, { name: `Invalid ${path}`, unexpected: true });
  }
  for (const path of ['categories', 'brands']) {
    const disposable = (
      await expectStatus('POST', `/v1/admin/catalog/${path}`, 201, { name: `Disposable ${path}` })
    ).json().id as string;
    await expectStatus('DELETE', `/v1/admin/catalog/${path}/${disposable}`, 200);
  }
  const category = (
    await expectStatus('POST', '/v1/admin/catalog/categories', 201, { name: 'P13 Category' })
  ).json().id as string;
  const brand = (
    await expectStatus('POST', '/v1/admin/catalog/brands', 201, { name: 'P13 Brand' })
  ).json().id as string;
  for (const [path, id] of [
    ['categories', category],
    ['brands', brand],
  ] as const) {
    await expectStatus('GET', `/v1/admin/catalog/${path}/${id}`, 200);
    await expectStatus('PUT', `/v1/admin/catalog/${path}/${id}`, 200, { name: `Revised ${path}` });
  }
  const productData = {
    categoryId: category,
    brandId: brand,
    name: 'P13 Product',
    description: 'P13 product',
    hsnCode: '0401',
    gstRateBps: 500,
    perishable: false,
    expiryTracking: false,
  };
  await expectStatus('POST', '/v1/admin/catalog/products', 403, productData, support);
  await expectStatus('POST', '/v1/admin/catalog/products', 400, {
    ...productData,
    unexpected: true,
  });
  const product = (
    await expectStatus('POST', '/v1/admin/catalog/products', 201, productData)
  ).json().id as string;
  await expectStatus('GET', `/v1/admin/catalog/products/${product}`, 200);
  await expectStatus('PUT', `/v1/admin/catalog/products/${product}`, 200, {
    ...productData,
    name: 'P13 Product Revised',
  });
  const removableProduct = (
    await expectStatus('POST', '/v1/admin/catalog/products', 201, {
      ...productData,
      name: 'Disposable Product',
    })
  ).json().id as string;
  const removableVariant = (
    await expectStatus('POST', '/v1/admin/catalog/variants', 201, {
      productId: removableProduct,
      name: 'Disposable Variant',
      sku: `P13-DELETE-${uuidV7()}`,
    })
  ).json().id as string;
  await expectStatus('DELETE', `/v1/admin/catalog/variants/${removableVariant}`, 200);
  await expectStatus('DELETE', `/v1/admin/catalog/products/${removableProduct}`, 200);
  const variantData = {
    productId: product,
    name: 'P13 Variant',
    sku: `P13-${uuidV7()}`,
    baseUnit: 'PIECE',
  };
  await expectStatus('POST', '/v1/admin/catalog/variants', 403, variantData, support);
  await expectStatus('POST', '/v1/admin/catalog/variants', 400, {
    ...variantData,
    unexpected: true,
  });
  const variant = (
    await expectStatus('POST', '/v1/admin/catalog/variants', 201, variantData)
  ).json().id as string;
  await expectStatus('GET', `/v1/admin/catalog/variants/${variant}`, 200);
  await expectStatus('PUT', `/v1/admin/catalog/variants/${variant}`, 200, {
    ...variantData,
    name: 'P13 Variant Revised',
  });
  await expectStatus('POST', '/v1/admin/catalog/assortment', 201, {
    storeId: world.store,
    variantId: variant,
  });
  await expectStatus('POST', '/v1/admin/catalog/prices', 201, {
    storeId: world.store,
    variantId: variant,
    sellingPaise: '100',
    mrpPaise: '200',
  });
  await expectStatus('PUT', '/v1/admin/catalog/synonyms', 200, {
    term: 'p13milk',
    expansion: 'p13dairy',
  });
  const synonym = await sql<{
    expansion: string;
  }>`SELECT expansion FROM catalog_synonyms WHERE term='p13milk'`.execute(world.db.db);
  expect(synonym.rows[0]?.expansion).toBe('p13dairy');
  const actions = await sql<{
    action: string;
  }>`SELECT action FROM audit_log WHERE actor_id=${world.admin}::uuid AND subject_type='catalog'`.execute(
    world.db.db,
  );
  const seen = new Set(actions.rows.map((r) => r.action));
  for (const action of ['CATALOG_NAMED_SAVED', 'CATALOG_PRODUCT_SAVED', 'CATALOG_VARIANT_SAVED'])
    expect(seen.has(action)).toBe(true);
});

it('enforces super-admin configuration authority and audits typed settings and flags', async () => {
  await expectStatus('GET', '/v1/admin/config', 403, undefined, support);
  await expectStatus(
    'POST',
    '/v1/admin/feature-flags/wallet_enabled',
    403,
    { enabled: true },
    support,
  );
  await expectStatus(
    'POST',
    '/v1/admin/feature-flags/wallet_enabled',
    400,
    { enabled: true, unexpected: true },
    superAdmin,
  );
  await expectStatus('POST', '/v1/admin/config/locationRetentionDays', 403, { value: 20 }, support);
  await expectStatus('GET', '/v1/admin/config', 200, undefined, superAdmin);
  await expectStatus(
    'POST',
    '/v1/admin/config/locationRetentionDays',
    400,
    { value: 20, unexpected: true },
    superAdmin,
  );
  await expectStatus(
    'POST',
    '/v1/admin/config/locationRetentionDays',
    201,
    { value: 20 },
    superAdmin,
  );
  await expectStatus(
    'POST',
    '/v1/admin/feature-flags/wallet_enabled',
    201,
    { enabled: true },
    superAdmin,
  );
  const result = await sql<{
    value: number;
  }>`SELECT value FROM app_config WHERE key='locationRetentionDays'`.execute(world.db.db);
  expect(result.rows[0]?.value).toBe(20);
  const audits = await sql<{
    action: string;
  }>`SELECT action FROM audit_log WHERE actor_id=(SELECT id FROM users WHERE cognito_sub='p13-super')`.execute(
    world.db.db,
  );
  expect(audits.rows.some((row) => row.action === 'CONFIG_CHANGED')).toBe(true);
  expect(audits.rows.some((row) => row.action === 'FLAG_CHANGED')).toBe(true);
});

it('restricts global administrative read models and validates bounded query inputs', async () => {
  const reads = [
    { url: '/v1/admin/inventory/report', query: `storeId=${world.store}` },
    { url: '/v1/admin/inventory/ledger', query: `storeId=${world.store}` },
    { url: '/v1/admin/inventory/shelf-life', query: '' },
    { url: '/v1/admin/coupons', query: '' },
    { url: '/v1/admin/orders', query: '' },
    { url: '/v1/admin/payments/reconciliation', query: '' },
    { url: '/v1/admin/reports/exports', query: '' },
    { url: '/v1/admin/reports/catalog', query: '' },
    { url: '/v1/admin/wallet/ledger', query: '' },
    { url: '/v1/admin/subscriptions/plans', query: '' },
    { url: '/v1/admin/subscriptions/slots', query: `storeId=${world.store}` },
    { url: '/v1/admin/subscriptions/holidays', query: `storeId=${world.store}` },
    { url: '/v1/admin/subscriptions/runs', query: `storeId=${world.store}` },
  ];
  for (const { url, query } of reads) {
    const suffix = query ? `?${query}` : '';
    await expectStatus('GET', `${url}${suffix}`, 200);
    await expectStatus('GET', `${url}${suffix}`, 403, undefined, support);
    await expectStatus('GET', `${url}?${query ? `${query}&` : ''}limit=101`, 400);
  }
  await expectStatus('GET', '/v1/admin/ops/outbox', 200, undefined, superAdmin);
  await expectStatus('GET', '/v1/admin/ops/outbox', 403, undefined, support);
  for (const url of [
    '/v1/admin/erasure-requests',
    '/v1/admin/approvals',
    '/v1/admin/fraud-signals',
  ]) {
    await expectStatus('GET', url, 200, undefined, superAdmin);
    await expectStatus('GET', url, 403, undefined, support);
    await expectStatus('GET', `${url}?limit=101`, 400, undefined, superAdmin);
  }
});
