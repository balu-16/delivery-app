import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { ConfigService } from '../../../src/modules/app-config/infrastructure/config-service.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { createP5World, closeP5World } from '../../helpers/p5-world.js';

let services: TestServices, handle: DatabaseHandle, config: ConfigService;
const admin = uuidV7();
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  handle = createDatabase(services.databaseUrl);
  config = new ConfigService(handle.db);
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${admin}::uuid,'WORKFORCE',${admin},${admin + '@example.invalid'},'configuration admin')`.execute(
    handle.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${admin}::uuid,'SUPER_ADMIN')`.execute(
    handle.db,
  );
});
afterAll(async () => {
  await handle?.close();
  await services?.stop();
});

it('serializes feature toggles so subscriptions can never outlive an enabled wallet', async () => {
  await expect(config.setFlag(admin, 'subscriptions_enabled', true)).rejects.toThrow(
    'WALLET_REQUIRED_FOR_SUBSCRIPTIONS',
  );
  await config.setFlag(admin, 'wallet_enabled', true);
  const results = await Promise.allSettled([
    config.setFlag(admin, 'subscriptions_enabled', true),
    config.setFlag(admin, 'wallet_enabled', false),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const snapshot = await config.snapshot();
  expect(snapshot.flags.subscriptions_enabled && !snapshot.flags.wallet_enabled).toBe(false);
  await config.setFlag(admin, 'subscriptions_enabled', false);
  await config.setFlag(admin, 'wallet_enabled', false);
});

it('validates related phase policies atomically before writing history or config', async () => {
  await expect(config.update(admin, 'subscriptionGenerationTime', '20:59')).rejects.toThrow();
  await expect(config.update(admin, 'subscriptionGraceDeadlineTime', '04:59')).rejects.toThrow();
  await expect(config.update(admin, 'ratingEditHours', 169)).rejects.toThrow();
  await expect(config.update(admin, 'supportResolutionSlaHours', 1)).rejects.toThrow();
  const stored = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM config_history WHERE actor_id=${admin}::uuid AND key IN ('subscriptionGenerationTime','subscriptionGraceDeadlineTime','ratingEditHours','supportResolutionSlaHours')`.execute(
    handle.db,
  );
  expect(stored.rows[0]?.count).toBe('0');
  await config.update(admin, 'ratingEditHours', 12);
  expect(await config.get('ratingEditHours')).toBe(12);
});

it('rejects runtime timing edits that invalidate an existing active delivery slot', async () => {
  const world = await createP5World();
  try {
    await sql`INSERT INTO subscription_slots(id,store_id,name,start_time,end_time) VALUES(${uuidV7()}::uuid,${world.store}::uuid,'Morning','06:00','09:00')`.execute(
      world.db.db,
    );
    const service = new ConfigService(world.db.db);
    await expect(
      service.update(world.admin, 'subscriptionDispatchLeadMinutes', 40),
    ).rejects.toThrow('INVALID_SLOT_TIMING');
    expect(await service.get('subscriptionDispatchLeadMinutes')).toBe(30);
    await expect(
      service.update(world.admin, 'subscriptionGraceDeadlineTime', '05:30'),
    ).rejects.toThrow('INVALID_SLOT_TIMING');
    await service.update(world.admin, 'subscriptionDispatchLeadMinutes', 25);
    expect(await service.get('subscriptionDispatchLeadMinutes')).toBe(25);
  } finally {
    await closeP5World(world);
  }
});

it('reads pricing policies together with defaults, current versions and isolated mutable values', async () => {
  await sql`INSERT INTO app_config(key,value,updated_by) VALUES
    ('handlingFeePaise','"750"'::jsonb,${admin}::uuid),
    ('feeTaxRules','[{"appliesTo":"ALL","taxBps":500,"split":"IGST"}]'::jsonb,${admin}::uuid)`.execute(
    handle.db,
  );
  const keys = [
    'deliveryFeeSlabs',
    'freeDeliveryThresholdPaise',
    'handlingFeePaise',
    'smallCartThresholdPaise',
    'smallCartFeePaise',
    'surgeFeePaise',
    'feeTaxRules',
    'minOrderPaise',
    'maxOrderPaise',
  ] as const;
  let queryCount = 0;
  const countedConfig = new ConfigService(
    handle.db.withPlugin({
      transformQuery(args) {
        queryCount++;
        return args.node;
      },
      async transformResult(args) {
        return args.result;
      },
    }),
  );
  expect(await countedConfig.getMany([])).toEqual({});
  await expect(countedConfig.getMany(['notAConfigKey' as never])).rejects.toThrow(
    'INVALID_CONFIG_KEY',
  );
  expect(queryCount).toBe(0);
  await countedConfig.getMany(keys);
  expect(queryCount).toBe(1);
  const first = await config.getMany(keys);
  expect(first.handlingFeePaise).toBe('750');
  expect(first.freeDeliveryThresholdPaise).toBe('59900');
  expect(first.feeTaxRules).toEqual([{ appliesTo: 'ALL', taxBps: 500, split: 'IGST' }]);
  first.feeTaxRules[0]!.taxBps = 999;
  first.deliveryFeeSlabs[0]!.feePaise = '999';
  const second = await config.getMany(keys);
  expect(second.feeTaxRules[0]!.taxBps).toBe(500);
  expect(second.deliveryFeeSlabs[0]!.feePaise).toBe('4000');

  await expect(
    handle.db.transaction().execute(async (tx) => {
      await sql`UPDATE app_config SET value='"900"'::jsonb, version=version+1 WHERE key='handlingFeePaise'`.execute(
        tx,
      );
      expect((await config.getMany(keys, tx)).handlingFeePaise).toBe('900');
      throw new Error('rollback requested');
    }),
  ).rejects.toThrow('rollback requested');
  expect((await config.getMany(keys)).handlingFeePaise).toBe('750');
  await sql`UPDATE app_config SET value='"1000"'::jsonb, version=version+1 WHERE key='handlingFeePaise'`.execute(
    handle.db,
  );
  expect((await config.getMany(keys)).handlingFeePaise).toBe('1000');
  await sql`UPDATE app_config SET value='"invalid"'::jsonb, version=version+1 WHERE key='handlingFeePaise'`.execute(
    handle.db,
  );
  await expect(config.getMany(keys)).rejects.toThrow();
  await expect(config.getMany(['notAConfigKey' as never])).rejects.toThrow('INVALID_CONFIG_KEY');
  expect(await config.getMany([])).toEqual({});
});
