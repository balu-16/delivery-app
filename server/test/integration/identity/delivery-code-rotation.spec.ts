import { jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import type { ConfigService } from '../../../src/config/config.service.js';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import { OrderCodeService } from '../../../src/modules/orders/infrastructure/delivery-codes.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';

let world: P5World;
const timeout = process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 120000;
if (process.env.AWS_P13_INTEGRATION === 'yes') jest.setTimeout(timeout);
beforeAll(async () => {
  world = await createP5World();
}, timeout);
afterAll(async () => {
  if (world) await closeP5World(world);
}, timeout);

it('retains delivery code retrieval across restart and key rotation without storing plaintext', async () => {
  const orderId = uuidV7();
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,subtotal_paise,total_paise,amount_due_paise,placed_at)
    VALUES(${orderId}::uuid,${`ORD-${orderId.replaceAll('-', '').toUpperCase()}`},${world.customer}::uuid,${world.store}::uuid,'{}','PENDING_PAYMENT','UNPAID',100,100,100,clock_timestamp())`.execute(
    world.db.db,
  );
  const keys = { '1': 'test-key-one-long-enough', '2': 'test-key-two-long-enough' };
  const runtime = (version: number) =>
    ({
      get: (key: string) => {
        if (key === 'PICKING_CODE_KEY_VERSION') return version;
        if (key === 'PICKING_CODE_KEYS_JSON') return JSON.stringify(keys);
        throw new Error('unexpected config key');
      },
    }) as unknown as ConfigService;
  const config = { get: async () => 3 } as unknown as AppConfig;
  const first = new OrderCodeService(world.db.db, runtime(1), config);
  await first.issue(orderId);
  const issued = await first.present(orderId, world.customer);
  expect(issued).toMatchObject({ keyVersion: 1 });
  await expect(first.present(orderId, world.otherCustomer)).rejects.toThrow('ORDER_NOT_FOUND');
  const stored = await sql<{
    verifier: Buffer;
    key_version: number;
  }>`SELECT verifier,key_version FROM order_code_verifiers WHERE order_id=${orderId}::uuid`.execute(
    world.db.db,
  );
  expect(stored.rows[0]?.key_version).toBe(1);
  expect(stored.rows[0]?.verifier.includes(Buffer.from(issued.code))).toBe(false);
  const restarted = new OrderCodeService(world.db.db, runtime(2), config);
  expect(await restarted.present(orderId, world.customer)).toEqual(issued);
  const child = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', resolve('test/helpers/delivery-code-restart.ts')],
    {
      timeout: 30000,
      env: {
        ...process.env,
        TEST_CODE_DATABASE_URL: world.services.databaseIamUrl ?? world.services.databaseUrl,
        TEST_CODE_DATABASE_REGION: world.services.databaseIamUrl ? process.env.AWS_REGION : '',
        TEST_CODE_ORDER: orderId,
        TEST_CODE_USER: world.customer,
      },
    },
  );
  expect(JSON.parse(child.stdout)).toEqual(issued);
  const wrong = issued.code === '0000' ? '0001' : '0000';
  for (let i = 0; i < 3; i++) expect(await restarted.verify(orderId, wrong)).toBe(false);
  const restartedAgain = new OrderCodeService(world.db.db, runtime(2), config);
  await expect(restartedAgain.verify(orderId, issued.code)).rejects.toThrow('DELIVERY_CODE_LOCKED');
});
