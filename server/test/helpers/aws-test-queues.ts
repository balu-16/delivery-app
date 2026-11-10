import { randomUUID } from 'node:crypto';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import { SQS_LANES } from '../../src/platform/queue/sqs-transport.js';
import type { Redis } from 'ioredis';

/** Track only test-created rate keys so cleanup leaves pre-existing counters intact. */
export function trackAwsTestRateKeys(redis: Redis): () => Promise<void> {
  const keys = new Set<string>();
  const evalCommand = redis.eval.bind(redis);
  Object.defineProperty(redis, 'eval', {
    configurable: true,
    value: async (...args: Parameters<Redis['eval']>) => {
      const key = String(args[2]);
      if (key.startsWith('delivery:rate:') && !(await redis.exists(key))) keys.add(key);
      return (evalCommand as (...values: unknown[]) => Promise<unknown>)(...args);
    },
  });
  return async () => {
    for (const key of keys) await redis.del(key);
  };
}

/** Give an AWS integration application dedicated queues instead of sharing user jobs. */
export async function createAwsTestQueues() {
  const region = process.env.AWS_REGION;
  const account = process.env.AWS_ACCOUNT_ID;
  if (
    process.env.AWS_P13_INTEGRATION !== 'yes' ||
    !region ||
    !account ||
    !/^[0-9]{12}$/.test(account)
  )
    throw new Error('AWS integration queue configuration is missing');
  const prefix = `p13-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const manifest = `artifacts/${prefix}-queues.json`;
  const client = new SQSClient({ region });
  const urls: string[] = [];
  const persist = async () => {
    await mkdir('artifacts', { recursive: true });
    await writeFile(manifest, JSON.stringify({ prefix, region, account, urls }, null, 2), {
      mode: 0o600,
    });
    await chmod(manifest, 0o600);
  };
  const close = async () => {
    let failed = 0;
    for (const QueueUrl of [...urls].reverse()) {
      try {
        await client.send(new DeleteQueueCommand({ QueueUrl }));
      } catch {
        failed++;
      }
    }
    client.destroy();
    if (failed) throw new Error(`${failed} temporary test queues need cleanup; see ${manifest}`);
    if (urls.length) await unlink(manifest);
  };
  try {
    for (const lane of SQS_LANES) {
      const result = await client.send(
        new CreateQueueCommand({
          QueueName: `${prefix}-${lane}`,
          Attributes: { MessageRetentionPeriod: '86400' },
        }),
      );
      if (!result.QueueUrl) throw new Error(`Missing test queue URL for ${lane}`);
      urls.push(result.QueueUrl);
      await persist();
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { prefix, close };
}
