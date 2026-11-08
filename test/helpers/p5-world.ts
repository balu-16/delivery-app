import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../src/platform/database/database.js';
import type {
  AppConfig,
  ConfigKey,
  ConfigValues,
} from '../../src/modules/app-config/contracts/config.js';
import { startTestServices, type TestServices } from './services.js';

export interface P5World {
  services: TestServices;
  db: DatabaseHandle;
  entity: string;
  city: string;
  store: string;
  otherStore: string;
  customer: string;
  otherCustomer: string;
  thirdCustomer: string;
  admin: string;
  address: string;
  otherAddress: string;
  category: string;
  product: string;
  config: AppConfig;
  /** Creates a priced, stocked variant at both stores; per-store prices can differ. */
  variant(over?: {
    price?: bigint;
    otherPrice?: bigint;
    stock?: bigint;
    gstRateBps?: number;
  }): Promise<{
    id: string;
    price: bigint;
    otherPrice: bigint;
  }>;
  /** Sets one active batch's availability for a variant at a store. */
  stock(storeId: string, variantId: string, quantity: bigint): Promise<void>;
  /** Replaces the current selling price for a variant at a store (new validity slice). */
  reprice(
    storeId: string,
    variantId: string,
    sellingPaise: bigint,
    createdBy?: string,
  ): Promise<void>;
}
const settings: Partial<Record<ConfigKey, unknown>> = {
  catalogMaxPerOrder: 5,
  maxCartLines: 3,
  cartRetentionDays: 30,
  minOrderPaise: '0',
  maxOrderPaise: '100000000',
  deliveryFeeSlabs: [
    { maxOrderValuePaise: '20000', feePaise: '4000' },
    { maxOrderValuePaise: '50000', feePaise: '2000' },
    { maxOrderValuePaise: null, feePaise: '0' },
  ],
  freeDeliveryThresholdPaise: '50000',
  handlingFeePaise: '500',
  smallCartThresholdPaise: '10000',
  smallCartFeePaise: '1500',
  surgeFeePaise: '2500',
  paymentWindowSeconds: 900,
  couponValidationAttemptsPerWindow: 10,
  feeTaxRules: [{ appliesTo: 'ALL', taxBps: 1800, split: 'CGST_SGST' }],
  catalogAllowedGstBps: [0, 500, 1200, 1800, 2800],
};
/** Full P5 fixture world: two stores, three customers, an admin and priced stock. */
export async function createP5World(): Promise<P5World> {
  const services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  const db = createDatabase(services.databaseUrl, 30);
  const entity = uuidV7(),
    city = uuidV7(),
    store = uuidV7(),
    otherStore = uuidV7(),
    customer = uuidV7(),
    otherCustomer = uuidV7(),
    thirdCustomer = uuidV7(),
    admin = uuidV7(),
    address = uuidV7(),
    otherAddress = uuidV7(),
    category = uuidV7(),
    product = uuidV7();
  for (const [id, pool, sub] of [
    [customer, 'CUSTOMER', 'p5-customer'],
    [otherCustomer, 'CUSTOMER', 'p5-other'],
    [thirdCustomer, 'CUSTOMER', 'p5-third'],
    [admin, 'WORKFORCE', 'p5-admin'],
  ] as const)
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${id}::uuid,${pool},${sub},${sub + '@example.invalid'},${sub})`.execute(
      db.db,
    );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${customer}::uuid,'CUSTOMER'),(${otherCustomer}::uuid,'CUSTOMER'),(${thirdCustomer}::uuid,'CUSTOMER'),(${admin}::uuid,'ADMIN')`.execute(
    db.db,
  );
  await sql`INSERT INTO legal_entities(id,name) VALUES(${entity}::uuid,'entity')`.execute(db.db);
  await sql`INSERT INTO cities(id,name,bounds) VALUES(${city}::uuid,'city',ST_GeomFromText('POLYGON((76 11,79 11,79 14,76 14,76 11))',4326))`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES(${store}::uuid,${entity}::uuid,${city}::uuid,'east',ST_SetSRID(ST_MakePoint(77.6,13),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES(${otherStore}::uuid,${entity}::uuid,${city}::uuid,'west',ST_SetSRID(ST_MakePoint(76.5,11.5),4326)::geography,'ONLINE',10)`.execute(
    db.db,
  );
  await sql`INSERT INTO zones(id,store_id,name,polygon,priority,active) VALUES(${uuidV7()}::uuid,${store}::uuid,'east-zone',ST_Multi(ST_GeomFromText('POLYGON((77 12,78 12,78 14,77 14,77 12))',4326)),1,true)`.execute(
    db.db,
  );
  await sql`INSERT INTO zones(id,store_id,name,polygon,priority,active) VALUES(${uuidV7()}::uuid,${otherStore}::uuid,'west-zone',ST_Multi(ST_GeomFromText('POLYGON((76 11,77 11,77 12,76 12,76 11))',4326)),1,true)`.execute(
    db.db,
  );
  await sql`INSERT INTO store_hours(store_id,weekday,start_minute,end_minute) SELECT ${store}::uuid,day,0,1440 FROM generate_series(0,6) AS day`.execute(
    db.db,
  );
  await sql`INSERT INTO store_hours(store_id,weekday,start_minute,end_minute) SELECT ${otherStore}::uuid,day,0,1440 FROM generate_series(0,6) AS day`.execute(
    db.db,
  );
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES(${address}::uuid,${customer}::uuid,'road','560001','name','+919876543210',ST_SetSRID(ST_MakePoint(77.5,13),4326)::geography,true)`.execute(
    db.db,
  );
  await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES(${otherAddress}::uuid,${customer}::uuid,'road','560002','name','+919876543210',ST_SetSRID(ST_MakePoint(76.5,11.5),4326)::geography,false)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_categories(id,name) VALUES(${category}::uuid,'Dairy')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,hsn_code,gst_rate_bps,published) VALUES(${product}::uuid,${category}::uuid,'Milk','milk','0401',500,true)`.execute(
    db.db,
  );
  const world: P5World = {
    services,
    db,
    entity,
    city,
    store,
    otherStore,
    customer,
    otherCustomer,
    thirdCustomer,
    admin,
    address,
    otherAddress,
    category,
    product,
    config: {
      get: async <K extends ConfigKey>(key: K) => settings[key] as ConfigValues[K],
    },
    async variant(over) {
      const id = uuidV7();
      const price = over?.price ?? 10000n;
      const otherPrice = over?.otherPrice ?? price;
      const gst = over?.gstRateBps ?? 500;
      await sql`INSERT INTO catalog_variants(id,product_id,name,sku) VALUES(${id}::uuid,${product}::uuid,'Unit',${id})`.execute(
        db.db,
      );
      for (const [storeId, selling] of [
        [store, price],
        [otherStore, otherPrice],
      ] as const)
        await sql`INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by)
          VALUES(${uuidV7()}::uuid,${storeId}::uuid,${id}::uuid,${selling}::bigint,${selling * 2n}::bigint,statement_timestamp(),${admin}::uuid)`.execute(
          db.db,
        );
      for (const storeId of [store, otherStore])
        await sql`INSERT INTO store_inventory(store_id,variant_id,on_hand) VALUES(${storeId}::uuid,${id}::uuid,${over?.stock ?? 10n})`.execute(
          db.db,
        );
      for (const storeId of [store, otherStore])
        await sql`INSERT INTO inventory_batches(id,store_id,variant_id,batch_code,state,on_hand)
          VALUES(${uuidV7()}::uuid,${storeId}::uuid,${id}::uuid,'B1','ACTIVE',${over?.stock ?? 10n})`.execute(
          db.db,
        );
      await sql`UPDATE catalog_products SET gst_rate_bps=${gst} WHERE id=${product}::uuid`.execute(
        db.db,
      );
      return { id, price, otherPrice };
    },
    async stock(storeId, variantId, quantity) {
      await sql`UPDATE store_inventory SET on_hand=${quantity},reserved=0 WHERE store_id=${storeId}::uuid AND variant_id=${variantId}::uuid`.execute(
        db.db,
      );
      await sql`UPDATE inventory_batches SET on_hand=${quantity},reserved=0 WHERE store_id=${storeId}::uuid AND variant_id=${variantId}::uuid AND state='ACTIVE'`.execute(
        db.db,
      );
    },
    async reprice(storeId, variantId, sellingPaise, createdBy) {
      await sql`UPDATE catalog_prices SET valid_to=clock_timestamp() WHERE store_id=${storeId}::uuid AND variant_id=${variantId}::uuid AND valid_to IS NULL`.execute(
        db.db,
      );
      await sql`INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by)
        VALUES(${uuidV7()}::uuid,${storeId}::uuid,${variantId}::uuid,${sellingPaise}::bigint,${sellingPaise * 2n}::bigint,statement_timestamp(),${createdBy ?? admin}::uuid)`.execute(
        db.db,
      );
    },
  };
  return world;
}
export async function closeP5World(world: P5World): Promise<void> {
  await world.db?.close();
  await world.services?.stop();
}
