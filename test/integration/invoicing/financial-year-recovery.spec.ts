import { Readable } from 'node:stream';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import type {
  InvoicePayload,
  InvoiceDocumentView,
  InvoiceRendererPort,
} from '../../../src/modules/invoicing/contracts/invoicing.js';
import { InvoiceIssuer } from '../../../src/modules/invoicing/infrastructure/invoice-issuer.js';
import type { StoragePort } from '../../../src/modules/media/contracts/storage.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';

let world: P5World;
beforeAll(async () => {
  world = await createP5World();
}, 120000);
afterAll(async () => {
  if (world) await closeP5World(world);
}, 120000);
it('separates IST fiscal-year invoice sequences and retries rendering without changing issued data', async () => {
  const orders = [uuidV7(), uuidV7(), uuidV7()];
  const times = [
    '2026-03-31T18:29:59.999Z',
    '2026-03-31T18:30:00.000Z',
    '2026-03-31T18:30:00.001Z',
  ];
  for (const [index, id] of orders.entries()) {
    await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,subtotal_paise,total_paise,amount_due_paise,placed_at,delivered_at) VALUES(${id}::uuid,${`ORD-${id.replaceAll('-', '').toUpperCase()}`},${world.customer}::uuid,${world.store}::uuid,'{}','DELIVERED','PAID',0,0,0,${times[index]!}::timestamptz,${times[index]!}::timestamptz)`.execute(
      world.db.db,
    );
  }
  let fails = true;
  const renderCalls: Array<{ payload: InvoicePayload; number: string | undefined }> = [];
  const renderer: InvoiceRendererPort = {
    contentType: 'text/html',
    async render(payload, number) {
      renderCalls.push({ payload, number });
      if (fails) {
        fails = false;
        throw new Error('injected render failure');
      }
      return JSON.stringify({ payload, number });
    },
  };
  const objects = new Map<string, Buffer>();
  const storage = {
    async putPrivate(key: string, body: Buffer) {
      objects.set(key, body);
    },
    async open(key: string) {
      return Readable.from([objects.get(key)!]);
    },
  } as unknown as StoragePort;
  const issuer = new InvoiceIssuer(world.db.db, renderer, storage);
  const issued: InvoiceDocumentView[] = [];
  for (const id of orders)
    issued.push(
      (await world.db.db.transaction().execute((tx) => issuer.issueForDeliveredOrder(id, tx)))!,
    );
  expect(issued.map((document) => [document.financialYear, document.seqNo])).toEqual([
    ['2025-26', '1'],
    ['2026-27', '1'],
    ['2026-27', '2'],
  ]);
  expect(new Set(issued.map((document) => document.number)).size).toBe(3);
  expect(await issuer.renderDue(1)).toBe(0);
  const failed = await sql<{
    number: string;
    payload: InvoicePayload;
    renderer_state: string;
  }>`SELECT number,payload,renderer_state FROM invoice_documents WHERE id=${issued[0]!.documentId}::uuid`.execute(
    world.db.db,
  );
  expect(failed.rows[0]).toEqual({
    number: issued[0]!.number,
    payload: issued[0]!.payload,
    renderer_state: 'FAILED',
  });
  expect(await issuer.renderDue(10)).toBe(3);
  const recovered = await issuer.invoiceForOrder(orders[0]!, world.customer);
  expect(recovered.document.number).toBe(issued[0]!.number);
  expect(recovered.document.payload).toEqual(issued[0]!.payload);
  expect(recovered.document.rendererState).toBe('RENDERED');
  expect(renderCalls.filter((call) => call.number === issued[0]!.number)).toHaveLength(2);
  expect(
    renderCalls
      .filter((call) => call.number === issued[0]!.number)
      .every((call) => JSON.stringify(call.payload) === JSON.stringify(issued[0]!.payload)),
  ).toBe(true);
  const counters = await sql<{
    financial_year: string;
    last_no: string;
  }>`SELECT financial_year,last_no::text FROM invoice_sequences WHERE legal_entity_id=${world.entity}::uuid ORDER BY financial_year`.execute(
    world.db.db,
  );
  expect(counters.rows).toEqual([
    { financial_year: '2025-26', last_no: '1' },
    { financial_year: '2026-27', last_no: '2' },
  ]);
});
