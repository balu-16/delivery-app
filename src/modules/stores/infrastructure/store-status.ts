import { sql, type Kysely } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { PlatformSchema } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { StoreManagement, StoreStatusInput } from '../contracts/management.js';

export class PostgresStoreManagement implements StoreManagement {
  constructor(
    private readonly db: Kysely<PlatformSchema>,
    private readonly identity: IdentityAccess,
  ) {}
  async setStatus(input: StoreStatusInput): Promise<void> {
    if (input.status === 'PAUSED' && (!input.reason?.trim() || input.reason.length > 500))
      throw new Error('INVALID_PAUSE_REASON');
    await this.db.transaction().execute(async (tx) => {
      const existing = await sql<{
        status: string;
        version: string;
      }>`SELECT status,version::text FROM stores WHERE id=${input.storeId} FOR UPDATE`.execute(tx);
      if (!existing.rows[0]) throw new Error('STORE_NOT_FOUND');
      const authorized = input.admin
        ? await this.identity.hasRole(input.actorId, ['ADMIN', 'SUPER_ADMIN'], tx)
        : await this.identity.hasStoreRole(input.actorId, input.storeId, ['STORE_MANAGER'], tx);
      if (!authorized) throw new Error(input.admin ? 'FORBIDDEN' : 'STORE_NOT_FOUND');
      const previous = existing.rows[0].status;
      const reason = input.status === 'PAUSED' ? input.reason!.trim() : null;
      const updated = await sql<{
        version: string;
        now: Date;
      }>`UPDATE stores SET status=${input.status},pause_reason=${reason},version=version+1,updated_at=clock_timestamp() WHERE id=${input.storeId} RETURNING version::text,updated_at AS now`.execute(
        tx,
      );
      const row = updated.rows[0]!;
      await sql`INSERT INTO store_status_history(store_id,version,previous_status,status,reason,actor_id) VALUES (${input.storeId},${row.version}::bigint,${previous},${input.status},${reason},${input.actorId})`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()},${input.actorId},'STORE_STATUS_CHANGED','store',${input.storeId},${JSON.stringify({ previous, status: input.status, reason })}::jsonb)`.execute(
        tx,
      );
      // No P2 consumers exist yet; persist the immutable event without inventing a delivery target.
      await sql`INSERT INTO outbox_events(id,event_type,schema_version,aggregate_type,aggregate_id,aggregate_version,occurred_at,correlation_id,causation_id,payload) VALUES (${uuidV7()},'store.status_changed',1,'store',${input.storeId},${row.version}::bigint,${row.now},${input.correlationId},NULL,${JSON.stringify({ previous, status: input.status })}::jsonb)`.execute(
        tx,
      );
    });
  }
}
