import { randomUUID } from 'node:crypto';
import { createIamRedisCluster } from '../src/platform/redis/iam-cluster.js';

/** Transient pub/sub only: no keys, user data, or persistent messages are created. */
async function main(): Promise<void> {
  const config = {
    url: process.env.CACHE_URL ?? '',
    cacheName: process.env.CACHE_IAM_NAME ?? '',
    username: process.env.CACHE_IAM_USER ?? '',
    region: process.env.AWS_REGION ?? '',
  };
  const publisher = createIamRedisCluster(config);
  const subscriber = publisher.duplicate();
  publisher.on('error', () => undefined);
  subscriber.on('error', () => undefined);
  const channel = `delivery:smoke:${randomUUID()}#/#`;
  try {
    await Promise.all([publisher.connect(), subscriber.connect()]);
    let resolveMessage!: (message: Buffer) => void;
    const message = new Promise<Buffer>((resolve) => {
      resolveMessage = resolve;
    });
    await subscriber.sSubscribe(channel, resolveMessage, true);
    const count = await publisher.sPublish(channel, 'ok');
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('SHARDED_PUBSUB_TIMEOUT')), 5000);
      timer.unref();
    });
    if ((await Promise.race([message, timeout])).toString() !== 'ok')
      throw new Error('SHARDED_PUBSUB_INVALID');
    await subscriber.sUnsubscribe(channel);
    process.stdout.write(
      `IAM-authenticated Valkey sharded pub/sub smoke passed (publisher reported ${count} subscribers).\n`,
    );
  } finally {
    publisher.destroy();
    subscriber.destroy();
  }
}
void main().catch(() => {
  process.stderr.write('IAM-authenticated Valkey sharded pub/sub smoke failed.\n');
  process.exitCode = 1;
});
