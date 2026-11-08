import { sql } from 'kysely';
import { createDatabase } from '../../src/platform/database/database.js';
import { appendEvent } from '../../src/platform/outbox/outbox.js';

const handle = createDatabase(process.env.TEST_CHILD_DATABASE_URL!);
const aggregateId = process.env.TEST_CHILD_AGGREGATE_ID!;
const eventId = process.env.TEST_CHILD_EVENT_ID!;
await handle.db.transaction().execute(async (tx) => {
  await sql`INSERT INTO test_aggregates(id,version) VALUES (${aggregateId}::uuid,1)`.execute(tx);
  await appendEvent(
    tx,
    {
      eventId,
      eventType: 'test.child',
      schemaVersion: 1,
      aggregateType: 'test',
      aggregateId,
      aggregateVersion: '1',
      occurredAt: new Date().toISOString(),
      correlationId: 'test',
      causationId: null,
      payload: {},
    },
    ['test-consumer'],
  );
});
process.send?.('committed');
setInterval(() => undefined, 1000);
