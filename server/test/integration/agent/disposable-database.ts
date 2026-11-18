import { sql } from 'kysely';
import type { Database } from '../../../src/platform/database/database.js';

/** Agent checks may use only a disposable Aurora database, never the application database. */
export async function assertDisposableAgentDatabase(db: Database): Promise<string> {
  const rows = await sql<{
    name: string;
    jobs: string | null;
  }>`SELECT current_database() AS name, to_regclass('public.agent_jobs')::text AS jobs`.execute(db);
  const name = rows.rows[0]?.name ?? '';
  if (name === 'deliveryapp' || !name.startsWith('delivery_p13_'))
    throw new Error(`Refusing agent checks on database ${name || 'unknown'}`);
  if (!rows.rows[0]?.jobs) throw new Error('agent_jobs is missing; migration 052 did not apply');
  return name;
}
