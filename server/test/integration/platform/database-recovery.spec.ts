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

it('bounds pool acquisition while a transaction holds the only connection', async () => {
  const handle = createDatabase(services.databaseUrl, 1, 10000, undefined, 150);
  let release!: () => void;
  let ready!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const transaction = handle.db.transaction().execute(async () => {
    ready();
    await held;
  });
  try {
    await started;
    await expect(handle.ping()).rejects.toThrow(/timeout/i);
    expect(handle.stats().waiting).toBe(0);
  } finally {
    release();
    await transaction;
    await handle.close();
  }
}, 10000);

it('rolls back an active terminated connection and permits an explicit retry', async () => {
  const victim = createDatabase(services.databaseUrl, 1);
  const admin = createDatabase(services.databaseUrl, 1);
  let ready!: (pid: number) => void;
  const started = new Promise<number>((resolve) => {
    ready = resolve;
  });
  try {
    await sql`CREATE TABLE recovery_test (id integer PRIMARY KEY)`.execute(admin.db);
    const transaction = victim.db.transaction().execute(async (tx) => {
      await sql`INSERT INTO recovery_test VALUES (1)`.execute(tx);
      const result = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
      ready(result.rows[0]!.pid);
      await sql`SELECT pg_sleep(5)`.execute(tx);
    });
    const pid = await started;
    await sql`SELECT pg_terminate_backend(${pid})`.execute(admin.db);
    await expect(transaction).rejects.toThrow();
    const count = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM recovery_test`.execute(admin.db);
    expect(count.rows[0]?.count).toBe('0');
    await victim.db.transaction().execute(async (tx) => {
      await sql`INSERT INTO recovery_test VALUES (1)`.execute(tx);
    });
    expect(
      (
        await sql<{ count: string }>`SELECT count(*)::text AS count FROM recovery_test`.execute(
          admin.db,
        )
      ).rows[0]?.count,
    ).toBe('1');
  } finally {
    await victim.close();
    await admin.close();
  }
}, 15000);
