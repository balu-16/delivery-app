import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type { PincodeAdministration, PincodeCoverage } from '../contracts/pincodes.js';

export class PostgresPincodeAdmin implements PincodeAdministration {
  constructor(
    private readonly db: Database,
    private readonly identity: IdentityAccess,
  ) {}

  async list(actorId: string): Promise<PincodeCoverage[]> {
    if (!(await this.identity.hasRole(actorId, ['SUPER_ADMIN']))) throw new Error('FORBIDDEN');
    const rows = await sql<{
      id: string;
      pincode: string;
      store_id: string;
      store_name: string;
      store_status: string;
      locality: string;
      active: boolean;
      version: string;
      updated_at: Date;
    }>`
      SELECT p.id::text,p.pincode,p.store_id::text,s.name AS store_name,s.status AS store_status,
        p.locality,p.active,p.version::text,p.updated_at
      FROM delivery_pincodes p JOIN stores s ON s.id=p.store_id ORDER BY p.pincode`.execute(
      this.db,
    );
    return rows.rows.map((row) => ({
      id: row.id,
      pincode: row.pincode,
      storeId: row.store_id,
      storeName: row.store_name,
      storeStatus: row.store_status,
      locality: row.locality,
      active: row.active,
      version: row.version,
      updatedAt: row.updated_at.toISOString(),
    }));
  }

  async create(
    actorId: string,
    pincodes: string[],
    storeId: string,
    locality: string,
  ): Promise<void> {
    if (
      !pincodes.length ||
      pincodes.length > 100 ||
      new Set(pincodes).size !== pincodes.length ||
      pincodes.some((pin) => !/^\d{6}$/.test(pin))
    )
      throw new Error('INVALID_PINCODE');
    if (locality.trim().length > 120) throw new Error('INVALID_INPUT');
    await this.db.transaction().execute(async (tx) => {
      if (!(await this.identity.hasRole(actorId, ['SUPER_ADMIN'], tx)))
        throw new Error('FORBIDDEN');
      const store = await sql`SELECT id FROM stores WHERE id=${storeId}::uuid FOR SHARE`.execute(
        tx,
      );
      if (!store.rows.length) throw new Error('STORE_NOT_FOUND');
      for (const pincode of [...pincodes].sort()) {
        const id = uuidV7();
        const inserted =
          await sql`INSERT INTO delivery_pincodes(id,pincode,store_id,locality,updated_by)
          VALUES(${id}::uuid,${pincode},${storeId}::uuid,${locality.trim()},${actorId}::uuid)
          ON CONFLICT(pincode) DO NOTHING RETURNING id`.execute(tx);
        if (!inserted.rows.length) throw new Error('PINCODE_EXISTS');
        await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
          VALUES(${uuidV7()}::uuid,${actorId}::uuid,'PINCODE_CREATED','delivery_pincode',${id},${JSON.stringify({ pincode, storeId, locality: locality.trim(), active: true })}::jsonb)`.execute(
          tx,
        );
      }
    });
  }

  async update(
    actorId: string,
    id: string,
    input: { storeId: string; locality: string; active: boolean; version: string },
  ): Promise<void> {
    if (!/^[1-9]\d*$/.test(input.version) || input.locality.trim().length > 120)
      throw new Error('INVALID_INPUT');
    await this.db.transaction().execute(async (tx) => {
      if (!(await this.identity.hasRole(actorId, ['SUPER_ADMIN'], tx)))
        throw new Error('FORBIDDEN');
      // Checkout locks a store before locking its PIN assignment. Keep the
      // same order here so concurrent changes and placements cannot deadlock.
      const store =
        await sql`SELECT id FROM stores WHERE id=${input.storeId}::uuid FOR SHARE`.execute(tx);
      if (!store.rows.length) throw new Error('STORE_NOT_FOUND');
      const old = await sql<{
        pincode: string;
        store_id: string;
        locality: string;
        active: boolean;
        version: string;
      }>`SELECT pincode,store_id::text,locality,active,version::text FROM delivery_pincodes WHERE id=${id}::uuid FOR UPDATE`.execute(
        tx,
      );
      if (!old.rows[0]) throw new Error('PINCODE_NOT_FOUND');
      if (old.rows[0].version !== input.version) throw new Error('CONCURRENT_MODIFICATION');
      await sql`UPDATE delivery_pincodes SET store_id=${input.storeId}::uuid,locality=${input.locality.trim()},active=${input.active},version=version+1,updated_by=${actorId}::uuid,updated_at=clock_timestamp() WHERE id=${id}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
        VALUES(${uuidV7()}::uuid,${actorId}::uuid,'PINCODE_CHANGED','delivery_pincode',${id},${JSON.stringify({ before: old.rows[0], after: input })}::jsonb)`.execute(
        tx,
      );
    });
  }
}
