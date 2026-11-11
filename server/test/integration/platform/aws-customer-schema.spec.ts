import { resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { runner } from 'node-pg-migrate';
import { Client } from 'pg';
import { startTestServices, type TestServices } from '../../helpers/services.js';

// Uses a randomly named database in the development cluster, never the app database.
// The explicit flag ensures an ordinary test run cannot fall back to Docker.
const awsOnly = process.env.AWS_P13_INTEGRATION === 'yes' ? describe : describe.skip;
awsOnly('isolated AWS customer schema', () => {
  let services: TestServices | undefined;
  beforeAll(async () => {
    services = await startTestServices({ skipAwsCache: true });
  }, 300000);
  afterAll(async () => {
    await services?.stop();
  }, 300000);
  it('upgrades a populated 033 schema through favorites and referrals', async () => {
    if (!services) throw new Error('Isolated database was not created');
    const prior = (await readdir(resolve('db/migrations'))).filter(
      (name) => /^\d+.*\.sql$/.test(name) && name < '034_',
    ).length;
    await runner({
      databaseUrl: services.databaseUrl,
      dir: resolve('db/migrations'),
      direction: 'up',
      count: prior,
      migrationsTable: 'pgmigrations',
      log: () => undefined,
    });
    const client = new Client({
      connectionString: services.databaseUrl,
      connectionTimeoutMillis: 30000,
    });
    try {
      await client.connect();
      const user = randomUUID();
      await client.query(
        `INSERT INTO users(id,pool,cognito_sub,normalized_email,name) VALUES($1::uuid,'CUSTOMER',$1::text,$2,'Migration test')`,
        [user, `${user}@example.invalid`],
      );
      await runner({
        databaseUrl: services.databaseUrl,
        dir: resolve('db/migrations'),
        direction: 'up',
        count: 1,
        migrationsTable: 'pgmigrations',
        log: () => undefined,
      });
      const result = await client.query<{ name: string }>(
        'SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1',
      );
      expect(result.rows[0]?.name).toMatch(/^034_/);
      expect(
        (await client.query('SELECT name FROM users WHERE id=$1::uuid', [user])).rows[0],
      ).toEqual({ name: 'Migration test' });
      expect(
        (await client.query("SELECT to_regclass('public.customer_favorites') AS name")).rows[0]
          .name,
      ).toBe('customer_favorites');
      await runner({
        databaseUrl: services.databaseUrl,
        dir: resolve('db/migrations'),
        direction: 'up',
        count: 1,
        migrationsTable: 'pgmigrations',
        log: () => undefined,
      });
      expect(
        (
          await client.query<{ name: string }>(
            'SELECT name FROM pgmigrations ORDER BY id DESC LIMIT 1',
          )
        ).rows[0]?.name,
      ).toMatch(/^035_/);
      expect(
        (await client.query('SELECT name FROM users WHERE id=$1::uuid', [user])).rows[0],
      ).toEqual({ name: 'Migration test' });
      expect(
        (await client.query("SELECT to_regclass('public.referral_claims') AS name")).rows[0].name,
      ).toBe('referral_claims');
    } finally {
      await client.end();
    }
  }, 300000);
});
