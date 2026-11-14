import { sql, type Kysely, type Transaction } from 'kysely';
import type { PlatformSchema } from '../../../platform/database/database.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { ZoneDraft, ZoneVersion, Zones } from '../contracts/zones.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import { z } from 'zod';

type Tx = Transaction<PlatformSchema>;
const point = z.tuple([z.number().finite().min(68).max(98), z.number().finite().min(6).max(38)]);
const ring = z
  .array(point)
  .min(4)
  .max(10000)
  .refine((p) => p[0]![0] === p[p.length - 1]![0] && p[0]![1] === p[p.length - 1]![1]);
const polygon = z.array(ring).min(1).max(100);
const geometry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), coordinates: polygon }).strict(),
  z
    .object({ type: z.literal('MultiPolygon'), coordinates: z.array(polygon).min(1).max(100) })
    .strict(),
]);
async function validateGeometry(
  tx: Tx,
  draft: ZoneDraft,
  area: { minM2: number; maxM2: number },
): Promise<{ cityId: string; geojson: string }> {
  if (
    !draft.name.trim() ||
    draft.name.length > 120 ||
    !Number.isSafeInteger(draft.priority) ||
    !Number.isFinite(area.minM2) ||
    !Number.isFinite(area.maxM2) ||
    area.minM2 <= 0 ||
    area.maxM2 < area.minM2
  )
    throw new Error('INVALID_ZONE');
  if (!geometry.safeParse(draft.geometry).success) throw new Error('INVALID_ZONE_GEOMETRY');
  const geojson = JSON.stringify(draft.geometry);
  if (!geojson || geojson.length > 250_000) throw new Error('INVALID_ZONE_GEOMETRY');
  const store = await sql<{
    city_id: string;
  }>`SELECT city_id FROM stores WHERE id=${draft.storeId} FOR UPDATE`.execute(tx);
  if (!store.rows[0]) throw new Error('STORE_NOT_FOUND');
  const cityId = store.rows[0].city_id;
  // Serialize zone edits and lock city version along with the validation snapshot.
  await sql`SELECT id FROM cities WHERE id=${cityId} FOR UPDATE`.execute(tx);
  const parsed = await sql<{
    valid: boolean;
  }>`SELECT ST_IsValid(g) AND NOT ST_IsEmpty(g) AND GeometryType(g) IN ('POLYGON','MULTIPOLYGON') AND ST_SRID(g)=4326 AS valid FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geojson}),4326) AS g) p`.execute(
    tx,
  );
  if (!parsed.rows[0]?.valid) throw new Error('INVALID_ZONE_GEOMETRY');
  const dimensions = await sql<{
    valid: boolean;
  }>`SELECT ST_Covers(c.bounds, x.g) AND ST_Area(x.g::geography) BETWEEN ${area.minM2} AND ${area.maxM2} AS valid
    FROM cities c CROSS JOIN (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${geojson}),4326) AS g) x WHERE c.id=${cityId}`.execute(
    tx,
  );
  if (!dimensions.rows[0]?.valid) throw new Error('ZONE_OUTSIDE_BOUNDS_OR_AREA');
  return { cityId, geojson };
}
async function version(tx: Tx, cityId: string): Promise<string> {
  const result = await sql<{
    zone_version: string;
  }>`UPDATE cities SET zone_version=zone_version+1,updated_at=clock_timestamp() WHERE id=${cityId} RETURNING zone_version::text`.execute(
    tx,
  );
  if (!result.rows[0]) throw new Error('CITY_NOT_FOUND');
  return result.rows[0].zone_version;
}
export class PostgresZones implements Zones {
  constructor(
    private readonly db: Kysely<PlatformSchema>,
    private readonly identity?: IdentityAccess,
  ) {}
  create(
    draft: ZoneDraft,
    area: { minM2: number; maxM2: number },
    actorId?: string,
  ): Promise<ZoneVersion> {
    return this.db.transaction().execute(async (tx) => {
      if (
        actorId &&
        (!this.identity || !(await this.identity.hasRole(actorId, ['SUPER_ADMIN'], tx)))
      )
        throw new Error('FORBIDDEN');
      const { cityId, geojson } = await validateGeometry(tx, draft, area);
      const id = uuidV7();
      await sql`INSERT INTO zones(id,store_id,name,polygon,priority,active) VALUES(${id},${draft.storeId},${draft.name.trim()},ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}),4326)),${draft.priority},${draft.active})`.execute(
        tx,
      );
      if (actorId)
        await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()},${actorId},'ZONE_CREATED','zone',${id},'{}'::jsonb)`.execute(
          tx,
        );
      return { id, version: '1', cityZoneVersion: await version(tx, cityId) };
    });
  }
  update(
    id: string,
    expectedVersion: string,
    draft: ZoneDraft,
    area: { minM2: number; maxM2: number },
    actorId?: string,
  ): Promise<ZoneVersion> {
    return this.db.transaction().execute(async (tx) => {
      if (
        actorId &&
        (!this.identity || !(await this.identity.hasRole(actorId, ['SUPER_ADMIN'], tx)))
      )
        throw new Error('FORBIDDEN');
      const old = await sql<{
        store_id: string;
        version: string;
      }>`SELECT store_id, version::text FROM zones WHERE id=${id} FOR UPDATE`.execute(tx);
      if (!old.rows[0]) throw new Error('ZONE_NOT_FOUND');
      if (old.rows[0].version !== expectedVersion) throw new Error('CONCURRENT_MODIFICATION');
      if (old.rows[0].store_id !== draft.storeId) throw new Error('ZONE_STORE_IMMUTABLE');
      const { cityId, geojson } = await validateGeometry(tx, draft, area);
      const result = await sql<{
        version: string;
      }>`UPDATE zones SET name=${draft.name.trim()}, polygon=ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}),4326)), priority=${draft.priority}, active=${draft.active}, version=version+1, updated_at=clock_timestamp() WHERE id=${id} RETURNING version::text`.execute(
        tx,
      );
      if (actorId)
        await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()},${actorId},'ZONE_UPDATED','zone',${id},'{}'::jsonb)`.execute(
          tx,
        );
      return { id, version: result.rows[0]!.version, cityZoneVersion: await version(tx, cityId) };
    });
  }
  deactivate(id: string, expectedVersion: string, actorId: string): Promise<ZoneVersion> {
    return this.db.transaction().execute(async (tx) => {
      if (!this.identity || !(await this.identity.hasRole(actorId, ['SUPER_ADMIN'], tx)))
        throw new Error('FORBIDDEN');
      const current = await sql<{
        store_id: string;
        version: string;
      }>`SELECT store_id,version::text FROM zones WHERE id=${id} FOR UPDATE`.execute(tx);
      if (!current.rows[0]) throw new Error('ZONE_NOT_FOUND');
      if (current.rows[0].version !== expectedVersion) throw new Error('CONCURRENT_MODIFICATION');
      const store = await sql<{
        city_id: string;
      }>`SELECT city_id FROM stores WHERE id=${current.rows[0].store_id} FOR UPDATE`.execute(tx);
      const cityId = store.rows[0]!.city_id;
      await sql`SELECT id FROM cities WHERE id=${cityId} FOR UPDATE`.execute(tx);
      const updated = await sql<{
        version: string;
      }>`UPDATE zones SET active=false,version=version+1,updated_at=clock_timestamp() WHERE id=${id} RETURNING version::text`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()},${actorId},'ZONE_DEACTIVATED','zone',${id},'{}'::jsonb)`.execute(
        tx,
      );
      return { id, version: updated.rows[0]!.version, cityZoneVersion: await version(tx, cityId) };
    });
  }
}
