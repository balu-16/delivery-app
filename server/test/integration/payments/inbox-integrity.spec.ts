import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { PostgresWebhookInbox } from '../../../src/modules/payments/infrastructure/postgres-inbox.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

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

it('quarantines invalid signatures atomically and grants only one due claim', async () => {
  const inbox = new PostgresWebhookInbox(db.db);
  const invalid = await inbox.insert({
    gateway: 'fake',
    eventId: 'invalid-test',
    eventType: null,
    body: '{}',
    signature: '',
    signatureValid: false,
  });
  expect((await inbox.byId(invalid.inboxId))?.state).toBe('QUARANTINED');
  expect(await inbox.claim(invalid.inboxId)).toMatchObject({ state: 'QUARANTINED' });
  const valid = await inbox.insert({
    gateway: 'fake',
    eventId: 'valid-test',
    eventType: null,
    body: '{}',
    signature: 'x',
    signatureValid: true,
  });
  const claims = await Promise.all(Array.from({ length: 8 }, () => inbox.claim(valid.inboxId)));
  expect(claims.filter((row) => row?.state === 'PROCESSING')).toHaveLength(1);
  await sql`UPDATE gateway_event_inbox SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE id=${valid.inboxId}::uuid`.execute(
    db.db,
  );
  const reclaimed = await inbox.claim(valid.inboxId);
  expect(reclaimed?.attempts).toBe(2);
  await inbox.scheduleRetry(valid.inboxId, 1);
  expect((await inbox.byId(valid.inboxId))?.state).toBe('PROCESSING');
});

it('restores only each partial wallet refund once under concurrent retries', async () => {
  const { WalletPrimitives } =
    await import('../../../src/modules/wallet/infrastructure/postgres-wallet.js');
  const { WalletReversalService } =
    await import('../../../src/modules/wallet/infrastructure/postgres-reversals.js');
  const user = '11111111-1111-4111-8111-111111111111';
  const account = '22222222-2222-4222-8222-222222222222';
  const lot = '33333333-3333-4333-8333-333333333333';
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES (${user}::uuid,'CUSTOMER','wallet-test','wallet-test@example.invalid','Test')`.execute(
    db.db,
  );
  await sql`INSERT INTO wallet_accounts(id,user_id,cash_balance_paise,promo_balance_paise) VALUES (${account}::uuid,${user}::uuid,0,0)`.execute(
    db.db,
  );
  await sql`INSERT INTO wallet_promo_lots(id,account_id,grant_reason,source_reference,amount_paise,remaining_paise,state) VALUES (${lot}::uuid,${account}::uuid,'PROMO_GRANT','grant',100,0,'EXHAUSTED')`.execute(
    db.db,
  );
  await sql`INSERT INTO wallet_ledger(id,account_id,bucket,delta_paise,reason,ref_type,ref_id,lot_allocations,balance_after) VALUES (gen_random_uuid(),${account}::uuid,'promo',-100,'ORDER_PAYMENT','ORDER','spend',${JSON.stringify([{ lotId: lot, amountPaise: '100' }])}::jsonb,0)`.execute(
    db.db,
  );
  const reversal = new WalletReversalService(new WalletPrimitives(db.db));
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      reversal.reverseSpend('spend', undefined, {
        amountPaise: '30',
        reversalReference: 'refund-one',
      }),
    ),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  await reversal.reverseSpend('spend', undefined, {
    amountPaise: '20',
    reversalReference: 'refund-two',
  });
  const rows = await sql<{
    balance: string;
    remaining: string;
  }>`SELECT a.promo_balance_paise::text AS balance,l.remaining_paise::text AS remaining FROM wallet_accounts a JOIN wallet_promo_lots l ON l.account_id=a.id WHERE a.id=${account}::uuid`.execute(
    db.db,
  );
  expect(rows.rows[0]).toEqual({ balance: '50', remaining: '50' });
  await expect(
    reversal.reverseSpend('spend', undefined, {
      amountPaise: '51',
      reversalReference: 'refund-three',
    }),
  ).rejects.toThrow('REFUND_LIMIT_EXCEEDED');
});

it('settles every fulfilled line and reduces COD due for a partial short', async () => {
  const { seedDispatchWorld, emitConfirmedOrder } =
    await import('../../helpers/dispatch-fixture.js');
  const { OrderPickingIntegration } =
    await import('../../../src/modules/orders/infrastructure/picking-integration.js');
  const world = await seedDispatchWorld(db);
  const { orderId } = await emitConfirmedOrder(db, world, { cod: true });
  const category = '44444444-4444-4444-8444-444444444444';
  const product = '55555555-5555-4555-8555-555555555555';
  const variant = '66666666-6666-4666-8666-666666666666';
  const item = '77777777-7777-4777-8777-777777777777';
  await sql`INSERT INTO catalog_categories(id,name) VALUES (${category}::uuid,'test category')`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_products(id,category_id,name,normalized_name,published) VALUES (${product}::uuid,${category}::uuid,'Test','test',true)`.execute(
    db.db,
  );
  await sql`INSERT INTO catalog_variants(id,product_id,name,sku) VALUES (${variant}::uuid,${product}::uuid,'Test','test-sku')`.execute(
    db.db,
  );
  await sql`INSERT INTO order_items(id,order_id,variant_id,name_snapshot,ordered_qty,unit_price_paise,mrp_paise,discount_paise,tax_paise,tax_rate_bps,hsn_code) VALUES (${item}::uuid,${orderId}::uuid,${variant}::uuid,'original',3,100,100,30,15,500,'test')`.execute(
    db.db,
  );
  const adapter = new OrderPickingIntegration(
    db.db,
    {} as import('../../../src/modules/orders/infrastructure/order-service.js').OrderService,
    { refundableCapacity: async () => [] } as never,
  );
  const result = await adapter.settleFulfillment({
    orderId,
    actorId: world.manager,
    lines: [{ orderItemId: item, variantId: variant, fulfilledQty: '2', shortQty: '1' }],
  });
  expect(result.refundedPaise).toBe('90');
  const rows = await sql<{
    fulfilled: string;
    short: string;
    due: string;
    name: string;
  }>`SELECT i.fulfilled_qty::text AS fulfilled,i.short_qty::text AS short,(SELECT amount_paise::text FROM cod_collections WHERE order_id=o.id) AS due,i.name_snapshot AS name FROM order_items i JOIN orders o ON o.id=i.order_id WHERE i.id=${item}::uuid`.execute(
    db.db,
  );
  expect(rows.rows[0]).toEqual({ fulfilled: '2', short: '1', due: '46910', name: 'original' });
});
