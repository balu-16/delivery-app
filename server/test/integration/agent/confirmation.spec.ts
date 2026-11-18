import { resolve } from 'node:path';
import { jest } from '@jest/globals';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { AgentDrafts } from '../../../src/modules/agent/infrastructure/drafts.js';
import { computeQuote } from '../../../src/modules/pricing/contracts/pricing.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { assertDisposableAgentDatabase } from './disposable-database.js';

let services: TestServices, db: DatabaseHandle, drafts: AgentDrafts;
let customer: string, stranger: string, thread: string;

beforeAll(async () => {
  services = await startTestServices({ skipAwsCache: true });
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl, 4, 10000, undefined, 30000);
  await assertDisposableAgentDatabase(db.db);
  drafts = new AgentDrafts(db.db);
  customer = uuidV7();
  stranger = uuidV7();
  thread = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES
    (${customer}::uuid,'CUSTOMER','agent-test-customer','agent-customer@example.test','Customer',true),
    (${stranger}::uuid,'CUSTOMER','agent-test-other','agent-other@example.test','Other',true)`.execute(
    db.db,
  );
  await sql`INSERT INTO agent_threads(id,user_id) VALUES(${thread}::uuid,${customer}::uuid)`.execute(
    db.db,
  );
  await sql`INSERT INTO consents(user_id,type,version) VALUES(${customer}::uuid,'ai_assistant','1'),(${stranger}::uuid,'ai_assistant','1')`.execute(
    db.db,
  );
  await sql`INSERT INTO feature_flags(key,enabled) VALUES('agent_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
    db.db,
  );
}, 300000);

afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 300000);

test('repeated concurrent approval executes one transactional effect and replays its result', async () => {
  const payload = { orderId: uuidV7(), quantity: 2 };
  const first = await drafts.prepare({
    userId: customer,
    threadId: thread,
    toolCallId: 'same-call',
    type: 'cancel',
    payload,
    expiresAt: new Date(Date.now() + 60000),
  });
  const again = await drafts.prepare({
    userId: customer,
    threadId: thread,
    toolCallId: 'same-call',
    type: 'cancel',
    payload,
    expiresAt: new Date(Date.now() + 60000),
  });
  expect(again.id).toBe(first.id);
  const execute = async (
    _payload: unknown,
    tx: Parameters<Parameters<AgentDrafts['decide']>[1]>[1],
  ) => {
    await sql`INSERT INTO durable_operations(id,kind,reference,state) VALUES(${uuidV7()}::uuid,'agent_test',${first.id},'DONE')`.execute(
      tx,
    );
    return { receipt: 'recorded' };
  };
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      drafts.decide(
        { userId: customer, threadId: thread, draftId: first.id, decision: 'approve' },
        execute,
      ),
    ),
  );
  expect(results).toEqual(
    Array.from({ length: 4 }, () => ({ status: 'executed', result: { receipt: 'recorded' } })),
  );
  const count = await sql<{
    count: string;
  }>`SELECT count(*)::text AS count FROM durable_operations WHERE kind='agent_test' AND reference=${first.id}`.execute(
    db.db,
  );
  expect(count.rows[0]?.count).toBe('1');
});

test('reject, expiry, ownership and a changed payload prevent execution', async () => {
  const make = (toolCallId: string, expiresAt: Date) =>
    drafts.prepare({
      userId: customer,
      threadId: thread,
      toolCallId,
      type: 'cancel',
      payload: { value: 'original' },
      expiresAt,
    });
  const future = () => new Date(Date.now() + 60000);
  const rejected = await make('reject', future());
  const never = jest.fn(async () => ({ unexpected: true }));
  await expect(
    drafts.decide(
      { userId: customer, threadId: thread, draftId: rejected.id, decision: 'reject' },
      never,
    ),
  ).resolves.toEqual({ status: 'rejected', result: null });
  const expired = await make('expired', new Date(Date.now() - 1000));
  await expect(
    drafts.decide(
      { userId: customer, threadId: thread, draftId: expired.id, decision: 'approve' },
      never,
    ),
  ).resolves.toEqual({ status: 'expired', result: null });
  const changed = await make('changed', future());
  await expect(
    drafts.decide(
      { userId: stranger, threadId: thread, draftId: changed.id, decision: 'approve' },
      never,
    ),
  ).rejects.toThrow('RESOURCE_NOT_FOUND');
  await sql`UPDATE agent_drafts SET payload='{"value":"changed"}'::jsonb WHERE id=${changed.id}::uuid`.execute(
    db.db,
  );
  await expect(
    drafts.decide(
      { userId: customer, threadId: thread, draftId: changed.id, decision: 'approve' },
      never,
    ),
  ).rejects.toThrow('DRAFT_INVALID');
  expect(never).not.toHaveBeenCalled();
});

test('revoked consent and the remote kill switch prevent execution', async () => {
  const draft = await drafts.prepare({
    userId: customer,
    threadId: thread,
    toolCallId: 'permission',
    type: 'cancel',
    payload: {},
    expiresAt: new Date(Date.now() + 60000),
  });
  const execute = jest.fn(async () => ({ ok: true }));
  await sql`UPDATE consents SET revoked_at=clock_timestamp() WHERE user_id=${customer}::uuid AND type='ai_assistant'`.execute(
    db.db,
  );
  await expect(
    drafts.prepare({
      userId: customer,
      threadId: thread,
      toolCallId: 'revoked',
      type: 'cancel',
      payload: {},
      expiresAt: new Date(Date.now() + 60000),
    }),
  ).rejects.toThrow('CONSENT_REQUIRED');
  await expect(
    drafts.decide(
      { userId: customer, threadId: thread, draftId: draft.id, decision: 'approve' },
      execute,
    ),
  ).rejects.toThrow('CONSENT_REQUIRED');
  await sql`UPDATE consents SET revoked_at=NULL WHERE user_id=${customer}::uuid AND type='ai_assistant'`.execute(
    db.db,
  );
  await sql`UPDATE feature_flags SET enabled=false WHERE key='agent_enabled'`.execute(db.db);
  await expect(
    drafts.decide(
      { userId: customer, threadId: thread, draftId: draft.id, decision: 'approve' },
      execute,
    ),
  ).rejects.toThrow('AGENT_NOT_CONFIGURED');
  expect(execute).not.toHaveBeenCalled();
});

test('a refund completion is stored once and consent is required before it', async () => {
  await sql`UPDATE feature_flags SET enabled=true WHERE key='agent_enabled'`.execute(db.db);
  await sql`UPDATE consents SET revoked_at=NULL WHERE user_id=${customer}::uuid AND type='ai_assistant'`.execute(
    db.db,
  );
  const draft = await drafts.prepare({
    userId: customer,
    threadId: thread,
    toolCallId: 'refund-replay',
    type: 'refund_request',
    payload: { orderId: uuidV7(), reason: 'Damaged packet' },
    expiresAt: new Date(Date.now() + 60000),
  });
  await drafts.stageDecision({
    userId: customer,
    threadId: thread,
    draftId: draft.id,
    decision: 'approve',
  });
  await sql`UPDATE consents SET revoked_at=clock_timestamp() WHERE user_id=${customer}::uuid AND type='ai_assistant'`.execute(
    db.db,
  );
  const result = { ticketId: uuidV7(), ticketStatus: 'OPEN', request: true };
  await expect(
    drafts.markExecuted({ userId: customer, threadId: thread, draftId: draft.id, result }),
  ).rejects.toThrow('CONSENT_REQUIRED');
  await sql`UPDATE consents SET revoked_at=NULL WHERE user_id=${customer}::uuid AND type='ai_assistant'`.execute(
    db.db,
  );
  await expect(
    drafts.markExecuted({ userId: customer, threadId: thread, draftId: draft.id, result }),
  ).resolves.toEqual(result);
  await expect(
    drafts.markExecuted({
      userId: customer,
      threadId: thread,
      draftId: draft.id,
      result: { ticketId: uuidV7(), ticketStatus: 'OPEN', request: true },
    }),
  ).resolves.toEqual(result);
  const stored = await sql<{
    status: string;
    count: string;
  }>`SELECT status,(SELECT count(*)::text FROM agent_drafts WHERE id=${draft.id}::uuid AND result->>'ticketId'=${result.ticketId}) AS count FROM agent_drafts WHERE id=${draft.id}::uuid`.execute(
    db.db,
  );
  expect(stored.rows[0]).toEqual({ status: 'executed', count: '1' });
});

test('a quote applies ₹50 from the wallet and leaves ₹50 due on delivery', async () => {
  const columns = await sql<{
    name: string;
  }>`SELECT column_name AS name FROM information_schema.columns WHERE table_name='agent_runs' AND column_name IN ('model_ms','tool_ms','db_ms')`.execute(
    db.db,
  );
  expect(columns.rows.map((row) => row.name).sort()).toEqual(['db_ms', 'model_ms', 'tool_ms']);
  const quote = computeQuote({
    lines: [
      {
        variantId: uuidV7(),
        quantity: 1n,
        unitPricePaise: 10000n,
        mrpPaise: 10000n,
        taxRateBps: 0,
        eligibleForDiscount: false,
      },
    ],
    coupon: null,
    tipPaise: 0n,
    fees: {
      deliveryFeeSlabs: [{ maxOrderValuePaise: null, feePaise: 0n }],
      freeDeliveryThresholdPaise: 0n,
      handlingFeePaise: 0n,
      smallCartThresholdPaise: 0n,
      smallCartFeePaise: 0n,
      surgeEnabled: false,
      surgeFeePaise: 0n,
      feeTaxRules: [],
    },
    wallet: { promoAvailablePaise: 0n, cashAvailablePaise: 5000n, promoSpendCapBps: 0 },
    minOrderPaise: 0n,
    maxOrderPaise: 1000000n,
  });
  expect(quote.wallet?.cashPaise).toBe(5000n);
  expect(quote.amountDuePaise).toBe(5000n);
  expect(quote.totalPaise).toBe(10000n);
});
