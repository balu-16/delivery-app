import { createServer, type Server as HttpServer } from 'node:http';
import { io as client, type Socket as ClientSocket } from 'socket.io-client';
import {
  createRealtimeGateway,
  RealtimeGateway,
  type RealtimeNamespace,
} from '../../../src/platform/realtime/realtime.js';

let httpServer: HttpServer,
  url: string,
  gateway: RealtimeGateway | null,
  riderNamespace: RealtimeNamespace,
  customerNamespace: RealtimeNamespace;

beforeAll(async () => {
  httpServer = createServer();
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  gateway = createRealtimeGateway({ httpServer, drainMs: 10 });
  if (!gateway) throw new Error('gateway failed to start');
  riderNamespace = gateway.register({
    name: '/rider',
    authenticate: async (token) =>
      token === 'rider-token' ? { userId: 'rider-1', pool: 'WORKFORCE', roles: ['RIDER'] } : null,
    authorizeRoom: async (_identity, room) => room === 'order:owned',
    snapshot: async (identity) => ({ userId: identity.userId, tasks: [] }),
  });
  customerNamespace = gateway.register({
    name: '/customer',
    authenticate: async (token) =>
      token === 'customer-token'
        ? { userId: 'customer-1', pool: 'CUSTOMER', roles: ['CUSTOMER'] }
        : null,
    authorizeRoom: async (_identity, room) => room === 'order:owned',
    snapshot: async (identity) => ({ userId: identity.userId }),
  });
}, 20000);

afterAll(async () => {
  await gateway?.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}, 20000);

/** Client with pre-connect capture for the snapshot plus sequential capture for later events. */
function connect(
  namespace: string,
  token?: string,
): {
  socket: ClientSocket;
  snapshot: Promise<unknown>;
  next: (event: string) => Promise<unknown>;
  connected: Promise<void>;
} {
  const socket = client(`${url}${namespace}`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    timeout: 3000,
  });
  const snapshot = new Promise<unknown>((resolve) => socket.once('snapshot', resolve));
  const next = (event: string) => new Promise<unknown>((resolve) => socket.once(event, resolve));
  const connected = new Promise<void>((resolve, reject) => {
    socket.on('connect', () => resolve());
    socket.on('connect_error', (error: Error) => reject(error));
  });
  return { socket, snapshot, next, connected };
}

test('handshake authentication rejects missing or invalid tokens', async () => {
  await expect(connect('/rider').connected).rejects.toThrow('UNAUTHORIZED');
  await expect(connect('/rider', 'wrong-token').connected).rejects.toThrow('UNAUTHORIZED');
}, 20000);

test('connect sends the identity snapshot and auto-joins the user room', async () => {
  const { socket, snapshot, next } = connect('/rider', 'rider-token');
  expect(await snapshot).toEqual({ userId: 'rider-1', tasks: [] });
  socket.emit('subscribe', { room: 'order:owned' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(riderNamespace.socketsIn('order:owned')).toBe(1);
  const taskUpdated = next('task.updated');
  const broadcast = next('broadcast');
  riderNamespace.emitToRoom('order:owned', 'task.updated', { taskId: 't1' });
  riderNamespace.emitToRoom('user:rider-1', 'broadcast', { ok: true });
  expect(await taskUpdated).toEqual({ taskId: 't1' });
  expect(await broadcast).toEqual({ ok: true });
  socket.disconnect();
}, 20000);

test('room authorization re-checks every join and unauthorized rooms are rejected', async () => {
  const { socket, next } = connect('/customer', 'customer-token');
  socket.emit('subscribe', { room: 'order:other-person' });
  expect(await next('rejected')).toEqual({ code: 'ROOM_UNAUTHORIZED' });
  socket.emit('subscribe', { room: 'bad room!' });
  expect(await next('rejected')).toEqual({ code: 'INVALID_ROOM' });
  socket.emit('subscribe', { room: 'order:owned' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(customerNamespace.socketsIn('order:owned')).toBe(1);
  socket.disconnect();
}, 20000);

test('clients are receive-only: any client event is rejected', async () => {
  const { socket, next } = connect('/rider', 'rider-token');
  socket.emit('deliver', { orderId: 'x' });
  expect(await next('rejected')).toEqual({ code: 'REALTIME_RECEIVE_ONLY' });
  socket.disconnect();
}, 20000);

test('duplicate namespace registration is rejected and close drains', async () => {
  expect(() =>
    gateway!.register({
      name: '/rider',
      authenticate: async () => null,
      authorizeRoom: async () => false,
      snapshot: async () => ({}),
    }),
  ).toThrow('INVALID_OR_DUPLICATE_REALTIME_NAMESPACE');
  await gateway!.close();
  expect(() =>
    gateway!.register({
      name: '/other',
      authenticate: async () => null,
      authorizeRoom: async () => false,
      snapshot: async () => ({}),
    }),
  ).toThrow('REALTIME_CLOSED');
}, 20000);
