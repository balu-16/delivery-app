import { jest } from '@jest/globals';
import { sql } from 'kysely';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { FakePush } from '../../../src/adapters/push/fake-push.js';
import type { EmailPort } from '../../../src/modules/notifications/contracts/notifications.js';
import { PostgresNotificationPipeline } from '../../../src/modules/notifications/infrastructure/postgres-pipeline.js';
import { closeP5World, createP5World, type P5World } from '../../helpers/p5-world.js';

let world: P5World;
const timeout = process.env.AWS_P13_INTEGRATION === 'yes' ? 300000 : 120000;
if (process.env.AWS_P13_INTEGRATION === 'yes') jest.setTimeout(timeout);
beforeAll(async () => {
  world = await createP5World();
}, timeout);
afterAll(async () => {
  if (world) await closeP5World(world);
}, timeout);

it('records an ambiguous provider timeout and retries the same logical delivery', async () => {
  const notification = uuidV7();
  const delivery = uuidV7();
  await sql`INSERT INTO notifications(id,user_id,channel,template_key,locale,category,class,payload,dedupe_key)
    VALUES(${notification}::uuid,${world.customer}::uuid,'EMAIL','order.confirmed','en','ORDER_UPDATES','TRANSACTIONAL',${JSON.stringify({ data: { orderNumber: 'TEST-ORDER' } })}::jsonb,${notification})`.execute(
    world.db.db,
  );
  await sql`INSERT INTO notification_deliveries(id,notification_id,channel)
    VALUES(${delivery}::uuid,${notification}::uuid,'EMAIL')`.execute(world.db.db);
  let calls = 0;
  const messageIds: Array<string | undefined> = [];
  const email: EmailPort = {
    async send(message) {
      calls++;
      messageIds.push(message.messageId);
      if (calls === 1) throw new Error('PROVIDER_TIMEOUT_AFTER_ACCEPT');
      return { messageId: 'test-provider-id' };
    },
  };
  const pipeline = new PostgresNotificationPipeline(
    world.db.db,
    new FakePush(),
    email,
    undefined,
    world.config,
  );
  expect(await pipeline.deliverOnce(delivery)).toBe('RETRY');
  const failed = await sql<{
    status: string;
    attempts: number;
    ambiguous_sends: number;
    last_error: string;
  }>`
    SELECT status,attempts,ambiguous_sends,last_error FROM notification_deliveries WHERE id=${delivery}::uuid`.execute(
    world.db.db,
  );
  expect(failed.rows[0]).toEqual({
    status: 'PENDING',
    attempts: 1,
    ambiguous_sends: 1,
    last_error: 'PROVIDER_TIMEOUT_AFTER_ACCEPT',
  });
  await sql`UPDATE notification_deliveries SET next_retry_at=clock_timestamp()-interval '1 second' WHERE id=${delivery}::uuid`.execute(
    world.db.db,
  );
  expect(await pipeline.deliverOnce(delivery)).toBe('SENT');
  expect(messageIds).toEqual([notification, notification]);
  const result = await sql<{
    status: string;
    attempts: number;
    ambiguous_sends: number;
    provider_message_id: string;
  }>`
    SELECT status,attempts,ambiguous_sends,provider_message_id FROM notification_deliveries WHERE id=${delivery}::uuid`.execute(
    world.db.db,
  );
  expect(result.rows[0]).toEqual({
    status: 'SENT',
    attempts: 2,
    ambiguous_sends: 1,
    provider_message_id: 'test-provider-id',
  });
  expect(await pipeline.deliverOnce(delivery)).toBe('IDLE');
  expect(calls).toBe(2);
});
