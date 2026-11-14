import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import { io, type Socket } from 'socket.io-client';
import { createApplication } from '../../../src/bootstrap.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { LocalTokenAdapter } from '../../../src/adapters/auth/local.js';
import { uuidV7 } from '../../../src/common/ids/ids.js';
import { createDatabase } from '../../../src/platform/database/database.js';
import { ACTIVE_ORDER_RESOLVER_HOLDER } from '../../../src/modules/tracking/contracts/tokens.js';
import type { ActiveOrderResolverHolder } from '../../../src/modules/tracking/contracts/tracking.js';
import { PostgresLocationIngest } from '../../../src/modules/tracking/infrastructure/postgres-location-ingest.js';
import { RedisRiderGeo } from '../../../src/modules/tracking/infrastructure/redis-geo.js';
import { INTEGRITY_DEFAULTS } from '../../../src/modules/tracking/domain/integrity.js';
import {
  BroadcastRecorder,
  emitConfirmedOrder,
  seedDispatchWorld,
} from '../../helpers/dispatch-fixture.js';
import { startTestServices } from '../../helpers/services.js';

test('rider sockets require approval and a token group, restore multiple tasks, and revoke suspended access', async () => {
  const services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    log: () => undefined,
  });
  const db = createDatabase(services.databaseUrl);
  const redis = new Redis(services.redisUrl);
  const sockets: Socket[] = [];
  let app: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const world = await seedDispatchWorld(db);
    const orders = await Promise.all([
      emitConfirmedOrder(db, world),
      emitConfirmedOrder(db, world),
    ]);
    for (const order of orders)
      await sql`INSERT INTO delivery_tasks(id,order_id,store_id,customer_user_id,status,rider_id)
      VALUES(${uuidV7()}::uuid,${order.orderId}::uuid,${world.store}::uuid,${world.customer}::uuid,'ASSIGNED',${world.rider1}::uuid)`.execute(
        db.db,
      );
    const env = readEnv({
      NODE_ENV: 'test',
      APP_ROLE: 'rider',
      LOG_LEVEL: 'silent',
      DATABASE_URL: services.databaseUrl,
      REDIS_URL: services.redisUrl,
      SHUTDOWN_TIMEOUT_MS: '1000',
    });
    const adapter = new LocalTokenAdapter(env.LOCAL_JWT_SECRET, db.db);
    const valid = await adapter.issue('WORKFORCE', world.rider1, 'rider', 'access');
    const missingGroup = await new SignJWT({ token_use: 'access', 'cognito:groups': [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('local:WORKFORCE')
      .setAudience('rider')
      .setSubject(world.rider1)
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(env.LOCAL_JWT_SECRET));
    app = await createApplication(env);
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (!address || typeof address === 'string') throw new Error('missing server address');
    const connect = (token: string) => {
      const socket = io(`http://127.0.0.1:${address.port}/rider`, {
        auth: { token },
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      sockets.push(socket);
      return socket;
    };
    async function denied(token: string) {
      const socket = connect(token);
      return new Promise<string>((resolveDenied) =>
        socket.once('connect_error', (error) => resolveDenied(error.message)),
      );
    }
    expect(await denied(missingGroup)).toBe('UNAUTHORIZED');
    await sql`UPDATE rider_profiles SET status='PENDING' WHERE user_id=${world.rider1}::uuid`.execute(
      db.db,
    );
    expect(await denied(valid)).toBe('UNAUTHORIZED');
    await sql`UPDATE rider_profiles SET status='APPROVED' WHERE user_id=${world.rider1}::uuid`.execute(
      db.db,
    );
    const rider = connect(valid);
    const snapshot = await new Promise<{ activeTasks: { orderId: string }[] }>(
      (resolveSnapshot, reject) => {
        rider.once('snapshot', resolveSnapshot);
        rider.once('connect_error', reject);
      },
    );
    expect(snapshot.activeTasks.map((item) => item.orderId).sort()).toEqual(
      orders.map((order) => order.orderId).sort(),
    );

    const holder = app.get<ActiveOrderResolverHolder>(ACTIVE_ORDER_RESOLVER_HOLDER);
    const broadcasts = new BroadcastRecorder();
    const ingest = new PostgresLocationIngest(
      db.db,
      new RedisRiderGeo(redis),
      holder,
      broadcasts,
      INTEGRITY_DEFAULTS,
      120,
    );
    const location = await ingest.ingestBatch(world.rider1, [
      { ts: new Date().toISOString(), lat: world.storeLat, lng: world.storeLng },
    ]);
    expect(location.accepted).toBe(1);
    expect(
      broadcasts.events
        .filter((event) => event.event === 'rider.location')
        .map((event) => event.room)
        .sort(),
    ).toEqual(orders.map((order) => `order:${order.orderId}`).sort());

    await sql`UPDATE rider_profiles SET status='SUSPENDED' WHERE user_id=${world.rider1}::uuid`.execute(
      db.db,
    );
    const disconnected = new Promise<void>((resolveDisconnect) =>
      rider.once('disconnect', () => resolveDisconnect()),
    );
    rider.emit('subscribe', { room: `order:${orders[0]!.orderId}` });
    await disconnected;
  } finally {
    sockets.forEach((socket) => socket.disconnect());
    await app?.close();
    await redis.quit();
    await db.close();
    await services.stop();
  }
}, 120_000);
