import { resolve } from 'node:path';
import { sql } from 'kysely';
import { runner } from 'node-pg-migrate';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { MakerChecker } from '../../../src/modules/compliance/infrastructure/maker-checker.js';
import { PostgresPayouts } from '../../../src/modules/payouts/infrastructure/postgres-payouts.js';
import { WalletPrimitives } from '../../../src/modules/wallet/infrastructure/postgres-wallet.js';
import { WalletCreditService } from '../../../src/modules/wallet/infrastructure/postgres-credits.js';
import { WalletSpendService } from '../../../src/modules/wallet/infrastructure/postgres-spend.js';
import {
  emitConfirmedOrder,
  seedDispatchWorld,
  type DispatchWorld,
} from '../../helpers/dispatch-fixture.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
let db: DatabaseHandle;
let world: DispatchWorld;
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl, 10);
  world = await seedDispatchWorld(db);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);

it('concurrent payout drafting and mark-paid replay claim one earning and create one payment audit', async () => {
  const order = await emitConfirmedOrder(db, world),
    task = uuidV7(),
    earning = uuidV7(),
    maker = uuidV7(),
    checker = uuidV7(),
    evidence = uuidV7();
  for (const [id, role] of [
    [maker, 'ADMIN'],
    [checker, 'SUPER_ADMIN'],
  ] as const) {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${id}::uuid,'WORKFORCE',${id},${`${id}@example.invalid`},'operator')`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${id}::uuid,${role})`.execute(db.db);
  }
  await sql`INSERT INTO delivery_tasks(id,order_id,store_id,status,rider_id) VALUES(${task}::uuid,${order.orderId}::uuid,${world.store}::uuid,'ASSIGNED',${world.rider1}::uuid)`.execute(
    db.db,
  );
  await sql`INSERT INTO rider_earnings(id,task_id,rider_id,order_id,base_paise,distance_paise,detention_paise,tip_paise,total_paise,distance_metres,computed_at) VALUES(${earning}::uuid,${task}::uuid,${world.rider1}::uuid,${order.orderId}::uuid,1000,0,0,0,1000,0,'2023-01-01')`.execute(
    db.db,
  );
  const payouts = new PostgresPayouts(db.db, {
    create: (actions) => new MakerChecker(db.db, actions),
  });
  const drafts = await Promise.all(
    Array.from({ length: 5 }, () => payouts.draft(world.rider1, '2023-01-08T18:30:00.000Z')),
  );
  const payoutId = drafts[0]!;
  expect(payoutId).toBeTruthy();
  expect(drafts.every((id) => id === payoutId)).toBe(true);
  const request = await payouts.requestApproval(maker, payoutId);
  await payouts.approve(checker, request);
  await sql`INSERT INTO private_media(id,owner_id,purpose,content_type,size_bytes,state,upload_nonce,file_key) VALUES(${evidence}::uuid,${maker}::uuid,'PAYOUT_EVIDENCE','application/pdf',5,'STORED',${uuidV7()}::uuid,${uuidV7()}::uuid)`.execute(
    db.db,
  );
  const payment = {
    actorId: maker,
    payoutId,
    paymentReference: 'bank-reference',
    evidenceMediaId: evidence,
    idempotencyKey: 'replay-key',
  };
  await Promise.all(Array.from({ length: 5 }, () => payouts.markPaid(payment)));
  await expect(payouts.markPaid({ ...payment, paymentReference: 'changed' })).rejects.toThrow(
    'IDEMPOTENCY_KEY_REUSED',
  );
  const result = await sql<{
    state: string;
    claims: string;
    audits: string;
  }>`SELECT p.state,(SELECT count(*)::text FROM payout_earning_claims WHERE earning_id=${earning}::uuid AND active) AS claims,(SELECT count(*)::text FROM audit_log WHERE action='payout.mark_paid' AND subject_id=p.id::text) AS audits FROM rider_payouts p WHERE p.id=${payoutId}::uuid`.execute(
    db.db,
  );
  expect(result.rows[0]).toEqual({ state: 'PAID', claims: '1', audits: '1' });
});

it('concurrent wallet spends cannot both consume the last available funds', async () => {
  await sql`INSERT INTO feature_flags(key,enabled) VALUES('wallet_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
    db.db,
  );
  const primitives = new WalletPrimitives(db.db);
  await new WalletCreditService(primitives).credit({
    userId: world.customer,
    bucket: 'cash',
    amountPaise: '100',
    reason: 'TOPUP_CREDIT',
    refType: 'TEST',
    refId: uuidV7(),
  });
  const spend = new WalletSpendService(primitives);
  let arrived = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const outcomes = await Promise.allSettled(
    [uuidV7(), uuidV7()].map((reference) =>
      db.db.transaction().execute(async (tx) => {
        arrived++;
        if (arrived === 2) release();
        await barrier;
        return spend.spend(world.customer, reference, '100', tx);
      }),
    ),
  );
  expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = outcomes.find((result) => result.status === 'rejected');
  expect(rejected?.status === 'rejected' ? String(rejected.reason) : '').toContain(
    'WALLET_INSUFFICIENT',
  );
  const result = await sql<{
    balance: string;
    ledger: string;
    debits: string;
  }>`SELECT a.cash_balance_paise::text AS balance,(SELECT sum(l.delta_paise)::text FROM wallet_ledger l WHERE l.account_id=a.id AND l.bucket='cash') AS ledger,(SELECT count(*)::text FROM wallet_ledger l WHERE l.account_id=a.id AND l.reason='ORDER_PAYMENT') AS debits FROM wallet_accounts a WHERE a.user_id=${world.customer}::uuid`.execute(
    db.db,
  );
  expect(result.rows[0]).toEqual({ balance: '0', ledger: '0', debits: '1' });
});
