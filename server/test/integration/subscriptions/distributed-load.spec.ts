import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { SubscriptionGeneration } from '../../../src/modules/subscriptions/infrastructure/generation.js';
import { createP5World, closeP5World } from '../../helpers/p5-world.js';

const loadTest = process.env.RUN_SUBSCRIPTION_DISTRIBUTED_LOAD === '1' ? it : it.skip;
loadTest(
  'generates 10000 wallet-funded orders across ten stores within 15 minutes with no replay duplicates',
  async () => {
    const world = await createP5World();
    const app = await createApplication(
      readEnv({
        NODE_ENV: 'test',
        APP_ROLE: 'customer',
        LOG_LEVEL: 'silent',
        DATABASE_URL: world.services.databaseUrl,
        REDIS_URL: world.services.redisUrl,
      }),
      [{ name: 'test', async check() {} }],
    );
    try {
      const variant = await world.variant({ price: 1000n, stock: 1n }),
        plan = uuidV7();
      const date = (
        await sql<{
          date: string;
        }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS date`.execute(
          world.db.db,
        )
      ).rows[0]!.date;
      await sql`INSERT INTO feature_flags(key,enabled) VALUES('wallet_enabled',true),('subscriptions_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
        world.db.db,
      );
      await sql`INSERT INTO app_config(key,value) VALUES('subscriptionGenerationTime','"00:00"'::jsonb) ON CONFLICT(key) DO UPDATE SET value='"00:00"'::jsonb`.execute(
        world.db.db,
      );
      await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
        world.db.db,
      );
      const stores: string[] = [];
      for (let i = 0; i < 10; i++) {
        const store = uuidV7(),
          user = uuidV7(),
          address = uuidV7(),
          slot = uuidV7(),
          longitude = 77.05 + i * 0.08;
        stores.push(store);
        await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${user}::uuid,'CUSTOMER',${user},${user + '@example.invalid'},'load customer')`.execute(
          world.db.db,
        );
        await sql`INSERT INTO user_roles(user_id,role) VALUES(${user}::uuid,'CUSTOMER')`.execute(
          world.db.db,
        );
        await sql`INSERT INTO wallet_accounts(id,user_id,cash_balance_paise) VALUES(${uuidV7()}::uuid,${user}::uuid,100000000)`.execute(
          world.db.db,
        );
        await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity) VALUES(${store}::uuid,${world.entity}::uuid,${world.city}::uuid,${store},ST_SetSRID(ST_MakePoint(${longitude},13),4326)::geography,'ONLINE',2000)`.execute(
          world.db.db,
        );
        await sql`INSERT INTO zones(id,store_id,name,polygon,priority,active) VALUES(${uuidV7()}::uuid,${store}::uuid,${store},ST_Multi(ST_MakeEnvelope(${longitude - 0.025},12.95,${longitude + 0.025},13.05,4326)),100,true)`.execute(
          world.db.db,
        );
        await sql`INSERT INTO store_hours(store_id,weekday,start_minute,end_minute) SELECT ${store}::uuid,day,0,1440 FROM generate_series(0,6) day`.execute(
          world.db.db,
        );
        await sql`INSERT INTO addresses(id,user_id,line1,pincode,contact_name,contact_phone,point,is_default) VALUES(${address}::uuid,${user}::uuid,'load road','560001','name','+919876543210',ST_SetSRID(ST_MakePoint(${longitude},13),4326)::geography,true)`.execute(
          world.db.db,
        );
        await sql`INSERT INTO catalog_prices(id,store_id,variant_id,selling_paise,mrp_paise,valid_from,created_by) VALUES(${uuidV7()}::uuid,${store}::uuid,${variant.id}::uuid,1000,2000,clock_timestamp()-interval '1 minute',${world.admin}::uuid)`.execute(
          world.db.db,
        );
        await sql`INSERT INTO store_inventory(store_id,variant_id,on_hand) VALUES(${store}::uuid,${variant.id}::uuid,1000)`.execute(
          world.db.db,
        );
        await sql`INSERT INTO inventory_batches(id,store_id,variant_id,batch_code,state,on_hand) VALUES(${uuidV7()}::uuid,${store}::uuid,${variant.id}::uuid,'load','ACTIVE',1000)`.execute(
          world.db.db,
        );
        await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${store}::uuid,${slot},'06:00','09:00')`.execute(
          world.db.db,
        );
        await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,end_date,next_delivery_date) SELECT gen_random_uuid(),${user}::uuid,${plan}::uuid,${store}::uuid,${address}::uuid,${date}::date,${date}::date,${date}::date FROM generate_series(1,1000)`.execute(
          world.db.db,
        );
        await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id,address_id) SELECT gen_random_uuid(),s.id,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid,${address}::uuid FROM subscriptions s WHERE s.store_id=${store}::uuid AND s.plan_id=${plan}::uuid`.execute(
          world.db.db,
        );
      }
      const worker = app.get(SubscriptionGeneration),
        started = Date.now();
      while (await worker.scanStores(1000, 100)) {
        if (Date.now() - started > 900000) throw new Error('GENERATION_EXCEEDED_15_MINUTES');
      }
      await worker.scanStores(1000, 100);
      const result = await sql<{
        occurrences: string;
        orders: string;
        debits: string;
        reserved: string;
        capacity: string;
        stores: string;
      }>`SELECT (SELECT count(*)::text FROM subscription_occurrences o JOIN subscriptions s ON s.id=o.subscription_id WHERE s.plan_id=${plan}::uuid AND o.state='ORDERED') AS occurrences,(SELECT count(*)::text FROM orders WHERE store_id=ANY(${stores}::uuid[]) AND source='SUBSCRIPTION') AS orders,(SELECT count(*)::text FROM wallet_ledger l JOIN wallet_accounts a ON a.id=l.account_id WHERE a.user_id IN (SELECT user_id FROM subscriptions WHERE plan_id=${plan}::uuid) AND l.reason='ORDER_PAYMENT') AS debits,(SELECT sum(reserved)::text FROM store_inventory WHERE store_id=ANY(${stores}::uuid[]) AND variant_id=${variant.id}::uuid) AS reserved,(SELECT count(*)::text FROM store_capacity_claims WHERE store_id=ANY(${stores}::uuid[])) AS capacity,(SELECT count(DISTINCT store_id)::text FROM orders WHERE store_id=ANY(${stores}::uuid[])) AS stores`.execute(
        world.db.db,
      );
      expect(result.rows[0]).toEqual({
        occurrences: '10000',
        orders: '10000',
        debits: '10000',
        reserved: '10000',
        capacity: '10000',
        stores: '10',
      });
    } finally {
      await app.close();
      await closeP5World(world);
    }
  },
  950000,
);
