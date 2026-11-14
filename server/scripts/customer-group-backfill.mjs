import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { sql } from 'kysely';
import { createApplication } from '../dist/bootstrap.js';
import { readEnv } from '../dist/config/env.schema.js';
import { PLATFORM_DATABASE } from '../dist/platform/contracts/runtime.js';

// Only run after provisioning the isolated queue and granting this runtime permission to send to it.
if (!process.argv.includes('--execute')) {
  process.stderr.write(
    'This queues verified, active database-backed customers. Re-run with --execute after reviewing the deployment guide.\n',
  );
  process.exit(1);
}
const env = readEnv({ ...process.env, APP_ROLE: 'customer', LOG_LEVEL: 'error' });
if (env.AUTH_PROVIDER !== 'cognito' || !env.CUSTOMER_GROUP_SYNC_QUEUE_URL)
  throw new Error('CUSTOMER_GROUP_SYNC_NOT_CONFIGURED');
const app = await createApplication(env);
const client = new SQSClient({ region: env.AWS_REGION, maxAttempts: 2 });
const db = app.get(PLATFORM_DATABASE).db;
let after = '00000000-0000-0000-0000-000000000000';
let count = 0;
try {
  for (;;) {
    const page = await sql`SELECT u.id, u.cognito_sub
      FROM users u
      JOIN customer_profiles p ON p.user_id=u.id
      JOIN user_roles r ON r.user_id=u.id AND r.role='CUSTOMER'
      WHERE u.pool='CUSTOMER' AND u.status='ACTIVE' AND u.email_verified=true AND u.id > ${after}::uuid
      ORDER BY u.id LIMIT 100`.execute(db);
    if (!page.rows.length) break;
    for (const row of page.rows) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: env.CUSTOMER_GROUP_SYNC_QUEUE_URL,
          MessageBody: JSON.stringify({
            version: 1,
            userPoolId: env.COGNITO_CUSTOMER_POOL_ID,
            subject: row.cognito_sub,
          }),
        }),
      );
      count++;
      after = row.id;
    }
  }
  process.stdout.write(
    `Queued ${count} verified, active customer profile(s). Replaying is safe.\n`,
  );
} catch {
  process.stderr.write(
    `Customer group backfill stopped after ${count} submissions. Fix access or connectivity and rerun.\n`,
  );
  process.exitCode = 1;
} finally {
  client.destroy();
  await app.close();
}
