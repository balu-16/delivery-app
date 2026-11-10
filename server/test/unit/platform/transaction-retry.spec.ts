import { transactionWithRetry, type Database } from '../../../src/platform/database/database.js';

function databaseWithFailures(codes: string[]): { db: Database; attempts: () => number } {
  let attempts = 0;
  const db = {
    transaction: () => ({
      execute: async (work: (tx: object) => Promise<unknown>) => {
        attempts++;
        const code = codes.shift();
        if (code) throw Object.assign(new Error('database error'), { code });
        return work({});
      },
    }),
  } as unknown as Database;
  return { db, attempts: () => attempts };
}

it('retries injected serialization and deadlock rollbacks and executes the effect once', async () => {
  const fake = databaseWithFailures(['40001', '40P01']);
  let effects = 0;
  expect(await transactionWithRetry(fake.db, async () => ++effects, 3)).toBe(1);
  expect(fake.attempts()).toBe(3);
  expect(effects).toBe(1);
});

it('bounds repeated deadlocks and never retries arbitrary or ambiguous connection errors', async () => {
  const deadlock = databaseWithFailures(['40P01', '40P01', '40P01', '40P01']);
  await expect(transactionWithRetry(deadlock.db, async () => 1, 3)).rejects.toMatchObject({
    code: '40P01',
  });
  expect(deadlock.attempts()).toBe(3);
  for (const code of ['23505', 'ECONNRESET']) {
    const other = databaseWithFailures([code]);
    await expect(transactionWithRetry(other.db, async () => 1)).rejects.toMatchObject({ code });
    expect(other.attempts()).toBe(1);
  }
});

it('reruns the callback after a commit-time serialization rollback', async () => {
  let attempts = 0;
  let callbacks = 0;
  const db = {
    transaction: () => ({
      execute: async (work: (tx: object) => Promise<number>) => {
        attempts++;
        const result = await work({});
        if (attempts === 1)
          throw Object.assign(new Error('serialization rollback'), { code: '40001' });
        return result;
      },
    }),
  } as unknown as Database;
  expect(
    await transactionWithRetry(db, async () => {
      callbacks++;
      return 42;
    }),
  ).toBe(42);
  expect(attempts).toBe(2);
  expect(callbacks).toBe(2);
});
