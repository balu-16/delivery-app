import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { MakerChecker } from '../../../src/modules/compliance/infrastructure/maker-checker.js';
import { PostgresPayouts } from '../../../src/modules/payouts/infrastructure/postgres-payouts.js';
import { PostgresRiderCash } from '../../../src/modules/riders/infrastructure/postgres-rider-cash.js';
import type { RiderSettings } from '../../../src/modules/riders/infrastructure/settings.js';
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
  db = createDatabase(services.databaseUrl, 5);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);
it('rejects a stale approval, posts one offset and never treats it as a deposit', async () => {
  const w = await seedDispatchWorld(db),
    order = await emitConfirmedOrder(db, w),
    task = uuidV7(),
    earning = uuidV7(),
    maker = uuidV7(),
    checker = uuidV7();
  for (const [id, role] of [
    [maker, 'ADMIN'],
    [checker, 'SUPER_ADMIN'],
  ] as const) {
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${id}::uuid,'WORKFORCE',${id},${`${id}@test.invalid`},'operator')`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${id}::uuid,${role})`.execute(db.db);
  }
  await sql`INSERT INTO delivery_tasks(id,order_id,store_id,status,rider_id) VALUES(${task}::uuid,${order.orderId}::uuid,${w.store}::uuid,'ASSIGNED',${w.rider1}::uuid)`.execute(
    db.db,
  );
  await sql`INSERT INTO rider_earnings(id,task_id,rider_id,order_id,base_paise,distance_paise,detention_paise,tip_paise,total_paise,distance_metres,computed_at) VALUES(${earning}::uuid,${task}::uuid,${w.rider1}::uuid,${order.orderId}::uuid,1000,0,0,0,1000,0,'2023-01-01')`.execute(
    db.db,
  );
  await sql`INSERT INTO rider_cash_ledger(id,rider_id,delta_paise,reason,ref_type,ref_id,balance_after) VALUES(${uuidV7()}::uuid,${w.rider1}::uuid,1500,'COD_COLLECTED','test',${uuidV7()},1500)`.execute(
    db.db,
  );
  const service = new PostgresPayouts(db.db, {
    create: (actions) => new MakerChecker(db.db, actions),
  });
  const cash = new PostgresRiderCash(db.db, {} as RiderSettings);
  const id = await service.draft(w.rider1, '2023-01-08T18:30:00.000Z');
  expect(id).not.toBeNull();
  const old = await service.requestApproval(maker, id!);
  await cash.recordDeposit({
    riderId: w.rider1,
    amountPaise: '600',
    depositReference: uuidV7(),
    actorId: maker,
  });
  await expect(service.approve(checker, old)).rejects.toThrow('PAYOUT_STALE');
  await service.cancel(maker, id!);
  const fresh = await service.draft(w.rider1, '2023-01-08T18:30:00.000Z');
  const approvals = await Promise.all(
    Array.from({ length: 5 }, () => service.requestApproval(maker, fresh!)),
  );
  const approval = approvals[0]!;
  expect(approvals.every((id) => id === approval)).toBe(true);
  await expect(service.approve(maker, approval)).rejects.toThrow();
  await service.approve(checker, approval);
  await expect(service.approve(checker, approval)).rejects.toThrow();
  const row = await sql<{
    state: string;
    cash_offset_paise: string;
    net_paise: string;
  }>`SELECT state,cash_offset_paise::text,net_paise::text FROM rider_payouts WHERE id=${fresh!}::uuid`.execute(
    db.db,
  );
  expect(row.rows[0]).toEqual({ state: 'APPROVED', cash_offset_paise: '900', net_paise: '100' });
  const ledger = await sql<{
    reason: string;
    ref_type: string;
    delta_paise: string;
  }>`SELECT reason,ref_type,delta_paise::text FROM rider_cash_ledger WHERE rider_id=${w.rider1}::uuid ORDER BY created_at,id`.execute(
    db.db,
  );
  expect(ledger.rows.filter((r) => r.ref_type === 'payout_offset')).toEqual([
    { reason: 'ADJUSTMENT', ref_type: 'payout_offset', delta_paise: '-900' },
  ]);
  const count = await sql<{
    n: string;
  }>`SELECT COUNT(*)::text AS n FROM cod_settlements WHERE rider_id=${w.rider1}::uuid`.execute(
    db.db,
  );
  expect(count.rows[0]?.n).toBe('1');
  expect(await service.hasUnsettledPayout(w.rider1)).toBe(true);
  const correctionInput = {
    actorId: maker,
    payoutId: fresh!,
    deltaPaise: '100',
    reason: 'Missing payment',
    reference: 'correction-1',
  };
  const correctionApprovals = await Promise.all(
    Array.from({ length: 3 }, () => service.requestCorrection(correctionInput)),
  );
  expect(correctionApprovals.every((id) => id === correctionApprovals[0])).toBe(true);
  await expect(service.approve(maker, correctionApprovals[0]!)).rejects.toThrow();
  await service.approve(checker, correctionApprovals[0]!);
  const corrections = await sql<{
    id: string;
    state: string;
    delta_paise: string;
  }>`SELECT id,state,delta_paise::text FROM payout_corrections WHERE payout_id=${fresh!}::uuid`.execute(
    db.db,
  );
  expect(corrections.rows).toHaveLength(1);
  expect(corrections.rows[0]).toMatchObject({ state: 'CREDIT_PENDING', delta_paise: '100' });
  const secondCorrection = await service.requestCorrection({
    actorId: maker,
    payoutId: fresh!,
    deltaPaise: '30',
    reason: 'Other adjustment',
    reference: 'correction-2',
  });
  await service.approve(checker, secondCorrection);
  const correctionPage1 = await service.listCorrections(maker, fresh!, undefined, 1);
  const correctionPage2 = await service.listCorrections(
    maker,
    fresh!,
    correctionPage1.nextCursor!,
    1,
  );
  expect(correctionPage1.items).toHaveLength(1);
  expect(correctionPage2.items).toHaveLength(1);
  expect(correctionPage2.nextCursor).toBeNull();

  const evidence = uuidV7();
  await sql`INSERT INTO private_media(id,owner_id,purpose,content_type,size_bytes,state,upload_nonce,file_key) VALUES(${evidence}::uuid,${maker}::uuid,'PAYOUT_EVIDENCE','application/pdf',5,'STORED',${uuidV7()}::uuid,${uuidV7()}::uuid)`.execute(
    db.db,
  );
  const settlement = {
    actorId: maker,
    correctionId: corrections.rows[0]!.id,
    paymentReference: 'manual-correction-payment',
    evidenceMediaId: evidence,
    idempotencyKey: 'correction-paid',
  };
  await service.settleCorrection(settlement);
  await service.settleCorrection(settlement);
  await expect(
    service.settleCorrection({ ...settlement, paymentReference: 'changed' }),
  ).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
  const intact = await sql<{
    state: string;
    net: string;
  }>`SELECT state,net_paise::text AS net FROM rider_payouts WHERE id=${fresh!}::uuid`.execute(
    db.db,
  );
  expect(intact.rows[0]).toEqual({ state: 'APPROVED', net: '100' });
  const order2 = await emitConfirmedOrder(db, w),
    order3 = await emitConfirmedOrder(db, w),
    task2 = uuidV7(),
    task3 = uuidV7();
  await sql`INSERT INTO delivery_tasks(id,order_id,store_id,status,rider_id) VALUES(${task2}::uuid,${order2.orderId}::uuid,${w.store}::uuid,'ASSIGNED',${w.rider2}::uuid),(${task3}::uuid,${order3.orderId}::uuid,${w.store}::uuid,'ASSIGNED',${w.rider2}::uuid)`.execute(
    db.db,
  );
  await sql`INSERT INTO rider_earnings(id,task_id,rider_id,order_id,base_paise,distance_paise,detention_paise,tip_paise,total_paise,distance_metres,computed_at) VALUES(${uuidV7()}::uuid,${task2}::uuid,${w.rider2}::uuid,${order2.orderId}::uuid,1000,0,0,0,1000,0,'2022-12-25'),(${uuidV7()}::uuid,${task3}::uuid,${w.rider2}::uuid,${order3.orderId}::uuid,1000,0,0,0,1000,0,'2023-01-08T18:30:00Z')`.execute(
    db.db,
  );
  await sql`INSERT INTO rider_cash_ledger(id,rider_id,delta_paise,reason,ref_type,ref_id,balance_after) VALUES(${uuidV7()}::uuid,${w.rider2}::uuid,1500,'COD_COLLECTED','test',${uuidV7()},1500)`.execute(
    db.db,
  );
  const zero = await service.draft(w.rider2, '2023-01-08T18:30:00.000Z');
  const zeroApproval = await service.requestApproval(maker, zero!);
  await service.approve(checker, zeroApproval);
  const zeroRow = await sql<{
    state: string;
    gross: string;
    net: string;
    payment_reference: string;
  }>`SELECT state,gross_paise::text AS gross,net_paise::text AS net,payment_reference FROM rider_payouts WHERE id=${zero!}::uuid`.execute(
    db.db,
  );
  expect(zeroRow.rows[0]).toEqual({
    state: 'SETTLED_ZERO',
    gross: '1000',
    net: '0',
    payment_reference: `zero:${zero}`,
  });
  expect((await cash.cashInHand(w.rider2)).cashInHandPaise).toBe('500');
  expect(await service.hasUnsettledPayout(w.rider2)).toBe(false);
  const receivableApproval = await service.requestCorrection({
    actorId: maker,
    payoutId: zero!,
    deltaPaise: '-50',
    reason: 'Prior overpayment',
    reference: 'receivable',
  });
  await service.approve(checker, receivableApproval);
  expect(await service.hasUnsettledPayout(w.rider2)).toBe(true);
  const receivable = await sql<{
    id: string;
    state: string;
  }>`SELECT id,state FROM payout_corrections WHERE payout_id=${zero!}::uuid`.execute(db.db);
  expect(receivable.rows[0]?.state).toBe('RECEIVABLE_OPEN');
  const { PostgresP11Privacy } =
    await import('../../../src/modules/support/infrastructure/privacy.js');
  const privacy = new PostgresP11Privacy(db.db),
    exported = await privacy.exportForUser(w.rider2);
  expect(JSON.stringify(exported.items)).toContain('RECEIVABLE_OPEN');
  await expect(
    service.settleCorrection({
      actorId: maker,
      correctionId: receivable.rows[0]!.id,
      paymentReference: 'receipt',
      evidenceMediaId: uuidV7(),
      idempotencyKey: 'receipt-key',
    }),
  ).rejects.toThrow('MEDIA_NOT_FOUND');
  expect(await service.hasUnsettledPayout(w.rider2)).toBe(true);
  await service.settleCorrection({
    actorId: maker,
    correctionId: receivable.rows[0]!.id,
    paymentReference: 'receipt',
    evidenceMediaId: evidence,
    idempotencyKey: 'receipt-key',
  });
  expect(await service.hasUnsettledPayout(w.rider2)).toBe(false);
  const next = await service.draft(w.rider2, '2023-01-15T18:30:00.000Z');
  const nextRow = await sql<{
    gross: string;
    cash_offset: string;
    net: string;
  }>`SELECT gross_paise::text AS gross,cash_offset_paise::text AS cash_offset,net_paise::text AS net FROM rider_payouts WHERE id=${next!}::uuid`.execute(
    db.db,
  );
  expect(nextRow.rows[0]).toEqual({ gross: '1000', cash_offset: '500', net: '500' });
  const order4 = await emitConfirmedOrder(db, w),
    task4 = uuidV7();
  await sql`INSERT INTO delivery_tasks(id,order_id,store_id,status,rider_id) VALUES(${task4}::uuid,${order4.orderId}::uuid,${w.store}::uuid,'ASSIGNED',${w.rider3}::uuid)`.execute(
    db.db,
  );
  await sql`INSERT INTO rider_earnings(id,task_id,rider_id,order_id,base_paise,distance_paise,detention_paise,tip_paise,total_paise,distance_metres,computed_at) VALUES(${uuidV7()}::uuid,${task4}::uuid,${w.rider3}::uuid,${order4.orderId}::uuid,1000,0,0,0,1000,0,'2023-01-01')`.execute(
    db.db,
  );
  await sql`INSERT INTO rider_cash_ledger(id,rider_id,delta_paise,reason,ref_type,ref_id,balance_after) VALUES(${uuidV7()}::uuid,${w.rider3}::uuid,1500,'COD_COLLECTED','test',${uuidV7()},1500)`.execute(
    db.db,
  );
  const race = await service.draft(w.rider3, '2023-01-08T18:30:00.000Z'),
    raceApproval = await service.requestApproval(maker, race!);
  let unlock!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    }),
    ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
  const lock = db.db.transaction().execute(async (tx) => {
    await sql`SELECT rider_id FROM rider_status WHERE rider_id=${w.rider3}::uuid FOR UPDATE`.execute(
      tx,
    );
    locked();
    await gate;
  });
  await ready;
  const contenders = Promise.allSettled([
    service.approve(checker, raceApproval),
    cash.recordDeposit({
      riderId: w.rider3,
      amountPaise: '600',
      depositReference: uuidV7(),
      actorId: maker,
    }),
  ]);
  unlock();
  await lock;
  const outcomes = await contenders;
  expect(outcomes[1]?.status).toBe('fulfilled');
  const entries = await sql<{
    n: string;
    applied: string;
  }>`SELECT COUNT(*)::text AS n,COALESCE(SUM(-delta_paise),0)::text AS applied FROM rider_cash_ledger WHERE rider_id=${w.rider3}::uuid AND delta_paise<0`.execute(
    db.db,
  );
  expect(BigInt(entries.rows[0]!.applied)).toBeLessThanOrEqual(1500n);
  expect(BigInt((await cash.cashInHand(w.rider3)).cashInHandPaise)).toBeGreaterThanOrEqual(0n);
  if (outcomes[0]?.status === 'rejected')
    expect(String(outcomes[0].reason)).toContain('PAYOUT_STALE');
});
