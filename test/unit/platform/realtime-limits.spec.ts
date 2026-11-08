import { createServer } from 'node:http';
import { io, type Socket } from 'socket.io-client';
import { createRealtimeGateway } from '../../../src/platform/realtime/realtime.js';

it('limits active connections per user and namespace and releases slots on disconnect', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const gateway = createRealtimeGateway({
    httpServer: server,
    drainMs: 0,
    maxConnectionsPerUser: 2,
    maxConnectionsPerNamespace: 3,
  });
  if (!gateway) throw new Error('missing gateway');
  gateway.register({
    name: '/customer',
    authenticate: async (token) =>
      token ? { userId: token, pool: 'CUSTOMER', roles: ['CUSTOMER'] } : null,
    authorizeRoom: async () => false,
    snapshot: async () => ({}),
  });
  const sockets: Socket[] = [];
  const connect = (token: string) => {
    const socket = io(`http://127.0.0.1:${address.port}/customer`, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    sockets.push(socket);
    return {
      socket,
      result: new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      }),
    };
  };
  try {
    const first = connect('one');
    const second = connect('one');
    await Promise.all([first.result, second.result]);
    await expect(connect('one').result).rejects.toThrow('CONNECTION_LIMIT_REACHED');
    const third = connect('two');
    await third.result;
    await expect(connect('three').result).rejects.toThrow('CONNECTION_LIMIT_REACHED');
    const serverDisconnect = new Promise<void>((resolve) => {
      const serverSocket = [...gateway.io.of('/customer').sockets.values()].find(
        (s) => s.id === first.socket.id,
      )!;
      serverSocket.once('disconnect', () => resolve());
    });
    first.socket.disconnect();
    await serverDisconnect;
    await connect('one').result;
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
