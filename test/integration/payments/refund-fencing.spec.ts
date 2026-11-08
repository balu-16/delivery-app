import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { PostgresRefunds } from '../../../src/modules/payments/infrastructure/postgres-refunds.js';
import { PaymentRefundService } from '../../../src/modules/payments/infrastructure/refund-service.js';
import type { DurableOperations } from '../../../src/modules/payments/infrastructure/durable-ops.js';
import type { PaymentGatewayPort } from '../../../src/modules/payments/contracts/gateway.js';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { seedDispatchWorld, emitConfirmedOrder } from '../../helpers/dispatch-fixture.js';

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
  db = createDatabase(services.databaseUrl, 2);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);

it('serializes overlapping dispatches before a gateway success can race wallet fallback', async () => {
  const world = await seedDispatchWorld(db);
  const { orderId } = await emitConfirmedOrder(db, world);
  await sql`INSERT INTO payment_refunds(id,order_id,refund_reference,source_type,source_id,amount_paise,destination,status)
    VALUES(gen_random_uuid(),${orderId}::uuid,'fencing-test','GATEWAY_CAPTURE','gateway-payment',100,'GATEWAY','PENDING')`.execute(
    db.db,
  );
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const gateway = {
    refund: async () => {
      calls++;
      entered();
      await gate;
      return { status: 'PROCESSED', gatewayRefundId: 'provider-refund' };
    },
  } as unknown as PaymentGatewayPort;
  const service = new PaymentRefundService(
    db.db,
    new PostgresRefunds(db.db),
    {} as DurableOperations,
    gateway,
    {} as AppConfig,
  );
  const first = service.dispatchRefund('fencing-test');
  await started;
  await expect(service.applyOutcome('fencing-test', { status: 'FAILED' })).rejects.toThrow(
    'REFUND_OUTCOME_BUSY',
  );
  const contenders = Promise.all(
    Array.from({ length: 9 }, () => service.dispatchRefund('fencing-test')),
  );
  let results;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    results = await Promise.race([
      contenders,
      new Promise<never>(
        (_, reject) => (timeout = setTimeout(() => reject(new Error('contenders blocked')), 3000)),
      ),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    release();
  }
  const completed = await first;
  expect(calls).toBe(1);
  expect(results.every((row) => row.status === 'UNKNOWN' && row.destination === 'GATEWAY')).toBe(
    true,
  );
  expect(completed).toMatchObject({ status: 'PROCESSED', destination: 'GATEWAY' });

  await sql`INSERT INTO payment_refunds(id,order_id,refund_reference,source_type,source_id,amount_paise,destination,status)
    VALUES(gen_random_uuid(),${orderId}::uuid,'pending-test','GATEWAY_CAPTURE','gateway-payment',100,'GATEWAY','PENDING')`.execute(
    db.db,
  );
  let pendingCalls = 0;
  const pendingGateway = {
    refund: async () => {
      pendingCalls++;
      return { status: 'PENDING', gatewayRefundId: 'pending-provider' };
    },
    findRefundByReceipt: async () => ({ status: 'PENDING', gatewayRefundId: 'pending-provider' }),
  } as unknown as PaymentGatewayPort;
  const pendingService = new PaymentRefundService(
    db.db,
    new PostgresRefunds(db.db),
    {} as DurableOperations,
    pendingGateway,
    {} as AppConfig,
  );
  expect(await pendingService.dispatchRefund('pending-test')).toMatchObject({
    status: 'UNKNOWN',
    gatewayRefundId: 'pending-provider',
  });
  expect((await pendingService.dispatchRefund('pending-test')).status).toBe('UNKNOWN');
  expect((await pendingService.recoverUnknown('pending-test')).status).toBe('UNKNOWN');
  expect(pendingCalls).toBe(1);
});
