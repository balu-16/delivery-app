import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { sql } from 'kysely';
import { createDatabase, type DatabaseHandle } from '../../../src/platform/database/database.js';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import { PostgresRatings } from '../../../src/modules/ratings/infrastructure/postgres-ratings.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';
import { seedDispatchWorld, emitConfirmedOrder } from '../../helpers/dispatch-fixture.js';
let services: TestServices;
let db: DatabaseHandle;
beforeAll(async () => {
  services = await startTestServices();
  await runner({
    databaseUrl: services.databaseUrl,
    dir: resolve('db/migrations'),
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: () => undefined,
  });
  db = createDatabase(services.databaseUrl, 4);
}, 120000);
afterAll(async () => {
  await db?.close();
  await services?.stop();
}, 120000);
it('checks ownership and delivery, prevents duplicates and deduplicates low-rating tickets', async () => {
  const w = await seedDispatchWorld(db),
    order = await emitConfirmedOrder(db, w);
  const config = {
    get: async (key: string) =>
      ({
        ratingWindowHours: 168,
        ratingEditHours: 24,
        ratingAggregateMinimumCount: 1,
        lowRatingThreshold: 2,
        supportFirstResponseSlaHours: 4,
        supportResolutionSlaHours: 24,
      })[key],
  } as unknown as AppConfig;
  const ratings = new PostgresRatings(db.db, config);
  const input = {
    targetType: 'ORDER' as const,
    targetId: order.orderId,
    stars: 1,
    comment: '<script>',
  };
  await expect(ratings.create(w.customer, order.orderId, input)).rejects.toThrow(
    'RATING_NOT_ALLOWED',
  );
  await sql`UPDATE orders SET status='DELIVERED',delivered_at=clock_timestamp() WHERE id=${order.orderId}::uuid`.execute(
    db.db,
  );
  await expect(ratings.create(w.rider1, order.orderId, input)).rejects.toThrow(
    'RATING_NOT_ALLOWED',
  );
  const id = await ratings.create(w.customer, order.orderId, input);
  await expect(ratings.create(w.customer, order.orderId, input)).rejects.toThrow('RATING_EXISTS');
  await ratings.edit(w.customer, order.orderId, id, { stars: 2, comment: 'again' });
  const tickets = await sql<{
    n: string;
  }>`SELECT COUNT(*)::text AS n FROM support_tickets WHERE incident_key=${`rating:${id}`}`.execute(
    db.db,
  );
  expect(tickets.rows[0]?.n).toBe('1');
  expect(await ratings.aggregate('ORDER', order.orderId)).toEqual({ count: 1, average: 2 });
});
