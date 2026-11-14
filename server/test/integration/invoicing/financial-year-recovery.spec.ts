import { Readable } from 'node:stream';
import { jest } from '@jest/globals';
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
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';

let world: P5World;
if (process.env.AWS_P13_INTEGRATION === 'yes') jest.setTimeout(300000);
beforeAll(
  async () => {
    world = await createP5World();
  },
  process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 120000,
);
afterAll(
  async () => {
    if (world) await closeP5World(world);
  },
  process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 120000,
);
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
  // A failed document backs off without blocking newer invoices.
  expect(await issuer.renderDue(10)).toBe(2);
  await sql`UPDATE invoice_documents SET render_next_attempt_at=clock_timestamp()-interval '1 second'
    WHERE id=${issued[0]!.documentId}::uuid`.execute(world.db.db);
  expect(await issuer.renderDue(10)).toBe(1);
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

it('suspends a poison invoice after five attempts and permits an audited retry', async () => {
  const order = uuidV7();
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,subtotal_paise,total_paise,amount_due_paise,placed_at,delivered_at)
    VALUES(${order}::uuid,${`ORD-${order.replaceAll('-', '').toUpperCase()}`},${world.customer}::uuid,${world.store}::uuid,'{}','DELIVERED','PAID',0,0,0,clock_timestamp(),clock_timestamp())`.execute(
    world.db.db,
  );
  let fail = true;
  const renderer: InvoiceRendererPort = {
    contentType: 'text/html',
    async render() {
      if (fail) throw new Error('poison');
      return 'ok';
    },
  };
  const storage = { putPrivate: async () => undefined } as unknown as StoragePort;
  const issuer = new InvoiceIssuer(world.db.db, renderer, storage);
  const document = (await world.db.db
    .transaction()
    .execute((tx) => issuer.issueForDeliveredOrder(order, tx)))!;
  for (let attempt = 0; attempt < 5; attempt++) {
    expect(await issuer.renderDue(1)).toBe(0);
    await sql`UPDATE invoice_documents SET render_next_attempt_at=clock_timestamp()-interval '1 second'
      WHERE id=${document.documentId}::uuid AND render_suspended_at IS NULL`.execute(world.db.db);
  }
  const failures = await issuer.listRenderFailures(50);
  expect(failures.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ documentId: document.documentId, attempts: 5 }),
    ]),
  );
  fail = false;
  expect(await issuer.renderDue(1)).toBe(0);
  await expect(
    world.db.db
      .transaction()
      .execute((tx) => issuer.retryRender(world.customer, document.documentId, 'recovered', tx)),
  ).rejects.toThrow('FORBIDDEN');
  expect(
    await world.db.db
      .transaction()
      .execute((tx) =>
        issuer.retryRender(world.admin, document.documentId, 'storage recovered', tx),
      ),
  ).toEqual({ documentId: document.documentId, status: 'PENDING' });
  expect(await issuer.renderDue(1)).toBe(1);
  const audit =
    await sql`SELECT 1 FROM audit_log WHERE action='INVOICE_RENDER_RETRY' AND subject_id=${document.documentId}`.execute(
      world.db.db,
    );
  expect(audit.rows).toHaveLength(1);
});

it('fences a stale renderer after another worker reclaims its expired lease', async () => {
  const order = uuidV7();
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,subtotal_paise,total_paise,amount_due_paise,placed_at,delivered_at)
    VALUES(${order}::uuid,${`ORD-${order.replaceAll('-', '').toUpperCase()}`},${world.customer}::uuid,${world.store}::uuid,'{}','DELIVERED','PAID',0,0,0,clock_timestamp(),clock_timestamp())`.execute(
    world.db.db,
  );
  let started!: () => void;
  let release!: () => void;
  const startedRendering = new Promise<void>((resolve) => {
    started = resolve;
  });
  const mayFinish = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowRenderer: InvoiceRendererPort = {
    contentType: 'text/html',
    async render() {
      started();
      await mayFinish;
      return 'same invoice';
    },
  };
  const fastRenderer: InvoiceRendererPort = {
    contentType: 'text/html',
    async render() {
      return 'same invoice';
    },
  };
  const storage = { putPrivate: async () => undefined } as unknown as StoragePort;
  const slow = new InvoiceIssuer(world.db.db, slowRenderer, storage);
  const fast = new InvoiceIssuer(world.db.db, fastRenderer, storage);
  const document = (await world.db.db
    .transaction()
    .execute((tx) => slow.issueForDeliveredOrder(order, tx)))!;
  const stale = slow.renderDue(1);
  await startedRendering;
  try {
    expect(await fast.renderDue(1)).toBe(0);
    await sql`UPDATE invoice_documents SET render_lease_until=clock_timestamp()-interval '1 second'
      WHERE id=${document.documentId}::uuid`.execute(world.db.db);
    expect(await fast.renderDue(1)).toBe(1);
  } finally {
    release();
  }
  expect(await stale).toBe(0);
  const state = await sql<{
    renderer_state: string;
    render_attempts: number;
  }>`SELECT renderer_state,render_attempts FROM invoice_documents WHERE id=${document.documentId}::uuid`.execute(
    world.db.db,
  );
  expect(state.rows[0]).toEqual({ renderer_state: 'RENDERED', render_attempts: 2 });
});

it('protects invoice recovery over HTTP and replays an audited retry', async () => {
  const order = uuidV7();
  await sql`INSERT INTO orders(id,order_number,user_id,store_id,address_snapshot,status,payment_status,subtotal_paise,total_paise,amount_due_paise,placed_at,delivered_at)
    VALUES(${order}::uuid,${`ORD-${order.replaceAll('-', '').toUpperCase()}`},${world.customer}::uuid,${world.store}::uuid,'{}','DELIVERED','PAID',0,0,0,clock_timestamp(),clock_timestamp())`.execute(
    world.db.db,
  );
  const issuer = new InvoiceIssuer(
    world.db.db,
    { contentType: 'text/html', render: async () => 'ok' },
    {} as StoragePort,
  );
  const document = (await world.db.db
    .transaction()
    .execute((tx) => issuer.issueForDeliveredOrder(order, tx)))!;
  await sql`UPDATE invoice_documents SET renderer_state='FAILED',render_attempts=5,render_suspended_at=clock_timestamp()
    WHERE id=${document.documentId}::uuid`.execute(world.db.db);
  const app = await createApplication(
    readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'admin',
      LOG_LEVEL: 'silent',
      DATABASE_URL: world.services.databaseUrl,
      REDIS_URL: world.services.redisUrl,
      RATE_LIMIT_DEFAULT_PER_MIN: '5000',
      RATE_LIMIT_AUTH_PER_MIN: '5000',
      METRICS_BEARER_TOKEN: 'invoice-metrics-test',
    }),
  );
  try {
    const http = app.getHttpAdapter().getInstance();
    const token = await new LocalTokenAdapter(
      readEnv({ NODE_ENV: 'test' }).LOCAL_JWT_SECRET,
      world.db.db,
    ).issue('WORKFORCE', 'p5-admin', 'admin', 'access');
    const headers = { authorization: `Bearer ${token}` };
    expect(
      (await http.inject({ method: 'GET', url: '/v1/admin/invoices/render-failures' })).statusCode,
    ).toBe(401);
    const list = await http.inject({
      method: 'GET',
      url: '/v1/admin/invoices/render-failures',
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual(
      expect.arrayContaining([expect.objectContaining({ documentId: document.documentId })]),
    );
    const metrics = await http.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer invoice-metrics-test' },
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.body).toContain('delivery_invoice_render_suspended 1');
    const url = `/v1/admin/invoices/${document.documentId}/render-retry`;
    expect(
      (await http.inject({ method: 'POST', url, headers, payload: { reason: 'fixed' } }))
        .statusCode,
    ).toBe(400);
    const key = uuidV7();
    const send = (reason: string) =>
      http.inject({
        method: 'POST',
        url,
        headers: { ...headers, 'idempotency-key': key },
        payload: { reason },
      });
    const first = await send('storage repaired');
    const replay = await send('storage repaired');
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const recoveredMetrics = await http.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Bearer invoice-metrics-test' },
    });
    expect(recoveredMetrics.body).toContain('delivery_invoice_render_suspended 0');
    expect((await send('different reason')).statusCode).toBe(409);
    const audit =
      await sql`SELECT 1 FROM audit_log WHERE action='INVOICE_RENDER_RETRY' AND subject_id=${document.documentId}`.execute(
        world.db.db,
      );
    expect(audit.rows).toHaveLength(1);
  } finally {
    await app.close();
  }
});
