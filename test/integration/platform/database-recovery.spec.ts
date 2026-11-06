import { sql } from 'kysely';
import { createDatabase } from '../../../src/platform/database/database.js';
import { startTestServices, type TestServices } from '../../helpers/services.js';

let services: TestServices;
beforeAll(async () => {
  services = await startTestServices();
}, 120000);
afterAll(async () => {
  await services?.stop();
}, 120000);

it('reports a terminated idle connection and opens a replacement on the next query', async () => {
  let notify!: () => void;
  const idleError = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const victim = createDatabase(services.databaseUrl, 1, 10000, notify);
  const admin = createDatabase(services.databaseUrl, 1);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const original = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(victim.db);
    await sql`SELECT pg_terminate_backend(${original.rows[0]!.pid})`.execute(admin.db);
    await Promise.race([
      idleError,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Expected idle connection error')), 5000);
      }),
    ]);
    const replacement = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(
      victim.db,
    );
    expect(replacement.rows[0]?.pid).not.toBe(original.rows[0]?.pid);
    await expect(victim.ping()).resolves.toBeUndefined();
  } finally {
    if (timeout) clearTimeout(timeout);
    await victim.close();
    await admin.close();
  }
}, 15000);
