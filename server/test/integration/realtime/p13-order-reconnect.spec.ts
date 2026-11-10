import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { io, type Socket } from 'socket.io-client';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { NAMESPACE_REGISTRY } from '../../../src/modules/tracking/contracts/tokens.js';
import type { NamespaceRegistryPort } from '../../../src/modules/tracking/contracts/tracking.js';
import { createDatabase } from '../../../src/platform/database/database.js';
import {
  DELIVERY_TASK_CANCELLATION,
  type DeliveryTaskCancellation,
} from '../../../src/modules/dispatch/contracts/tasks.js';
import { emitConfirmedOrder, seedDispatchWorld } from '../../helpers/dispatch-fixture.js';
import { startTestServices } from '../../helpers/services.js';

it('restores an owner order snapshot across instances and removes terminal room access', async () => {
  const services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  const db = createDatabase(services.databaseUrl);
  const apps: Array<Awaited<ReturnType<typeof createApplication>>> = [];
  const sockets: Socket[] = [];
  try {
    const world = await seedDispatchWorld(db);
    const other = uuidV7();
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${world.customer}::uuid,'CUSTOMER')`.execute(
      db.db,
    );
    await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES(${other}::uuid,'CUSTOMER',${other},${`${other}@test.invalid`},'other')`.execute(
      db.db,
    );
    await sql`INSERT INTO user_roles(user_id,role) VALUES(${other}::uuid,'CUSTOMER')`.execute(
      db.db,
    );
    const order = await emitConfirmedOrder(db, world);
    const task = uuidV7();
    await sql`INSERT INTO delivery_tasks(id,order_id,store_id,customer_user_id,status,rider_id) VALUES(${task}::uuid,${order.orderId}::uuid,${world.store}::uuid,${world.customer}::uuid,'ASSIGNED',${world.rider1}::uuid)`.execute(
      db.db,
    );
    const env = readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'customer',
      LOG_LEVEL: 'silent',
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
      SHUTDOWN_TIMEOUT_MS: '1000',
    });
    const adapter = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, db.db);
    const owner = await adapter.issue('CUSTOMER', world.customer, 'customer', 'access');
    const foreign = await adapter.issue('CUSTOMER', other, 'customer', 'access');
    for (let i = 0; i < 2; i++) {
      const app = await createApplication(env);
      await app.listen(0, '127.0.0.1');
      apps.push(app);
    }
    const connect = (instance: number, token: string) => {
      const address = apps[instance]!.getHttpServer().address();
      if (!address || typeof address === 'string') throw new Error('missing address');
      const socket = io(`http://127.0.0.1:${address.port}/customer`, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      const snapshot = new Promise<{
        orders: Array<{ orderId: string; status: string; riderLocation: unknown }>;
      }>((resolveSnapshot, reject) => {
        socket.once('snapshot', resolveSnapshot);
        socket.once('connect_error', reject);
      });
      return { socket, snapshot };
    };
    const first = connect(0, owner);
    const initial = await first.snapshot;
    expect(initial.orders).toHaveLength(1);
    const foreignSocket = connect(1, foreign);
    expect((await foreignSocket.snapshot).orders).toEqual([]);
    const denied = new Promise<unknown>((resolveDenied) =>
      foreignSocket.socket.once('rejected', resolveDenied),
    );
    foreignSocket.socket.emit('subscribe', { room: `order:${order.orderId}` });
    expect(await denied).toEqual({ code: 'ROOM_UNAUTHORIZED' });
    const room = `order:${order.orderId}`;
    const firstRoom = apps[0]!.get<NamespaceRegistryPort>(NAMESPACE_REGISTRY).get('/customer')!;
    first.socket.emit('subscribe', { room });
    for (let i = 0; i < 100 && firstRoom.socketsIn(room) === 0; i++)
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(firstRoom.socketsIn(room)).toBe(1);
    const http = await apps[1]!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/v1/customer/orders/${order.orderId}/tracking`,
        headers: { authorization: `Bearer ${owner}` },
      });
    expect(http.statusCode).toBe(200);
    expect(initial.orders[0]).toMatchObject({
      orderId: order.orderId,
      status: http.json().taskStatus,
      riderLocation: http.json().riderLocation,
    });
    const firstDisconnected = new Promise<void>((resolveDisconnect) =>
      first.socket.once('disconnect', () => resolveDisconnect()),
    );
    await apps[0]!.close();
    await firstDisconnected;
    const resumed = connect(1, owner);
    const snapshot = await resumed.snapshot;
    expect(snapshot.orders[0]).toMatchObject({
      orderId: order.orderId,
      status: http.json().taskStatus,
      riderLocation: http.json().riderLocation,
    });
    const secondRoom = apps[1]!.get<NamespaceRegistryPort>(NAMESPACE_REGISTRY).get('/customer')!;
    resumed.socket.emit('subscribe', { room });
    for (let i = 0; i < 100 && secondRoom.socketsIn(room) === 0; i++)
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    expect(secondRoom.socketsIn(room)).toBe(1);
    await apps[1]!
      .get<DeliveryTaskCancellation>(DELIVERY_TASK_CANCELLATION)
      .cancel(order.orderId, 'test cancellation');
    const terminal = await apps[1]!
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: `/v1/customer/orders/${order.orderId}/tracking`,
        headers: { authorization: `Bearer ${owner}` },
      });
    expect(terminal.statusCode).toBe(200);
    expect(terminal.json()).toMatchObject({ taskStatus: 'CANCELLED', riderLocation: null });
    const terminalDenied = new Promise<unknown>((resolveDenied) =>
      resumed.socket.once('rejected', resolveDenied),
    );
    resumed.socket.emit('subscribe', { room: `order:${order.orderId}` });
    expect(await terminalDenied).toEqual({ code: 'ROOM_UNAUTHORIZED' });
    expect(secondRoom.socketsIn(room)).toBe(0);
    const finalSocket = connect(1, owner);
    expect((await finalSocket.snapshot).orders).toEqual([]);
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await Promise.all(apps.map((app) => app.close().catch(() => undefined)));
    await db.close();
    await services.stop();
  }
}, 120000);
