import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { OrderCodeService } from '../../../src/modules/orders/infrastructure/delivery-codes.js';
import type { ConfigService } from '../../../src/config/config.service.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import {
  seedDispatchWorld,
  emitConfirmedOrder,
  fakeConfig,
} from '../../helpers/dispatch-fixture.js';

let services: TestServices;
let db: DatabaseHandle;
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);

it('requires an authorized audited reset before a locked delivery code can be verified', async () => {
  const world = await seedDispatchWorld(db);
  const { orderId } = await emitConfirmedOrder(db, world);
  const adminId = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${adminId}::uuid,'WORKFORCE',${adminId},'reset-admin@example.invalid','admin')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${adminId}::uuid,'SUPER_ADMIN')`.execute(
    db.db,
  );
  await sql`UPDATE orders SET status='OUT_FOR_DELIVERY' WHERE id=${orderId}::uuid`.execute(db.db);
  await sql`INSERT INTO delivery_tasks(id,order_id,store_id,customer_user_id,status,rider_id,arrived_store_at,pickup_at)
    VALUES(${uuidV7()}::uuid,${orderId}::uuid,${world.store}::uuid,${world.customer}::uuid,'PICKED_UP',${world.rider1}::uuid,clock_timestamp(),clock_timestamp())`.execute(
    db.db,
  );
  const secret = 'unit-test-delivery-code-secret-0123';
  const runtime = {
    get: (key: string) =>
      key === 'PICKING_CODE_KEY_VERSION'
        ? 1
        : key === 'PICKING_CODE_KEYS_JSON'
          ? JSON.stringify({ '1': secret })
          : secret,
  } as unknown as ConfigService;
  const codes = new OrderCodeService(db.db, runtime, fakeConfig());
  await codes.issue(orderId);
  const correct = (await codes.present(orderId, world.customer)).code;
  const wrong = correct === '0000' ? '0001' : '0000';
  for (let i = 0; i < 5; i++) expect(await codes.verify(orderId, wrong)).toBe(false);
  await expect(codes.verify(orderId, correct)).rejects.toThrow('DELIVERY_CODE_LOCKED');
  await expect(codes.resetLock(orderId, world.manager, 'customer assistance')).rejects.toThrow(
    'FORBIDDEN',
  );
  await expect(codes.verify(orderId, correct)).rejects.toThrow('DELIVERY_CODE_LOCKED');
  await sql`UPDATE orders SET status='CONFIRMED' WHERE id=${orderId}::uuid`.execute(db.db);
  await expect(codes.resetLock(orderId, adminId, 'customer assistance')).rejects.toThrow(
    'ILLEGAL_STATE_TRANSITION',
  );
  await sql`UPDATE orders SET status='OUT_FOR_DELIVERY' WHERE id=${orderId}::uuid`.execute(db.db);
  await codes.resetLock(orderId, adminId, 'customer assistance');
  const audit = await sql<{
    details: { reason: string };
    status: string;
  }>`SELECT a.details,o.status FROM audit_log a JOIN orders o ON o.id=${orderId}::uuid
    WHERE a.actor_id=${adminId}::uuid AND a.subject_id=${orderId} AND a.action='DELIVERY_CODE_LOCK_RESET'`.execute(
    db.db,
  );
  expect(audit.rows).toEqual([
    { details: { reason: 'customer assistance' }, status: 'OUT_FOR_DELIVERY' },
  ]);
  expect(await codes.verify(orderId, correct)).toBe(true);
});
