import { sql } from 'kysely';
import { REPORT_KINDS } from '../../../src/modules/compliance/contracts/report-data.js';
import { PostgresReportData } from '../../../src/modules/compliance/infrastructure/report-data.js';
import { createP5World, closeP5World, type P5World } from '../../helpers/p5-world.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';

let world: P5World;
const reports = new PostgresReportData();
beforeAll(async () => {
  world = await createP5World();
});
afterAll(async () => {
  await closeP5World(world);
});

it('executes every report on actual schema and scopes stock/catalog cursors to kind and store', async () => {
  const first = await world.variant({ stock: 10n }),
    second = await world.variant({ stock: 3n });
  await sql`UPDATE inventory_batches SET state='QUARANTINED' WHERE store_id=${world.store}::uuid AND variant_id=${first.id}::uuid`.execute(
    world.db.db,
  );
  await world.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (tx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      for (const kind of REPORT_KINDS)
        await expect(reports.page(kind, null, 10, tx)).resolves.toHaveProperty('rows');
      const all = await reports.page('stock', null, 10, tx, { storeId: world.store });
      expect(all.rows).toHaveLength(2);
      expect(all.rows.find((row) => row['variant_id'] === first.id)).toMatchObject({
        on_hand: '10',
        available: '0',
      });
      expect(all.rows.find((row) => row['variant_id'] === second.id)).toMatchObject({
        available: '3',
      });
      const page = await reports.page('stock', null, 1, tx, { storeId: world.store });
      expect(page.nextCursor).not.toBeNull();
      const next = await reports.page('stock', page.nextCursor, 1, tx, { storeId: world.store });
      expect(next.rows[0]?.['row_key']).not.toBe(page.rows[0]?.['row_key']);
      await expect(
        reports.page('stock', page.nextCursor, 1, tx, { storeId: world.otherStore }),
      ).rejects.toThrow('INVALID_CURSOR');
      await expect(
        reports.page('catalog', page.nextCursor, 1, tx, { storeId: world.store }),
      ).rejects.toThrow('INVALID_CURSOR');
      await expect(reports.page('stock', null, 1001, tx)).rejects.toThrow('INVALID_REPORT_REQUEST');
    });
});

it('keeps top-up funding distinct from order captures and excludes customer PII', async () => {
  const order = uuidV7(),
    attempt = uuidV7(),
    topup = uuidV7();
  const payment = 'pay_' + uuidV7();
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,payment_method,subtotal_paise,total_paise,amount_due_paise,metadata,placed_at)
    VALUES(${order}::uuid,${'ORD-' + order.replaceAll('-', '').toUpperCase()},${world.customer}::uuid,${world.store}::uuid,'{}','CONFIRMED','PAID','GATEWAY',1000,1000,1000,${JSON.stringify({ fundingPaymentId: payment })}::jsonb,clock_timestamp())`.execute(
    world.db.db,
  );
  await sql`INSERT INTO payment_attempts(id,aggregate_id,order_id,user_id,kind,operation_reference,gateway,gateway_payment_id,amount_paise,currency,status)
    VALUES(${attempt}::uuid,${order}::uuid,${order}::uuid,${world.customer}::uuid,'ORDER_PAYMENT',${'order-' + attempt.replaceAll('-', '').slice(0, 30)},'fake',${payment},1000,'INR','CAPTURED'),
    (${topup}::uuid,${topup}::uuid,NULL,${world.customer}::uuid,'WALLET_TOPUP',${'topup-' + topup.replaceAll('-', '').slice(0, 30)},'fake',${'pay_' + topup},200,'INR','CAPTURED')`.execute(
    world.db.db,
  );
  await sql`INSERT INTO payment_capture_receipts(id,attempt_id,order_id,gateway_payment_id,amount_paise,currency)
    VALUES(${uuidV7()}::uuid,${attempt}::uuid,${order}::uuid,${payment},1000,'INR'),(${uuidV7()}::uuid,${topup}::uuid,NULL,${'pay_' + topup},200,'INR')`.execute(
    world.db.db,
  );
  await world.db.db.transaction().execute(async (tx) => {
    const data = await reports.page('financial', null, 100, tx);
    expect(
      data.rows
        .filter((row) => row['activity'] === 'ORDER_CAPTURE')
        .map((row) => row['amount_paise']),
    ).toEqual(['1000']);
    expect(
      data.rows
        .filter((row) => row['activity'] === 'WALLET_TOPUP_CAPTURE')
        .map((row) => row['amount_paise']),
    ).toEqual(['200']);
    expect(JSON.stringify(data.rows)).not.toMatch(/email|phone|address_snapshot|normalized_email/);
    const scoped = await reports.page('financial', null, 100, tx, { storeId: world.store });
    expect(scoped.rows).toHaveLength(1);
    await expect(
      reports.page('financial', null, 10, tx, {
        from: '2027-01-01T00:00:00Z',
        to: '2026-01-01T00:00:00Z',
      }),
    ).rejects.toThrow('INVALID_REPORT_FILTER');
  });
});

it('keeps stock expiry eligibility fixed at the export transaction snapshot', async () => {
  const variant = await world.variant({ stock: 7n });
  await world.db.db
    .transaction()
    .setIsolationLevel('repeatable read')
    .execute(async (tx) => {
      await sql`UPDATE inventory_batches SET expires_at=transaction_timestamp()+interval '1 second' WHERE store_id=${world.store}::uuid AND variant_id=${variant.id}::uuid`.execute(
        tx,
      );
      const before = await reports.page('stock', null, 100, tx, { storeId: world.store });
      await sql`SELECT pg_sleep(1.1)`.execute(tx);
      const after = await reports.page('stock', null, 100, tx, { storeId: world.store });
      expect(before.rows.find((row) => row['variant_id'] === variant.id)?.['available']).toBe('7');
      expect(after.rows.find((row) => row['variant_id'] === variant.id)?.['available']).toBe('7');
      await expect(
        reports.page('stock', null, 100, tx, { from: '2026-01-01T00:00:00Z' }),
      ).rejects.toThrow('INVALID_REPORT_FILTER');
    });
});
