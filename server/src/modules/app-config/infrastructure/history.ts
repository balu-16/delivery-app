import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { ConfigHistory } from '../contracts/history.js';

export class PostgresConfigHistory implements ConfigHistory {
  constructor(private readonly db: Database) {}
  async recent(actorId: string) {
    const actor =
      await sql`SELECT 1 FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${actorId}::uuid AND u.status='ACTIVE' AND u.pool='WORKFORCE' AND r.role='SUPER_ADMIN'`.execute(
        this.db,
      );
    if (!actor.rows.length) throw new Error('FORBIDDEN');
    const rows = await sql<{
      id: string;
      actor: string;
      action: string;
      subject: string;
      details: unknown;
      occurred_at: Date;
    }>`SELECT a.id::text,u.name AS actor,a.action,a.subject_id AS subject,a.details,a.created_at AS occurred_at FROM audit_log a JOIN users u ON u.id=a.actor_id WHERE a.action IN ('CONFIG_CHANGED','FLAG_CHANGED','PINCODE_CREATED','PINCODE_CHANGED') ORDER BY a.created_at DESC,a.id DESC LIMIT 100`.execute(
      this.db,
    );
    return rows.rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      subject: row.subject,
      details: row.details,
      occurredAt: row.occurred_at.toISOString(),
    }));
  }
}
