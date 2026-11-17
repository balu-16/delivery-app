import pg from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { databaseIamRegion, postgresConnectionConfig } from '../src/platform/database/database.js';

/** Deliberately operator-run: application startup never creates checkpoint tables. */
async function main(): Promise<void> {
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL or DATABASE_URL is required');
  const pool = new pg.Pool(postgresConnectionConfig(url, databaseIamRegion(process.env)));
  const saver = new PostgresSaver(pool);
  try {
    await saver.setup();
  } finally {
    await saver.end();
  }
}
void main().catch((error: unknown) => {
  process.stderr.write(
    `Checkpoint setup failed: ${error instanceof Error ? error.name : 'Error'}\n`,
  );
  process.exitCode = 1;
});
