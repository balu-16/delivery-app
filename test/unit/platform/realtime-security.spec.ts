import { createServer } from 'node:http';
import { io } from 'socket.io-client';
import { createRealtimeGateway } from '../../../src/platform/realtime/realtime.js';

it('disconnects at token expiry and re-authenticates on reconnect', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const gateway = createRealtimeGateway({ httpServer: server, drainMs: 0 });
  if (!gateway) throw new Error('missing gateway');
  let valid = true;
  const exp = Math.floor(Date.now() / 1000) + 2;
  const token = `header.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
  gateway.register({
    name: '/customer',
    authenticate: async (value) =>
      valid && value === token ? { userId: 'owner', pool: 'CUSTOMER', roles: ['CUSTOMER'] } : null,
    authorizeRoom: async () => false,
    snapshot: async () => ({ ok: true }),
  });
  const url = `http://127.0.0.1:${address.port}/customer`;
  const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    await new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
    expect(socket.connected).toBe(false);
    valid = false;
    socket.connect();
    await expect(
      new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
      }),
    ).rejects.toThrow('UNAUTHORIZED');
  } finally {
    socket.disconnect();
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('removes a room after role revocation and disconnects a blocked identity', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const gateway = createRealtimeGateway({ httpServer: server, drainMs: 0 });
  if (!gateway) throw new Error('missing gateway');
  let role = true;
  let active = true;
  const namespace = gateway.register({
    name: '/rider',
    authenticate: async () =>
      active ? { userId: 'owner', pool: 'WORKFORCE', roles: role ? ['RIDER'] : [] } : null,
    authorizeRoom: async (identity, room) =>
      room === 'order:owned' && identity.roles.includes('RIDER'),
    snapshot: async () => ({}),
  });
  const socket = io(`http://127.0.0.1:${address.port}/rider`, {
    auth: { token: 'fixture' },
    transports: ['websocket'],
    reconnection: false,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    socket.emit('subscribe', { room: 'order:owned' });
    for (let i = 0; i < 100 && namespace.socketsIn('order:owned') === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(namespace.socketsIn('order:owned')).toBe(1);
    role = false;
    const denied = new Promise<unknown>((resolve) => socket.once('rejected', resolve));
    socket.emit('subscribe', { room: 'order:owned' });
    expect(await denied).toEqual({ code: 'ROOM_UNAUTHORIZED' });
    expect(namespace.socketsIn('order:owned')).toBe(0);
    active = false;
    const disconnected = new Promise<void>((resolve) => socket.once('disconnect', () => resolve()));
    socket.emit('subscribe', { room: 'order:owned' });
    await disconnected;
    expect(socket.connected).toBe(false);
  } finally {
    socket.disconnect();
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
