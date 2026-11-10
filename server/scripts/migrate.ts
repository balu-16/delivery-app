import { resolve } from 'node:path';
import { runner } from 'node-pg-migrate';
import { databaseIamRegion, postgresConnectionConfig } from '../src/platform/database/database.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  const direction = process.argv.includes('--down') ? 'down' : 'up';
  if (direction === 'down' && process.env.NODE_ENV === 'production') {
    throw new Error('Down migrations are disabled in production');
  }
  await runner({
    databaseUrl: postgresConnectionConfig(databaseUrl, databaseIamRegion(process.env)),
    dir: resolve(process.cwd(), 'db/migrations'),
    direction,
    migrationsTable: 'pgmigrations',
    count: direction === 'down' ? 1 : Infinity,
  });
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
