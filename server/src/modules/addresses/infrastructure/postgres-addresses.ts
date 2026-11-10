import { sql, type Kysely, type Transaction } from 'kysely';
import type { PlatformSchema } from '../../../platform/database/database.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Address, AddressDraft, AddressRepository } from '../contracts/addresses.js';
import type { AddressSubscriptions } from '../../subscriptions/contracts/subscriptions.js';

type DB = Kysely<PlatformSchema> | Transaction<PlatformSchema>;
interface AddressRow {
  id: string;
  line1: string;
  line2: string | null;
  landmark: string | null;
  pincode: string;
  contact_name: string;
  contact_phone: string;
  latitude: number;
  longitude: number;
  is_default: boolean;
  version: string;
}
const columns = sql`id, line1, line2, landmark, pincode, contact_name, contact_phone,
  ST_Y(point::geometry) AS latitude, ST_X(point::geometry) AS longitude, is_default, version::text`;
function map(row: AddressRow): Address {
  return {
    id: row.id,
    line1: row.line1,
    ...(row.line2 === null ? {} : { line2: row.line2 }),
    ...(row.landmark === null ? {} : { landmark: row.landmark }),
    pincode: row.pincode,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    point: { lat: row.latitude, lng: row.longitude },
    isDefault: row.is_default,
    version: row.version,
  };
}
async function lockOwner(db: DB, userId: string): Promise<void> {
  const result =
    await sql`SELECT id FROM users WHERE id = ${userId} AND status='ACTIVE' FOR UPDATE`.execute(db);
  if (!result.rows.length) throw new Error('PROFILE_NOT_INITIALIZED');
}
async function find(db: DB, userId: string, id: string): Promise<Address> {
  const result =
    await sql<AddressRow>`SELECT ${columns} FROM addresses WHERE id = ${id} AND user_id = ${userId} AND deleted_at IS NULL`.execute(
      db,
    );
  const row = result.rows[0];
  if (!row) throw new Error('ADDRESS_NOT_FOUND');
  return map(row);
}
export class PostgresAddresses implements AddressRepository {
  constructor(
    private readonly db: Kysely<PlatformSchema>,
    private readonly subscriptions?: AddressSubscriptions,
  ) {}
  async list(userId: string): Promise<Address[]> {
    const result =
      await sql<AddressRow>`SELECT ${columns} FROM addresses WHERE user_id = ${userId} AND deleted_at IS NULL ORDER BY created_at, id`.execute(
        this.db,
      );
    return result.rows.map(map);
  }
  async create(
    userId: string,
    draft: AddressDraft,
    maxCount: number,
    makeDefault: boolean,
  ): Promise<Address> {
    return this.db.transaction().execute(async (tx) => {
      await lockOwner(tx, userId);
      const count = await sql<{
        count: string;
      }>`SELECT count(*)::text AS count FROM addresses WHERE user_id = ${userId} AND deleted_at IS NULL`.execute(
        tx,
      );
      const active = Number(count.rows[0]?.count);
      if (!Number.isSafeInteger(active) || active >= maxCount)
        throw new Error('ADDRESS_LIMIT_REACHED');
      const isDefault = active === 0 || makeDefault;
      if (isDefault)
        await sql`UPDATE addresses SET is_default = false, version = version + 1, updated_at = clock_timestamp() WHERE user_id = ${userId} AND is_default AND deleted_at IS NULL`.execute(
          tx,
        );
      const id = uuidV7();
      await sql`INSERT INTO addresses (id, user_id, line1, line2, landmark, pincode, contact_name, contact_phone, point, is_default)
        VALUES (${id}, ${userId}, ${draft.line1.trim()}, ${draft.line2 ?? null}, ${draft.landmark ?? null}, ${draft.pincode}, ${draft.contactName.trim()}, ${draft.contactPhone}, ST_SetSRID(ST_MakePoint(${draft.point.lng}, ${draft.point.lat}), 4326)::geography, ${isDefault})`.execute(
        tx,
      );
      return find(tx, userId, id);
    });
  }
  async update(
    userId: string,
    id: string,
    draft: AddressDraft,
    expectedVersion: string,
  ): Promise<Address> {
    return this.db.transaction().execute(async (tx) => {
      await lockOwner(tx, userId);
      const old = await find(tx, userId, id);
      if (old.version !== expectedVersion) throw new Error('CONCURRENT_MODIFICATION');
      await sql`UPDATE addresses SET line1=${draft.line1.trim()}, line2=${draft.line2 ?? null}, landmark=${draft.landmark ?? null}, pincode=${draft.pincode}, contact_name=${draft.contactName.trim()}, contact_phone=${draft.contactPhone}, point=ST_SetSRID(ST_MakePoint(${draft.point.lng}, ${draft.point.lat}), 4326)::geography, version=version+1, updated_at=clock_timestamp() WHERE id=${id} AND user_id=${userId} AND deleted_at IS NULL`.execute(
        tx,
      );
      return find(tx, userId, id);
    });
  }
  async setDefault(userId: string, id: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await lockOwner(tx, userId);
      const chosen = await find(tx, userId, id);
      if (chosen.isDefault) return;
      await sql`UPDATE addresses SET is_default=false, version=version+1, updated_at=clock_timestamp() WHERE user_id=${userId} AND is_default AND deleted_at IS NULL`.execute(
        tx,
      );
      await sql`UPDATE addresses SET is_default=true, version=version+1, updated_at=clock_timestamp() WHERE id=${id} AND user_id=${userId} AND deleted_at IS NULL`.execute(
        tx,
      );
    });
  }
  async remove(userId: string, id: string): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await lockOwner(tx, userId);
      const old = await find(tx, userId, id);
      if (this.subscriptions) await this.subscriptions.pauseForDeletedAddress(userId, id, tx);
      await sql`UPDATE addresses SET deleted_at=clock_timestamp(), is_default=false, version=version+1, updated_at=clock_timestamp() WHERE id=${id} AND user_id=${userId} AND deleted_at IS NULL`.execute(
        tx,
      );
      if (old.isDefault)
        await sql`UPDATE addresses SET is_default=true, version=version+1, updated_at=clock_timestamp() WHERE id=(SELECT id FROM addresses WHERE user_id=${userId} AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1)`.execute(
          tx,
        );
    });
  }
}
