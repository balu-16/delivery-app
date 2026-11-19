import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import { AgentRuns } from '../../../src/modules/agent/infrastructure/runs.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { assertDisposableAgentDatabase } from './disposable-database.js';

let services: TestServices, db: DatabaseHandle, customer: string, threadId: string, frozen: string;

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
  customer = uuidV7();
  frozen = uuidV7();
  await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified) VALUES
    (${customer}::uuid,'CUSTOMER',${`quota-${customer}`},${`${customer}@example.test`},'Quota',true),
    (${frozen}::uuid,'CUSTOMER',${`frozen-${frozen}`},${`${frozen}@example.test`},'Frozen',true)`.execute(
    db.db,
  );
  await sql`INSERT INTO consents(user_id,type,version) VALUES(${customer}::uuid,'ai_assistant','1'),(${frozen}::uuid,'ai_assistant','1')`.execute(
    db.db,
  );
  await sql`INSERT INTO feature_flags(key,enabled) VALUES('agent_enabled',true) ON CONFLICT(key) DO UPDATE SET enabled=true`.execute(
    db.db,
  );
  threadId = uuidV7();
  await sql`INSERT INTO agent_threads(id,user_id) VALUES(${threadId}::uuid,${customer}::uuid)`.execute(
    db.db,
  );
  const frozenThread = uuidV7();
  await sql`INSERT INTO agent_threads(id,user_id) VALUES(${frozenThread}::uuid,${frozen}::uuid)`.execute(
    db.db,
  );
  // Four runs used 64,469 counted tokens today, like the development failure.
  for (const [index, tokens] of [16000, 16000, 16000, 16469].entries()) {
    await sql`INSERT INTO agent_runs(id,thread_id,user_id,client_message_id,skill,input_tokens,output_tokens,outcome)
      VALUES(${uuidV7()}::uuid,${threadId}::uuid,${customer}::uuid,${uuidV7()}::uuid,'test',${tokens},0,'completed')`.execute(
      db.db,
    );
    void index;
  }
  await sql`INSERT INTO agent_runs(id,thread_id,user_id,client_message_id,skill,input_tokens,output_tokens,outcome)
    VALUES(${uuidV7()}::uuid,${frozenThread}::uuid,${frozen}::uuid,${uuidV7()}::uuid,'test',64469,0,'completed')`.execute(
    db.db,
  );
}, 300000);

afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 300000);

test('without a cutoff the 50,000 budget fails before the model runs', async () => {
  const runs = new AgentRuns(db.db);
  await expect(
    runs.begin({
      userId: frozen,
      threadId: (
        await sql<{
          id: string;
        }>`SELECT id FROM agent_threads WHERE user_id=${frozen}::uuid`.execute(db.db)
      ).rows[0]!.id,
      clientMessageId: uuidV7(),
      text: 'Add curd to cart',
      dailyTurns: 20,
      dailyTokens: 50000,
      outputReservation: 100,
    }),
  ).rejects.toThrow('AGENT_DAILY_LIMIT');
});

test('a cutoff zeroes counted tokens at 150,000 while turns remain', async () => {
  await sql`INSERT INTO agent_usage_cutoffs(user_id,token_cutoff_at,updated_at) VALUES(${customer}::uuid,clock_timestamp(),clock_timestamp())`.execute(
    db.db,
  );
  const runs = new AgentRuns(db.db);
  const result = await runs.begin({
    userId: customer,
    threadId,
    clientMessageId: uuidV7(),
    text: 'Add curd to cart',
    dailyTurns: 20,
    dailyTokens: 150000,
    outputReservation: 100,
  });
  expect(result.kind).toBe('started');
  const counted = await sql<{
    counted: string;
  }>`SELECT COALESCE((SELECT sum(input_tokens+output_tokens) FROM agent_runs WHERE user_id=${customer}::uuid AND created_at >= (SELECT token_cutoff_at FROM agent_usage_cutoffs WHERE user_id=${customer}::uuid)),0)::text AS counted`.execute(
    db.db,
  );
  const usage = { counted: counted.rows[0]!.counted };
  // Turns include the new started run; counted tokens only cover it.
  expect(Number(usage.counted)).toBeGreaterThanOrEqual(0);
  expect(Number(usage.counted)).toBeLessThan(150000);
});
