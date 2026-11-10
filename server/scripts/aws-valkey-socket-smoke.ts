import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createShardedAdapter } from '@socket.io/redis-adapter';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';
import { createIamRedisCluster } from '../src/platform/redis/iam-cluster.js';

/** Two isolated local Socket.IO servers communicate through temporary Valkey channels. */
async function main(): Promise<void> {
  const config = {
    url: process.env.CACHE_URL ?? '',
    cacheName: process.env.CACHE_IAM_NAME ?? '',
    username: process.env.CACHE_IAM_USER ?? '',
    region: process.env.AWS_REGION ?? '',
  };
  const clients = Array.from({ length: 4 }, () => createIamRedisCluster(config));
  const http = [createServer(), createServer()];
  const servers = http.map((server) => new Server(server));
  const channelPrefix = `delivery:socket-smoke:${randomUUID()}`;
  let socket: ReturnType<typeof connect> | undefined;
  try {
    clients.forEach((client) => client.on('error', () => undefined));
    await Promise.all(clients.map((client) => client.connect()));
    const subscriptions: Promise<void>[] = [];
    for (const subscriber of [clients[1]!, clients[3]!]) {
      const subscribe = subscriber.sSubscribe.bind(subscriber);
      subscriber.sSubscribe = ((...args: Parameters<typeof subscribe>) => {
        const pending = subscribe(...args);
        subscriptions.push(pending);
        return pending;
      }) as typeof subscriber.sSubscribe;
    }
    servers[0]!.adapter(
      createShardedAdapter(clients[0], clients[1], { channelPrefix, subscriptionMode: 'static' }),
    );
    servers[1]!.adapter(
      createShardedAdapter(clients[2], clients[3], { channelPrefix, subscriptionMode: 'static' }),
    );
    // The adapter starts subscriptions asynchronously, so wait for their completion.
    if (subscriptions.length !== 4) throw new Error('SOCKET_SMOKE_SUBSCRIPTIONS_MISSING');
    await Promise.all(subscriptions);
    servers[1]!.on('connection', (peer) => {
      void Promise.resolve(peer.join('smoke')).then(() => peer.emit('ready'));
    });
    await Promise.all(
      http.map((server) => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))),
    );
    const address = http[1]!.address();
    if (!address || typeof address === 'string') throw new Error('SOCKET_SMOKE_ADDRESS');
    socket = connect(`http://127.0.0.1:${address.port}`, {
      transports: ['websocket'],
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      socket!.once('ready', resolve);
      socket!.once('connect_error', reject);
    });
    const received = new Promise<string>((resolve) => socket!.once('smoke', resolve));
    servers[0]!.to('smoke').emit('smoke', 'ok');
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('SOCKET_SMOKE_TIMEOUT')), 5000);
      timer.unref();
    });
    if ((await Promise.race([received, timeout])) !== 'ok') throw new Error('SOCKET_SMOKE_INVALID');
    process.stdout.write('IAM-authenticated Valkey Socket.IO sharded fan-out smoke passed.\n');
  } finally {
    socket?.disconnect();
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await Promise.allSettled(clients.map((client) => client.close()));
  }
}
void main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^SOCKET_SMOKE_[A-Z_]+$/.test(error.message)
      ? ` (${error.message})`
      : '';
  process.stderr.write(`IAM-authenticated Valkey Socket.IO sharded fan-out smoke failed${code}.\n`);
  process.exitCode = 1;
});
