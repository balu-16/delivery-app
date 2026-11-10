import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { SQSClient } from '@aws-sdk/client-sqs';
import { sql } from 'kysely';
import { runner } from 'node-pg-migrate';
import { createDatabase } from '../src/platform/database/database.js';
import { appendEvent } from '../src/platform/outbox/outbox.js';
import { SqsEventQueue } from '../src/platform/queue/sqs-event-queue.js';
import { SQS_LANES, SqsTransport, type SqsQueueUrls } from '../src/platform/queue/sqs-transport.js';
import { createAwsTestQueues } from '../test/helpers/aws-test-queues.js';
import { startTestServices } from '../test/helpers/services.js';

async function main() {
  const region = process.env.AWS_REGION;
  const account = process.env.AWS_ACCOUNT_ID;
  if (process.env.AWS_P13_INTEGRATION !== 'yes' || !region || !account)
    throw new Error('AWS integration opt-in and account configuration are required');
  let services: Awaited<ReturnType<typeof startTestServices>> | undefined;
  let queues: Awaited<ReturnType<typeof createAwsTestQueues>> | undefined;
  let db: ReturnType<typeof createDatabase> | undefined;
  let client: SQSClient | undefined;
  try {
    services = await startTestServices({ skipAwsCache: true });
    if (!services.databaseIamUrl) throw new Error('IAM test database is required');
    await runner({
      databaseUrl: services.databaseUrl,
      dir: resolve('db/migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => undefined,
    });
    queues = await createAwsTestQueues();
    client = new SQSClient({ region });
    const urls = Object.fromEntries(
      SQS_LANES.map((lane) => [
        lane,
        `https://sqs.${region}.amazonaws.com/${account}/${queues!.prefix}-${lane}`,
      ]),
    ) as SqsQueueUrls;
    const transport = new SqsTransport(client, urls, region, account, queues.prefix);
    db = createDatabase(services.databaseIamUrl, 10, 30000, undefined, 30000, region);
    const consumer = `p13-relay-${randomUUID()}`;
    const queue = new SqsEventQueue({ db: db.db, transport, consume: false });
    let effects = 0;
    queue.registerHandler(consumer, async () => {
      effects++;
    });
    const ids = Array.from({ length: 3 }, () => randomUUID());
    for (const id of ids)
      await db.db.transaction().execute((tx) =>
        appendEvent(
          tx,
          {
            eventId: id,
            eventType: 'p13.relay.test',
            schemaVersion: 1,
            aggregateType: 'p13',
            aggregateId: randomUUID(),
            aggregateVersion: '1',
            occurredAt: new Date().toISOString(),
            correlationId: consumer,
            causationId: null,
            payload: {},
          },
          [consumer],
        ),
      );
    assert.equal(await queue.recoverOnce(), 3);
    const received = new Set<string>();
    const deadline = Date.now() + 90000;
    while (received.size < ids.length && Date.now() < deadline) {
      const batch = await transport.receive('platform-events', AbortSignal.timeout(25000));
      assert.equal(batch.malformedCount, 0);
      for (const message of batch.messages) {
        await queue.processPointer(message.pointer);
        await queue.processPointer(message.pointer);
        await transport.delete('platform-events', message.receiptHandle);
        received.add(message.pointer.jobId.slice(0, 36));
      }
    }
    assert.equal(received.size, ids.length);
    assert.equal(effects, ids.length);
    const rows = await sql<{ complete: string; processed: string }>`SELECT
      count(*) FILTER (WHERE d.completed_at IS NOT NULL)::text AS complete,
      count(p.event_id)::text AS processed
      FROM outbox_deliveries d LEFT JOIN processed_events p
      ON p.event_id=d.event_id AND p.consumer=d.consumer WHERE d.consumer=${consumer}`.execute(
      db.db,
    );
    assert.deepEqual(rows.rows[0], { complete: '3', processed: '3' });
    const event = {
      eventId: randomUUID(),
      eventType: 'p13.atomic.test',
      schemaVersion: 1,
      aggregateType: 'p13',
      aggregateId: randomUUID(),
      aggregateVersion: '1',
      occurredAt: new Date().toISOString(),
      correlationId: consumer,
      causationId: null,
      payload: {},
    };
    await db.db.transaction().execute((tx) => appendEvent(tx, event, ['alpha', 'beta']));
    const obligations = await sql<{ consumer: string }>`SELECT consumer FROM outbox_deliveries
      WHERE event_id=${event.eventId}::uuid ORDER BY consumer`.execute(db.db);
    assert.deepEqual(
      obligations.rows.map((row) => row.consumer),
      ['alpha', 'beta'],
    );
    const emptyEvent = { ...event, eventId: randomUUID(), aggregateId: randomUUID() };
    await db.db.transaction().execute((tx) => appendEvent(tx, emptyEvent, []));
    const empty = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM outbox_events WHERE id=${emptyEvent.eventId}::uuid`.execute(
      db.db,
    );
    assert.equal(empty.rows[0]?.count, '1');
    const rollbackEvent = { ...event, eventId: randomUUID(), aggregateId: randomUUID() };
    await assert.rejects(
      db.db.transaction().execute(async (tx) => {
        await appendEvent(tx, rollbackEvent, ['alpha']);
        throw new Error('INTENTIONAL_ROLLBACK');
      }),
      /INTENTIONAL_ROLLBACK/,
    );
    const rolledBack = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM outbox_events WHERE id=${rollbackEvent.eventId}::uuid`.execute(
      db.db,
    );
    assert.equal(rolledBack.rows[0]?.count, '0');
    await assert.rejects(
      db.db
        .transaction()
        .execute((tx) => appendEvent(tx, { ...event, eventId: randomUUID() }, ['alpha', 'alpha'])),
      /INVALID_EVENT_CONSUMERS/,
    );
    console.log('AWS outbox multi-consumer, empty-consumer and transaction rollback checks passed');
    console.log('AWS SQS relay publication, acknowledgement and duplicate-safe consumption passed');
  } finally {
    const cleanup = await Promise.allSettled([db?.close(), queues?.close()]);
    client?.destroy();
    if (services) {
      const result = await Promise.allSettled([services.stop()]);
      cleanup.push(...result);
    }
    if (cleanup.some((result) => result.status === 'rejected')) {
      console.error('AWS relay test cleanup failed; inspect test cleanup manifests');
      process.exitCode = 1;
    }
  }
}
void main().catch((error: unknown) => {
  console.error('AWS relay test failed:', error instanceof Error ? error.message : 'unknown error');
  process.exitCode = 1;
});
