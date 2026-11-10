import { sql } from 'kysely';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import {
  SUBSCRIPTION_OBLIGATIONS,
  type SubscriptionObligations,
} from '../../../src/modules/subscriptions/contracts/subscriptions.js';
import { PostgresPayouts } from '../../../src/modules/payouts/infrastructure/postgres-payouts.js';
import { MakerChecker } from '../../../src/modules/compliance/infrastructure/maker-checker.js';
import { ErasureProcessor } from '../../../src/modules/compliance/infrastructure/erasure-processor.js';
import { createP5World, closeP5World } from '../../helpers/p5-world.js';
test('live P10 subscriptions and P11 payout records gate erasure until resolved', async () => {
  const w = await createP5World();
  const app = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'customer',
      LOG_LEVEL: 'silent',
      DATABASE_URL: w.services.databaseUrl,
      REDIS_URL: w.services.redisUrl,
    }),
    [{ name: 'test', async check() {} }],
  );
  try {
    const variant = await w.variant(),
      plan = uuidV7(),
      sub = uuidV7(),
      req = uuidV7(),
      batch = uuidV7(),
      payout = uuidV7();
    await sql`INSERT INTO subscription_plans(id,variant_id) VALUES (${plan}::uuid,${variant.id}::uuid)`.execute(
      w.db.db,
    );
    await sql`INSERT INTO subscriptions(id,user_id,plan_id,store_id,address_id,start_date,status) VALUES (${sub}::uuid,${w.customer}::uuid,${plan}::uuid,${w.store}::uuid,${w.address}::uuid,current_date,'ACTIVE')`.execute(
      w.db.db,
    );
    await sql`INSERT INTO erasure_requests(id,user_id,status) VALUES (${req}::uuid,${w.customer}::uuid,'REQUESTED')`.execute(
      w.db.db,
    );
    const obligations = app.get<SubscriptionObligations>(SUBSCRIPTION_OBLIGATIONS);
    const payouts = new PostgresPayouts(w.db.db, {
      create: (actions) => new MakerChecker(w.db.db, actions),
    });
    const processor = new ErasureProcessor(
      w.db.db,
      obligations,
      payouts,
      { anonymizeUser: async () => undefined },
      { fenceForErasure: async () => undefined, eraseFenced: async () => true },
    );
    const check = async () =>
      (
        await sql<{
          status: string;
          blockers: string[];
        }>`SELECT status,blockers FROM erasure_requests WHERE id=${req}::uuid`.execute(w.db.db)
      ).rows[0]!;
    const retry = async () => {
      await sql`UPDATE erasure_requests SET retry_after=clock_timestamp() WHERE id=${req}::uuid`.execute(
        w.db.db,
      );
      await processor.runOne();
    };
    await retry();
    expect((await check()).blockers).toContain('ACTIVE_SUBSCRIPTION');
    await sql`UPDATE subscriptions SET status='PAUSED' WHERE id=${sub}::uuid`.execute(w.db.db);
    await retry();
    expect((await check()).blockers).toContain('ACTIVE_SUBSCRIPTION');
    await sql`UPDATE subscriptions SET status='CANCELLED' WHERE id=${sub}::uuid`.execute(w.db.db);
    await sql`INSERT INTO payout_batches(id,cutoff) VALUES (${batch}::uuid,clock_timestamp())`.execute(
      w.db.db,
    );
    await sql`INSERT INTO rider_payouts(id,batch_id,rider_id,state,gross_paise,cash_offset_paise,net_paise) VALUES (${payout}::uuid,${batch}::uuid,${w.customer}::uuid,'DRAFT',100,0,100)`.execute(
      w.db.db,
    );
    await retry();
    expect((await check()).blockers).toContain('PAYOUT_DUE');
    await sql`UPDATE rider_payouts SET state='CANCELLED' WHERE id=${payout}::uuid`.execute(w.db.db);
    await retry();
    expect((await check()).status).toBe('CLEANUP');
  } finally {
    await app.close();
    await closeP5World(w);
  }
}, 120000);
