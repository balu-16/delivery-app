import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { CHECKOUT } from '../../../src/modules/checkout/contracts/checkout.js';
import { APP_CONFIG } from '../../../src/modules/app-config/contracts/config.js';
import { SubscriptionGeneration } from '../../../src/modules/subscriptions/infrastructure/generation.js';
import { createP5World, closeP5World } from '../../helpers/p5-world.js';

const loadTest = process.env.RUN_SUBSCRIPTION_LOAD === '1' ? it : it.skip;
loadTest(
  'records explicit outcomes for ten thousand due subscriptions within 15 minutes',
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
      const variant = await world.variant();
      const plan = uuidV7(),
        slot = uuidV7();
      const date = (
        await sql<{
          date: string;
        }>`SELECT (clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date::text AS date`.execute(
          world.db.db,
        )
      ).rows[0]!.date;
      await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
        world.db.db,
      );
      await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'06:00','09:00')`.execute(
        world.db.db,
      );
      await sql`INSERT INTO subscription_holidays(store_id,holiday_date) VALUES(${world.store}::uuid,${date}::date)`.execute(
        world.db.db,
      );
      await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,end_date,next_delivery_date) SELECT gen_random_uuid(),${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date,${date}::date FROM generate_series(1,10000)`.execute(
        world.db.db,
      );
      await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) SELECT gen_random_uuid(),s.id,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid FROM subscriptions s WHERE s.plan_id=${plan}::uuid`.execute(
        world.db.db,
      );
      const worker = new SubscriptionGeneration(
        world.db.db,
        app.get(CHECKOUT),
        app.get(APP_CONFIG),
      );
      const started = Date.now();
      while (await worker.scan(1000)) {
        if (Date.now() - started > 900000) throw new Error('GENERATION_EXCEEDED_15_MINUTES');
      }
      const result = await sql<{
        n: string;
      }>`SELECT count(*)::text AS n FROM subscription_occurrences o JOIN subscriptions s ON s.id=o.subscription_id WHERE s.plan_id=${plan}::uuid AND o.state='SKIPPED' AND o.reason='SKIPPED_HOLIDAY'`.execute(
        world.db.db,
      );
      expect(result.rows[0]?.n).toBe('10000');
    } finally {
      await app.close();
      await closeP5World(world);
    }
  },
  950000,
);

loadTest(
  'funds and reserves ten thousand scheduled orders without duplicates on replay',
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
      const variant = await world.variant({ price: 1000n, stock: 10000n });
      const plan = uuidV7(),
        slot = uuidV7();
      const date = (
        await sql<{
          date: string;
        }>`SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date+1)::text AS date`.execute(
          world.db.db,
        )
      ).rows[0]!.date;
      await sql`UPDATE stores SET hourly_capacity=20000 WHERE id=${world.store}::uuid`.execute(
        world.db.db,
      );
      await sql`INSERT INTO feature_flags(key,enabled) VALUES('wallet_enabled',true),('subscriptions_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
        world.db.db,
      );
      await sql`INSERT INTO app_config(key,value) VALUES('subscriptionGenerationTime','"00:00"'::jsonb) ON CONFLICT(key) DO UPDATE SET value='"00:00"'::jsonb`.execute(
        world.db.db,
      );
      await sql`INSERT INTO wallet_accounts(id,user_id,cash_balance_paise) VALUES(${uuidV7()}::uuid,${world.customer}::uuid,1000000000)`.execute(
        world.db.db,
      );
      await sql`INSERT INTO subscription_plans(id,variant_id) VALUES(${plan}::uuid,${variant.id}::uuid)`.execute(
        world.db.db,
      );
      await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${slot}::uuid,${world.store}::uuid,${slot},'06:00','09:00')`.execute(
        world.db.db,
      );
      await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,end_date,next_delivery_date) SELECT gen_random_uuid(),${world.customer}::uuid,${plan}::uuid,${world.store}::uuid,${world.address}::uuid,${date}::date,${date}::date,${date}::date FROM generate_series(1,10000)`.execute(
        world.db.db,
      );
      await sql`INSERT INTO subscription_schedule_versions(id,subscription_id,effective_from,quantity,frequency_rule,slot_id) SELECT gen_random_uuid(),s.id,${date}::date,1,'{"type":"DAILY"}'::jsonb,${slot}::uuid FROM subscriptions s WHERE s.plan_id=${plan}::uuid`.execute(
        world.db.db,
      );
      const worker = new SubscriptionGeneration(
        world.db.db,
        app.get(CHECKOUT),
        app.get(APP_CONFIG),
      );
      const started = Date.now();
      while (await worker.scan(1000)) {
        if (Date.now() - started > 900000) throw new Error('GENERATION_EXCEEDED_15_MINUTES');
      }
      await worker.scan(1000);
      const result = await sql<{
        occurrences: string;
        orders: string;
        debits: string;
        reserved: string;
        capacity: string;
      }>`SELECT (SELECT count(*)::text FROM subscription_occurrences o JOIN subscriptions s ON s.id=o.subscription_id WHERE s.plan_id=${plan}::uuid AND o.state='ORDERED') AS occurrences,(SELECT count(*)::text FROM orders WHERE source='SUBSCRIPTION') AS orders,(SELECT count(*)::text FROM wallet_ledger WHERE reason='ORDER_PAYMENT') AS debits,(SELECT reserved::text FROM store_inventory WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid) AS reserved,(SELECT count(*)::text FROM store_capacity_claims WHERE store_id=${world.store}::uuid) AS capacity`.execute(
        world.db.db,
      );
      expect(result.rows[0]).toEqual({
        occurrences: '10000',
        orders: '10000',
        debits: '10000',
        reserved: '10000',
        capacity: '10000',
      });
    } finally {
      await app.close();
      await closeP5World(world);
    }
  },
  950000,
);
