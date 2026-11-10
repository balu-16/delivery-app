import { sql } from 'kysely';
import { createDatabase } from '../../src/platform/database/database.js';
import { DurableQueue } from '../../src/platform/queue/queue.js';

const handle = createDatabase(process.env.TEST_CHILD_DATABASE_URL!);
const eventId = process.env.TEST_CHILD_EVENT_ID!;
const aggregateId = process.env.TEST_CHILD_AGGREGATE_ID!;
const worker = new DurableQueue({
  db: handle.db,
  redisUrl: process.env.TEST_CHILD_REDIS_URL!,
  prefix: process.env.TEST_CHILD_PREFIX!,
  handlers: {
    'test-consumer': async (tx) => {
      await sql`UPDATE test_aggregates SET effects=effects+1 WHERE id=${aggregateId}::uuid`.execute(
        tx,
      );
      if (process.env.TEST_CHILD_BLOCK === '1') {
        process.send?.('in-handler');
        await new Promise<void>(() => undefined);
      }
    },
  },
});
await worker.ping();
process.send?.('ready');
const timer = setInterval(() => {
  void sql<{
    completed: boolean;
  }>`SELECT completed_at IS NOT NULL AS completed FROM outbox_deliveries WHERE event_id=${eventId}::uuid AND consumer='test-consumer'`
    .execute(handle.db)
    .then((result) => {
      if (result.rows[0]?.completed) {
        clearInterval(timer);
        process.send?.('committed');
      }
    });
}, 20);
