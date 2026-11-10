import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { DatabaseIdentityAccess } from '../../../src/modules/identity/infrastructure/identity-access.js';
import { PostgresCatalogQuery } from '../../../src/modules/catalog/infrastructure/catalog-query.js';
import { PostgresCatalogAdmin } from '../../../src/modules/catalog/infrastructure/catalog-admin.js';
import type {
  AppConfig,
  ConfigKey,
  ConfigValues,
} from '../../../src/modules/app-config/contracts/config.js';
import { MakerChecker } from '../../../src/modules/compliance/infrastructure/maker-checker.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
let services: TestServices, db: DatabaseHandle;
const entity = uuidV7(),
  city = uuidV7(),
  store = uuidV7(),
  otherStore = uuidV7(),
  user = uuidV7(),
  otherUser = uuidV7(),
  admin = uuidV7(),
  superMaker = uuidV7(),
  superChecker = uuidV7(),
  address = uuidV7(),
  category = uuidV7(),
  product = uuidV7(),
  variant = uuidV7(),
  media = uuidV7();
const settings = {
  catalogAllowedGstBps: [0, 500, 1200, 1800, 2800],
  catalogLowStockThreshold: 5,
  catalogMaxPerOrder: 10,
  catalogPriceApprovalPercent: 20,
  catalogSuggestCacheSeconds: 30,
};
const config = {
  get: async <K extends ConfigKey>(key: K) =>
    settings[key as keyof typeof settings] as ConfigValues[K],
} satisfies AppConfig;
let query: PostgresCatalogQuery, catalog: PostgresCatalogAdmin;
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
  });
  db = createDatabase(services.databaseUrl);
  for (const [id, pool, sub] of [
    [user, 'CUSTOMER', 'user'],
    [otherUser, 'CUSTOMER', 'other'],
    [admin, 'WORKFORCE', 'admin'],
    [superMaker, 'WORKFORCE', 'super-maker'],
    [superChecker, 'WORKFORCE', 'super-checker'],
  ] as const)
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${id}::uuid,${pool},${sub},${sub + '@example.com'},${sub})`.execute(
      db.db,
    );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${admin}::uuid,'ADMIN'),(${user}::uuid,'CUSTOMER'),(${otherUser}::uuid,'CUSTOMER'),(${superMaker}::uuid,'SUPER_ADMIN'),(${superChecker}::uuid,'SUPER_ADMIN')`.execute(
    db.db,
  );
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'city',ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326))`.execute(
    db.db,
  );
  for (const id of [store, otherStore])
    await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES(${id}::uuid,${entity}::uuid,${city}::uuid,'store',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10)`.execute(
      db.db,
    );
  await sql`INSERT INTO zones(id,store_id,name,polygon,priority,active) VALUES(${uuidV7()}::uuid,${store}::uuid,'zone',ST_Multi(ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326)),1,true)`.execute(
    db.db,
  );
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES(${address}::uuid,${user}::uuid,'road','560001','name','+919876543210',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,true)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Dairy')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,hsn_code,gst_rate_bps,published) VALUES(${product}::uuid,${category}::uuid,'Milk','milk','0401',500,true)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_variants(id,product_id,name,sku) VALUES(${variant}::uuid,${product}::uuid,'One litre','MILK-1')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_media(id,owner_id,purpose,object_key,content_type,size_bytes,state,expires_at) VALUES(${media}::uuid,${admin}::uuid,'PRODUCT_IMAGE','public/example','image/png',8,'REGISTERED',clock_timestamp()+interval '1 hour')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_product_images(product_id,media_id) VALUES(${product}::uuid,${media}::uuid)`.execute(
    db.db,
  );
  await sql`INSERT INTO store_inventory(store_id,variant_id) VALUES(${store}::uuid,${variant}::uuid)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by) VALUES(${uuidV7()}::uuid,${store}::uuid,${variant}::uuid,9000,10000,clock_timestamp()-interval '1 hour',${admin}::uuid)`.execute(
    db.db,
  );
  query = new PostgresCatalogQuery(db.db, config);
  catalog = new PostgresCatalogAdmin(db.db, new DatabaseIdentityAccess(db.db), config, {
    create: (actions) => new MakerChecker(db.db, actions),
  });
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);
describe('catalog using PostGIS and temporal prices', () => {
  it('isolates selected addresses, resolves synonyms, and exposes zero stock only', async () => {
    await sql`INSERT INTO catalog_synonyms(term,expansion) VALUES('doodh','milk')`.execute(db.db);
    const result = await query.list(user, address, { q: 'Dóódh' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      name: 'Milk',
      sellingPaise: '9000',
      mrpPaise: '10000',
      availability: 'OUT_OF_STOCK',
      images: [`/media/${media}`],
    });
    await expect(query.list(otherUser, address, {})).rejects.toThrow('ADDRESS_NOT_SERVICEABLE');
  });
  it('refreshes the PostgreSQL search index through SearchPort without extra revision bumps', async () => {
    await sql`UPDATE catalog_products SET normalized_name='stale' WHERE id=${product}::uuid`.execute(
      db.db,
    );
    const search: import('../../../src/modules/catalog/contracts/search.js').SearchPort = query;
    expect((await search.searchProducts(user, address, 'milk')).items).toHaveLength(0);
    await search.indexProduct(product);
    expect((await search.searchProducts(user, address, 'milk')).items).toHaveLength(1);
    const revision = (
      await sql<{
        revision: string;
      }>`SELECT revision::text FROM catalog_revision WHERE singleton`.execute(db.db)
    ).rows[0]!.revision;
    await search.indexProduct(product);
    expect(
      (
        await sql<{
          revision: string;
        }>`SELECT revision::text FROM catalog_revision WHERE singleton`.execute(db.db)
      ).rows[0]!.revision,
    ).toBe(revision);
    expect((await search.suggest(user, address, 'milk')).items).toHaveLength(1);
    await expect(search.indexProduct(uuidV7())).rejects.toThrow('RESOURCE_NOT_FOUND');
  });
  it('requires variants and images when publishing', async () => {
    const id = await catalog.saveProduct(admin, {
      categoryId: category,
      name: 'Unready',
      description: '',
      hsnCode: '1234',
      gstRateBps: 500,
      perishable: false,
      expiryTracking: false,
    });
    await expect(catalog.publish(admin, id, true)).rejects.toThrow('PRODUCT_NOT_PUBLISHABLE');
  });
  it('commits publication history and outbox together and rolls back when event insertion fails', async () => {
    await sql`CREATE FUNCTION fail_catalog_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='catalog.product_publication_changed' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`.execute(
      db.db,
    );
    await sql`CREATE TRIGGER fail_catalog_event BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_catalog_event()`.execute(
      db.db,
    );
    try {
      await expect(catalog.publish(admin, product, false)).rejects.toThrow();
      const state = await sql<{
        published: boolean;
        version: string;
        history: string;
      }>`SELECT published,publication_version::text AS version,(SELECT count(*)::text FROM catalog_publication_history WHERE product_id=${product}::uuid) AS history FROM catalog_products WHERE id=${product}::uuid`.execute(
        db.db,
      );
      expect(state.rows[0]).toEqual({ published: true, version: '1', history: '0' });
    } finally {
      await sql`DROP TRIGGER fail_catalog_event ON outbox_events`.execute(db.db);
      await sql`DROP FUNCTION fail_catalog_event()`.execute(db.db);
    }
    await catalog.publish(admin, product, false);
    await catalog.publish(admin, product, true);
    const counts = await sql<{
      history: string;
      events: string;
    }>`SELECT (SELECT count(*)::text FROM catalog_publication_history WHERE product_id=${product}::uuid) AS history,(SELECT count(*)::text FROM outbox_events WHERE aggregate_id=${product}::uuid AND event_type='catalog.product_publication_changed') AS events`.execute(
      db.db,
    );
    expect(counts.rows[0]).toEqual({ history: '2', events: '2' });
  });
  it('ranks exact, prefix, full-text and trigram matches with unavailable items last', async () => {
    const fixture = [
      ['Apple', true, 0],
      ['Apple Juice', true, 0],
      ['Red Apple', true, 0],
      ['Fresh Milk', true, 0],
      ['Applf', true, 0],
      ['Apple Cheap', false, 100],
    ] as const;
    for (const [name, inStock, popularity] of fixture) {
      const p = uuidV7(),
        v = uuidV7();
      await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,hsn_code,gst_rate_bps,published,popularity) VALUES(${p}::uuid,${category}::uuid,${name},${name.toLowerCase()},'1234',500,true,${popularity})`.execute(
        db.db,
      );
      await sql`INSERT INTO catalog_variants(id,product_id,name,sku) VALUES(${v}::uuid,${p}::uuid,'each',${v})`.execute(
        db.db,
      );
      await sql`INSERT INTO store_inventory(store_id,variant_id,on_hand) VALUES(${store}::uuid,${v}::uuid,${inStock ? 10 : 0})`.execute(
        db.db,
      );
      if (inStock)
        await sql`INSERT INTO inventory_batches(id,store_id,variant_id,batch_code,state,on_hand) VALUES(${uuidV7()}::uuid,${store}::uuid,${v}::uuid,'fixture','ACTIVE',10)`.execute(
          db.db,
        );
      await sql`INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by) VALUES(${uuidV7()}::uuid,${store}::uuid,${v}::uuid,100,100,clock_timestamp()-interval '1 hour',${admin}::uuid)`.execute(
        db.db,
      );
    }
    const result = await query.list(user, address, { q: 'apple' });
    const mixed = await query.list(user, address, { q: 'fresh doodh' });
    expect((mixed.items[0] as { name: string }).name).toBe('Fresh Milk');
    expect(result.items.map((item) => (item as { name: string }).name)).toEqual([
      'Apple',
      'Apple Juice',
      'Red Apple',
      'Applf',
      'Apple Cheap',
    ]);
  });
  it('requires a distinct checker for a super-admin price maker and keeps price history', async () => {
    await sql`INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by) VALUES(${uuidV7()}::uuid,${otherStore}::uuid,${variant}::uuid,1000,2000,clock_timestamp()-interval '1 hour',${admin}::uuid)`.execute(
      db.db,
    );
    const nominal = new Date(Date.now() + 500);
    const result = await catalog.setPrice(superMaker, {
      storeId: otherStore,
      variantId: variant,
      sellingPaise: '1500',
      mrpPaise: '2000',
      validFrom: nominal.toISOString(),
    });
    expect(result.approvalId).toBeTruthy();
    await expect(catalog.approve(superMaker, result.approvalId!)).rejects.toThrow(
      'APPROVAL_INVALID',
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    await catalog.approve(superChecker, result.approvalId!);
    const rows = await sql<{
      selling_paise: string;
      valid_to: Date | null;
      valid_from: Date;
    }>`SELECT selling_paise::text,valid_to,valid_from FROM catalog_prices WHERE store_id=${otherStore}::uuid AND variant_id=${variant}::uuid ORDER BY valid_from`.execute(
      db.db,
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]!.valid_to).not.toBeNull();
    expect(rows.rows[1]!.selling_paise).toBe('1500');
    expect(rows.rows[1]!.valid_from.getTime()).toBeGreaterThan(nominal.getTime());
    expect(rows.rows[0]!.valid_to!.getTime()).toBe(rows.rows[1]!.valid_from.getTime());
  });
  it('enforces customer/admin HTTP boundaries and sends fresh ETags', async () => {
    const { createApplication } = await import('../../../src/bootstrap.js');
    const { readEnv } = await import('../../../src/config/env.schema.js');
    const { LocalTokenAdapter } = await import('../../../src/adapters/auth/local.js');
    const env = readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'all',
      LOG_LEVEL: 'silent',
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
    });
    const tokens = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, db.db);
    const customer = await tokens.issue('CUSTOMER', 'user', 'customer', 'access'),
      adminToken = await tokens.issue('WORKFORCE', 'admin', 'admin', 'access');
    const app = await createApplication(env);
    try {
      const server = app.getHttpAdapter().getInstance();
      const headers = { authorization: `Bearer ${customer}` };
      const read = await server.inject({
        method: 'GET',
        url: `/v1/customer/catalog/home?addressId=${address}`,
        headers,
      });
      expect(read.statusCode).toBe(200);
      expect(read.headers.etag).toBeTruthy();
      expect(Array.isArray(read.json().items)).toBe(true);
      expect(read.json()).toHaveProperty('nextCursor');
      const badPage = await server.inject({
        method: 'GET',
        url: '/v1/customer/search?q=milk&cursor=invalid!',
        headers,
      });
      expect(badPage.statusCode).toBe(400);
      expect(badPage.json().code).toBe('INVALID_PAGE');
      const tooMany = await server.inject({
        method: 'GET',
        url: '/v1/customer/catalog/home?limit=101',
        headers,
      });
      expect(tooMany.statusCode).toBe(400);
      const pageOne = await server.inject({
        method: 'GET',
        url: `/v1/customer/catalog/home?addressId=${address}&limit=2`,
        headers,
      });
      expect(pageOne.statusCode).toBe(200);
      expect(pageOne.json().items).toHaveLength(2);
      expect(pageOne.json().nextCursor).toBeTruthy();
      const pageTwo = await server.inject({
        method: 'GET',
        url: `/v1/customer/catalog/home?addressId=${address}&limit=2&cursor=${pageOne.json().nextCursor}`,
        headers,
      });
      expect(pageTwo.statusCode).toBe(200);
      expect(pageTwo.json().items[0].variantId).not.toBe(pageOne.json().items[0].variantId);
      expect(pageTwo.headers.etag).not.toBe(pageOne.headers.etag);
      const cached = await server.inject({
        method: 'GET',
        url: `/v1/customer/catalog/home?addressId=${address}`,
        headers: { ...headers, 'if-none-match': read.headers.etag! },
      });
      expect(cached.statusCode).toBe(304);
      expect(
        (
          await server.inject({
            method: 'GET',
            url: `/v1/customer/catalog/home?addressId=${uuidV7()}`,
            headers,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await server.inject({
            method: 'GET',
            url: '/v1/customer/search?q=' + encodeURIComponent('milk\n'),
            headers,
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await server.inject({ method: 'GET', url: '/v1/admin/catalog/products', headers }))
          .statusCode,
      ).toBe(401);
      const paged = await server.inject({
        method: 'GET',
        url: '/v1/admin/catalog/products?limit=2',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(paged.statusCode).toBe(200);
      expect(paged.json().items).toHaveLength(2);
      expect(paged.json().nextCursor).toBeTruthy();
      const next = await server.inject({
        method: 'GET',
        url: `/v1/admin/catalog/products?limit=2&cursor=${paged.json().nextCursor}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(next.statusCode).toBe(200);
      expect(next.json().items[0].id).not.toBe(paged.json().items[0].id);
      expect(
        (
          await server.inject({
            method: 'GET',
            url: '/v1/admin/catalog/products?limit=101',
            headers: { authorization: `Bearer ${adminToken}` },
          })
        ).statusCode,
      ).toBe(400);
      const adminHeaders = { authorization: `Bearer ${adminToken}` };
      const unready = uuidV7();
      await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name) VALUES(${unready}::uuid,${category}::uuid,'Unready HTTP','unready http')`.execute(
        db.db,
      );
      const invalidPublish = await server.inject({
        method: 'POST',
        url: `/v1/admin/catalog/products/${unready}/publish`,
        headers: adminHeaders,
      });
      expect(invalidPublish.statusCode).toBe(409);
      expect(invalidPublish.json().code).toBe('PRODUCT_NOT_PUBLISHABLE');
      const invalidMedia = await server.inject({
        method: 'POST',
        url: '/v1/admin/catalog/media/targets',
        headers: adminHeaders,
        payload: { purpose: 'PRODUCT_IMAGE', contentType: 'image/svg+xml', size: 12 },
      });
      expect(invalidMedia.statusCode).toBe(400);
      expect(invalidMedia.json().code).toBe('INVALID_MEDIA');
      const invalidPrice = await server.inject({
        method: 'POST',
        url: '/v1/admin/catalog/prices',
        headers: adminHeaders,
        payload: {
          storeId: store,
          variantId: variant,
          sellingPaise: '101',
          mrpPaise: '100',
          validFrom: new Date(Date.now() + 60000).toISOString(),
        },
      });
      expect(invalidPrice.statusCode).toBe(400);
      expect(invalidPrice.json().code).toBe('INVALID_PRICE');
      const immediate = await server.inject({
        method: 'POST',
        url: '/v1/admin/catalog/prices',
        headers: adminHeaders,
        payload: {
          storeId: otherStore,
          variantId: variant,
          sellingPaise: '1550',
          mrpPaise: '2000',
          validFrom: null,
        },
      });
      expect(immediate.statusCode).toBe(201);
      const current = await sql<{
        selling: string;
      }>`SELECT selling_paise::text AS selling FROM catalog_prices WHERE store_id=${otherStore}::uuid AND variant_id=${variant}::uuid AND valid_from<=clock_timestamp() AND (valid_to IS NULL OR valid_to>clock_timestamp())`.execute(
        db.db,
      );
      expect(current.rows[0]?.selling).toBe('1550');

      const invalidApproval = await server.inject({
        method: 'POST',
        url: `/v1/admin/catalog/approvals/${uuidV7()}/approve`,
        headers: adminHeaders,
      });
      expect(invalidApproval.statusCode).toBe(409);
      expect(invalidApproval.json().code).toBe('APPROVAL_INVALID');
      const duplicateSku = await server.inject({
        method: 'POST',
        url: '/v1/admin/catalog/variants',
        headers: adminHeaders,
        payload: { productId: product, name: 'duplicate', sku: 'MILK-1' },
      });
      expect(duplicateSku.statusCode).toBe(409);
      expect(duplicateSku.json().code).toBe('RESOURCE_CONFLICT');
    } finally {
      await app.close();
    }
  }, 120000);
  it('caches suggestions in Redis without crossing a scheduled price boundary', async () => {
    const { Redis } = await import('ioredis');
    const redis = new Redis(services.redisUrl);
    let key = '';
    let hits = 0;
    const proxy = {
      get: async (k: string) => {
        const value = await redis.get(k);
        if (value) hits++;
        return value;
      },
      set: async (k: string, v: string, _ex: string, seconds: number) => {
        key = k;
        return redis.set(k, v, 'EX', seconds);
      },
    } as unknown as import('ioredis').Redis;
    try {
      const when = (
        await sql<{ at: Date }>`SELECT clock_timestamp()+interval '5 seconds' AS at`.execute(db.db)
      ).rows[0]!.at;
      await sql`UPDATE catalog_prices SET valid_to=${when} WHERE variant_id=${variant}::uuid AND store_id=${store}::uuid AND valid_to IS NULL`.execute(
        db.db,
      );
      await sql`INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by) VALUES(${uuidV7()}::uuid,${store}::uuid,${variant}::uuid,8000,10000,${when},${admin}::uuid)`.execute(
        db.db,
      );
      const cachedQuery = new PostgresCatalogQuery(db.db, config, undefined, proxy);
      const first = await cachedQuery.list(user, address, { q: 'milk', suggest: true, product });
      await cachedQuery.list(user, address, { q: 'milk', suggest: true, product });
      expect(hits).toBe(1);
      expect(key).toBeTruthy();
      expect(await redis.ttl(key)).toBeLessThanOrEqual(4);
      await new Promise((resolve) => setTimeout(resolve, 5200));
      const after = await cachedQuery.list(user, address, { q: 'milk', suggest: true, product });
      expect((first.items[0] as { sellingPaise: string }).sellingPaise).toBe('9000');
      expect((after.items[0] as { sellingPaise: string }).sellingPaise).toBe('8000');
      expect(after.etag).not.toBe(first.etag);
      await redis.del(key);
    } finally {
      redis.disconnect();
    }
  }, 15000);
  it('paginates more than 100 results without duplicates and rejects cursors across scopes', async () => {
    const pageCategory = uuidV7();
    await sql`INSERT INTO catalog_categories(id,name) VALUES(${pageCategory}::uuid,'Pagination')`.execute(
      db.db,
    );
    await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,hsn_code,gst_rate_bps,published,popularity) SELECT gen_random_uuid(),${pageCategory}::uuid,'Page Fixture '||n,'page fixture '||n,'1234',500,true,n%4 FROM generate_series(1,205) n`.execute(
      db.db,
    );
    await sql`INSERT INTO catalog_variants(id,product_id,name,sku) SELECT id,id,'Each',id::text FROM catalog_products WHERE category_id=${pageCategory}::uuid`.execute(
      db.db,
    );
    await sql`INSERT INTO store_inventory(store_id,variant_id) SELECT ${store}::uuid,id FROM catalog_variants WHERE product_id IN (SELECT id FROM catalog_products WHERE category_id=${pageCategory}::uuid)`.execute(
      db.db,
    );
    await sql`INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by) SELECT gen_random_uuid(),${store}::uuid,id,100,200,clock_timestamp()-interval '1 minute',${admin}::uuid FROM catalog_variants WHERE product_id IN (SELECT id FROM catalog_products WHERE category_id=${pageCategory}::uuid)`.execute(
      db.db,
    );
    const collect = async (q: string | undefined) => {
      let cursor: string | undefined;
      const ids: string[] = [];
      const tags: string[] = [];
      do {
        const result = await query.list(user, address, {
          category: pageCategory,
          limit: 37,
          ...(cursor ? { cursor } : {}),
          ...(q ? { q } : {}),
        });
        ids.push(...result.items.map((x) => (x as { variantId: string }).variantId));
        tags.push(result.etag);
        cursor = result.nextCursor ?? undefined;
      } while (cursor);
      return { ids, tags };
    };
    const home = await collect(undefined),
      search = await collect('page fixture');
    expect(home.ids).toHaveLength(205);
    expect(new Set(home.ids).size).toBe(205);
    expect(search.ids).toHaveLength(205);
    expect(new Set(search.ids)).toEqual(new Set(home.ids));
    expect(new Set(home.tags).size).toBe(6);
    const first = await query.list(user, address, {
      category: pageCategory,
      limit: 10,
      q: 'page fixture',
    });
    await expect(
      query.list(user, address, {
        category: pageCategory,
        limit: 10,
        q: 'different',
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow('INVALID_PAGE');
    await expect(
      query.list(user, address, {
        category: category,
        limit: 10,
        q: 'page fixture',
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow('INVALID_PAGE');
    await expect(
      query.list(user, address, { category: pageCategory, cursor: 'invalid!' }),
    ).rejects.toThrow('INVALID_PAGE');
    const suggest = await query.suggest(user, address, 'page fixture', { limit: 10 });
    expect(suggest.items).toHaveLength(10);
    expect(suggest.nextCursor).toBeTruthy();
    const suggest2 = await query.suggest(user, address, 'page fixture', {
      limit: 10,
      cursor: suggest.nextCursor!,
    });
    expect(suggest2.items).toHaveLength(10);
    expect(suggest2.etag).not.toBe(suggest.etag);
  });
  it('forbids overlapping prices and returns a fresh ETag when current price expires', async () => {
    const duplicate =
      sql`INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by) VALUES(${uuidV7()}::uuid,${store}::uuid,${variant}::uuid,9000,10000,clock_timestamp(),${admin}::uuid)`.execute(
        db.db,
      );
    await expect(duplicate).rejects.toMatchObject({ code: '23P01' });
    const before = await query.list(user, address, { product });
    await sql`UPDATE catalog_prices SET valid_to=clock_timestamp() WHERE variant_id=${variant}::uuid AND store_id=${store}::uuid AND valid_from<clock_timestamp() AND (valid_to IS NULL OR valid_to>clock_timestamp())`.execute(
      db.db,
    );
    const after = await query.list(user, address, { product });
    expect(after.items).toHaveLength(0);
    expect(after.etag).not.toBe(before.etag);
  });
});
