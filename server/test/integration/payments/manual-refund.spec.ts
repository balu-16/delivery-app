import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
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
  db = createDatabase(services.databaseUrl, 4);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);
it('requires an authorized operator and private evidence before settling a manual refund', async () => {
  const world = await seedDispatchWorld(db),
    order = await emitConfirmedOrder(db, world),
    admin = uuidV7(),
    media = uuidV7(),
    refund = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${admin}::uuid,'WORKFORCE',${admin},${`${admin}@test.invalid`},'admin')`.execute(
    db.db,
  );
  await sql`INSERT INTO user_roles(user_id,role) VALUES(${admin}::uuid,'ADMIN')`.execute(db.db);
  await sql`INSERT INTO private_media(id,owner_id,purpose,content_type,size_bytes,state,upload_nonce,file_key) VALUES(${media}::uuid,${admin}::uuid,'PAYOUT_EVIDENCE','application/pdf',5,'STORED',${uuidV7()}::uuid,${uuidV7()}::uuid)`.execute(
    db.db,
  );
  await sql`INSERT INTO payment_refunds(id,order_id,refund_reference,source_type,source_id,amount_paise,destination,status) VALUES(${refund}::uuid,${order.orderId}::uuid,'manual-test','COD_COLLECTION','collection',100,'MANUAL_PAYOUT','PENDING')`.execute(
    db.db,
  );
  const service = new PaymentRefundService(
    db.db,
    new PostgresRefunds(db.db),
    {} as DurableOperations,
    {} as PaymentGatewayPort,
    {} as AppConfig,
  );
  await expect(service.applyOutcome('manual-test', { status: 'PROCESSED' })).rejects.toThrow(
    'INVALID_REFUND_DESTINATION',
  );
  const input = {
    refundReference: 'manual-test',
    actorId: admin,
    paymentReference: 'external-123',
    evidenceMediaId: media,
    idempotencyKey: 'settle-123',
  };
  await expect(service.markManualRefundPaid({ ...input, actorId: world.customer })).rejects.toThrow(
    'FORBIDDEN',
  );
  await expect(
    service.markManualRefundPaid({ ...input, evidenceMediaId: uuidV7() }),
  ).rejects.toThrow('MEDIA_NOT_FOUND');
  expect((await service.markManualRefundPaid(input)).status).toBe('PROCESSED');
  expect((await service.markManualRefundPaid(input)).status).toBe('PROCESSED');
  await expect(
    service.markManualRefundPaid({ ...input, paymentReference: 'different' }),
  ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  const result = await sql<{
    n: string;
  }>`SELECT count(*)::text AS n FROM outbox_events WHERE aggregate_type='payment_refund' AND aggregate_id=${refund}::uuid AND event_type='payments.refund.settled'`.execute(
    db.db,
  );
  expect(result.rows[0]?.n).toBe('1');
});
