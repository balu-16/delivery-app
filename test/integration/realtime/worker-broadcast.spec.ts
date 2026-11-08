import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import { io as client } from 'socket.io-client';
import { createRealtimeGateway } from '../../../src/platform/realtime/realtime.js';
import {
  BroadcastsFactory,
  GatewayRealtimeBroadcasts,
  NamespaceRegistry,
} from '../../../src/modules/tracking/infrastructure/realtime-broadcasts.js';
import { startTestServices } from '../../helpers/services.js';

test('worker publication reaches each audience instance once through Redis', async () => {
  const services = await startTestServices();
  const redis = new Redis(services.redisUrl);
  const servers = [createServer(), createServer()];
  const gateways: NonNullable<ReturnType<typeof createRealtimeGateway>>[] = [];
  const factories: BroadcastsFactory[] = [];
  const sockets: ReturnType<typeof client>[] = [];
  try {
    for (const server of servers) {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const gateway = createRealtimeGateway({
        httpServer: server,
        redisUrl: services.redisUrl,
        drainMs: 0,
      })!;
      gateways.push(gateway);
      const registry = new NamespaceRegistry();
      registry.register(
        gateway.register({
          name: '/rider',
          authenticate: async () => ({ userId: 'rider-1', pool: 'WORKFORCE', roles: ['RIDER'] }),
          authorizeRoom: async () => false,
          snapshot: async () => ({}),
        }),
      );
      const factory = new BroadcastsFactory(registry, redis, gateway);
      factories.push(factory);
      factory.onApplicationBootstrap();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing address');
      const socket = client(`http://127.0.0.1:${address.port}/rider`, {
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('snapshot', () => resolve());
        socket.once('connect_error', reject);
      });
    }
    // Wait for both audience subscribers before publishing from the worker.
    let subscribers = 0;
    for (let i = 0; i < 100 && subscribers < 2; i++) {
      const result = (await redis.pubsub('NUMSUB', 'delivery:realtime:events')) as [string, number];
      subscribers = Number(result[1]);
      if (subscribers < 2) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(subscribers).toBe(2);
    const received = sockets.map(
      (socket) => new Promise<unknown>((resolve) => socket.once('task.updated', resolve)),
    );
    const counts = [0, 0];
    sockets.forEach((socket, i) =>
      socket.on('task.updated', () => (counts[i] = (counts[i] ?? 0) + 1)),
    );
    new GatewayRealtimeBroadcasts(redis).emitRiderEvent('rider-1', 'task.updated', {
      taskId: 'task-1',
    });
    expect(await Promise.all(received)).toEqual([{ taskId: 'task-1' }, { taskId: 'task-1' }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(counts).toEqual([1, 1]);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await Promise.all(factories.map((factory) => factory.beforeApplicationShutdown()));
    await Promise.all(gateways.map((gateway) => gateway.close()));
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    await redis.quit();
    await services.stop();
  }
}, 30000);
