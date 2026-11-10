import { sql } from 'kysely';
import { createDatabase } from '../../../src/platform/database/database.js';
import { startTestServices } from '../../helpers/services.js';

test('a single-connection smoke transaction can roll back savepoint-scoped work', async () => {
  const services = await startTestServices();
  const handle = createDatabase(services.databaseUrl, 1);
  const db = handle.db;
  try {
    await sql`CREATE TABLE smoke_rollback (value int)`.execute(db);
    await sql`BEGIN`.execute(db);
    await sql`SAVEPOINT nested_smoke`.execute(db);
    await sql`INSERT INTO smoke_rollback VALUES (1)`.execute(db);
    await sql`RELEASE SAVEPOINT nested_smoke`.execute(db);
    await sql`ROLLBACK`.execute(db);
    const result = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM smoke_rollback`.execute(db);
    expect(result.rows[0]?.count).toBe('0');
  } finally {
    await handle.close();
    await services.stop();
  }
}, 120000);
