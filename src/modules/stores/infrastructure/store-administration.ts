import { sql, type Kysely, type Transaction } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { PlatformSchema } from '../../../platform/database/database.js';
import type { IdentityAccess } from '../../identity/contracts/identity.js';
import type {
  HolidayEntry,
  HoursEntry,
  StoreAdministration,
  StoreDraft,
} from '../contracts/administration.js';
import { z } from 'zod';

type Tx = Transaction<PlatformSchema>;
type Kind = 'legal_entities' | 'cities' | 'stores' | 'zones';
const coordinate = z.tuple([
  z.number().finite().min(68).max(98),
  z.number().finite().min(6).max(38),
]);
const ring = z
  .array(coordinate)
  .min(4)
  .max(10000)
  .refine((p) => p[0]![0] === p[p.length - 1]![0] && p[0]![1] === p[p.length - 1]![1]);
const boundsSchema = z
  .object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1).max(100) })
  .strict();
export class PostgresStoreAdministration implements StoreAdministration {
  constructor(
    private readonly db: Kysely<PlatformSchema>,
    private readonly identity: IdentityAccess,
  ) {}
  private async mutate<T>(
    actor: string,
    action: string,
    subject: string,
    work: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      if (!(await this.identity.hasRole(actor, ['ADMIN', 'SUPER_ADMIN'], tx)))
        throw new Error('FORBIDDEN');
      const result = await work(tx);
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details) VALUES(${uuidV7()},${actor},${action},'store_management',${subject},'{}'::jsonb)`.execute(
        tx,
      );
      return result;
    });
  }
  async list(
    actor: string,
    kind: Kind,
    limit: number,
    cursor?: string,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    if (!(await this.identity.hasRole(actor, ['ADMIN', 'SUPER_ADMIN'])))
      throw new Error('FORBIDDEN');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE');
    const after = cursor ?? null;
    const result =
      kind === 'legal_entities'
        ? await sql<{
            id: string;
          }>`SELECT id,name FROM legal_entities WHERE (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${limit + 1}`.execute(
            this.db,
          )
        : kind === 'cities'
          ? await sql<{
              id: string;
            }>`SELECT id,name,ST_AsGeoJSON(bounds)::json AS bounds,zone_version::text FROM cities WHERE (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${limit + 1}`.execute(
              this.db,
            )
          : kind === 'stores'
            ? await sql<{
                id: string;
              }>`SELECT id,legal_entity_id,city_id,name,status,pause_reason,hourly_capacity,last_order_buffer_minutes,ST_Y(location::geometry) AS lat,ST_X(location::geometry) AS lng,version::text FROM stores WHERE (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${limit + 1}`.execute(
                this.db,
              )
            : await sql<{
                id: string;
              }>`SELECT id,store_id,name,priority,active,version::text,ST_AsGeoJSON(polygon)::json AS geometry FROM zones WHERE (${after}::uuid IS NULL OR id>${after}::uuid) ORDER BY id LIMIT ${limit + 1}`.execute(
                this.db,
              );
    const items = result.rows.slice(0, limit);
    return { items, nextCursor: result.rows.length > limit ? items[items.length - 1]!.id : null };
  }
  async operations(
    actor: string,
    storeId: string,
    page: { limit: number; holidayCursor?: string; staffCursor?: string },
  ): Promise<unknown> {
    if (!(await this.identity.hasRole(actor, ['ADMIN', 'SUPER_ADMIN'])))
      throw new Error('FORBIDDEN');
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 100)
      throw new Error('INVALID_PAGE');
    const store = await sql`SELECT id FROM stores WHERE id=${storeId}`.execute(this.db);
    if (!store.rows.length) throw new Error('STORE_NOT_FOUND');
    const hours =
      await sql`SELECT weekday,start_minute,end_minute FROM store_hours WHERE store_id=${storeId} ORDER BY weekday,start_minute`.execute(
        this.db,
      );
    const holidays = await sql<{
      day: string;
      closed: boolean;
    }>`SELECT day::text,closed FROM store_holidays WHERE store_id=${storeId} AND (${page.holidayCursor ?? null}::date IS NULL OR day>${page.holidayCursor ?? null}::date) ORDER BY day LIMIT ${page.limit + 1}`.execute(
      this.db,
    );
    const selectedHolidays = holidays.rows.slice(0, page.limit);
    const firstDay = selectedHolidays[0]?.day ?? null,
      lastDay = selectedHolidays.at(-1)?.day ?? null;
    const holidayHours =
      await sql`SELECT day::text,start_minute,end_minute FROM store_holiday_hours WHERE store_id=${storeId} AND day>=${firstDay}::date AND day<=${lastDay}::date ORDER BY day,start_minute`.execute(
        this.db,
      );
    const [staffUser, staffRole] = page.staffCursor?.split(':') ?? [null, null];
    const staff = await sql<{
      user_id: string;
      role: string;
    }>`SELECT user_id,role FROM store_staff WHERE store_id=${storeId} AND (${staffUser ?? null}::uuid IS NULL OR (user_id,role)>(${staffUser ?? null}::uuid,${staffRole ?? null})) ORDER BY user_id,role LIMIT ${page.limit + 1}`.execute(
      this.db,
    );
    const selectedStaff = staff.rows.slice(0, page.limit),
      lastStaff = selectedStaff.at(-1);
    return {
      hours: hours.rows,
      holidays: selectedHolidays,
      holidayHours: holidayHours.rows,
      staff: selectedStaff,
      nextHolidayCursor: holidays.rows.length > page.limit ? lastDay : null,
      nextStaffCursor:
        staff.rows.length > page.limit && lastStaff
          ? `${lastStaff.user_id}:${lastStaff.role}`
          : null,
    };
  }
  saveEntity(actor: string, name: string, requestedId?: string): Promise<string> {
    const id = requestedId ?? uuidV7();
    return this.mutate(actor, 'LEGAL_ENTITY_SAVED', id, async (tx) => {
      if (
        requestedId &&
        !(await sql`SELECT id FROM legal_entities WHERE id=${id} FOR UPDATE`.execute(tx)).rows
          .length
      )
        throw new Error('RESOURCE_NOT_FOUND');
      await sql`INSERT INTO legal_entities(id,name) VALUES(${id},${name.trim()}) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,updated_at=clock_timestamp()`.execute(
        tx,
      );
      return id;
    });
  }
  saveCity(actor: string, name: string, bounds: object, requestedId?: string): Promise<string> {
    const id = requestedId ?? uuidV7();
    return this.mutate(actor, 'CITY_SAVED', id, async (tx) => {
      const data = JSON.stringify(bounds);
      if (data.length > 250000 || !boundsSchema.safeParse(bounds).success)
        throw new Error('INVALID_ZONE_GEOMETRY');
      const existing = await sql`SELECT id FROM cities WHERE id=${id} FOR UPDATE`.execute(tx);
      if (requestedId && !existing.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      const result = await sql<{
        valid: boolean;
      }>`SELECT ST_IsValid(g) AND NOT ST_IsEmpty(g) AND GeometryType(g)='POLYGON' AND ST_Covers(ST_MakeEnvelope(68,6,98,38,4326),g) AS valid FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${data}),4326) g) p`.execute(
        tx,
      );
      if (!result.rows[0]?.valid) throw new Error('INVALID_ZONE_GEOMETRY');
      const containment = await sql<{
        valid: boolean;
      }>`SELECT NOT EXISTS(SELECT 1 FROM stores s WHERE s.city_id=${id} AND NOT ST_Covers(g,s.location::geometry)) AND NOT EXISTS(SELECT 1 FROM zones z JOIN stores s ON s.id=z.store_id WHERE s.city_id=${id} AND NOT ST_Covers(g,z.polygon)) AS valid FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(${data}),4326) AS g) p`.execute(
        tx,
      );
      if (!containment.rows[0]?.valid) throw new Error('ZONE_OUTSIDE_BOUNDS_OR_AREA');
      await sql`INSERT INTO cities(id,name,bounds) VALUES(${id},${name.trim()},ST_SetSRID(ST_GeomFromGeoJSON(${data}),4326)) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,bounds=EXCLUDED.bounds,zone_version=cities.zone_version+1,updated_at=clock_timestamp()`.execute(
        tx,
      );
      return id;
    });
  }
  saveStore(actor: string, draft: StoreDraft, requestedId?: string): Promise<string> {
    const id = requestedId ?? uuidV7();
    return this.mutate(actor, 'STORE_SAVED', id, async (tx) => {
      const existing = await sql<{
        city_id: string;
      }>`SELECT city_id FROM stores WHERE id=${id} FOR UPDATE`.execute(tx);
      if (requestedId && !existing.rows.length) throw new Error('RESOURCE_NOT_FOUND');
      if (existing.rows[0] && existing.rows[0].city_id !== draft.cityId)
        throw new Error('STORE_CITY_IMMUTABLE');
      const city = await sql<{
        valid: boolean;
      }>`SELECT ST_Covers(bounds, ST_SetSRID(ST_MakePoint(${draft.lng},${draft.lat}),4326)) AS valid FROM cities WHERE id=${draft.cityId} FOR UPDATE`.execute(
        tx,
      );
      if (!city.rows[0]?.valid) throw new Error('INVALID_COORDINATES');
      await sql`INSERT INTO stores(id,legal_entity_id,city_id,name,location,status,hourly_capacity,last_order_buffer_minutes) VALUES(${id},${draft.legalEntityId},${draft.cityId},${draft.name.trim()},ST_SetSRID(ST_MakePoint(${draft.lng},${draft.lat}),4326)::geography,'OFFLINE',${draft.hourlyCapacity},${draft.lastOrderBufferMinutes}) ON CONFLICT(id) DO UPDATE SET legal_entity_id=EXCLUDED.legal_entity_id,name=EXCLUDED.name,location=EXCLUDED.location,hourly_capacity=EXCLUDED.hourly_capacity,last_order_buffer_minutes=EXCLUDED.last_order_buffer_minutes,version=stores.version+1,updated_at=clock_timestamp()`.execute(
        tx,
      );
      await sql`UPDATE cities SET zone_version=zone_version+1 WHERE id=${draft.cityId}`.execute(tx);
      return id;
    });
  }
  async delete(
    actor: string,
    kind: 'legal_entities' | 'cities' | 'stores',
    id: string,
  ): Promise<void> {
    await this.mutate(actor, 'RESOURCE_DELETED', id, async (tx) => {
      const result =
        kind === 'legal_entities'
          ? await sql`DELETE FROM legal_entities WHERE id=${id} RETURNING id`.execute(tx)
          : kind === 'cities'
            ? await sql`DELETE FROM cities WHERE id=${id} RETURNING id`.execute(tx)
            : await sql`DELETE FROM stores WHERE id=${id} RETURNING id`.execute(tx);
      if (!result.rows.length) throw new Error('RESOURCE_NOT_FOUND');
    });
  }
  async hours(actor: string, storeId: string, entries: HoursEntry[]): Promise<void> {
    await this.mutate(actor, 'STORE_HOURS_CHANGED', storeId, async (tx) => {
      if (
        !(await sql`SELECT id FROM stores WHERE id=${storeId} FOR UPDATE`.execute(tx)).rows.length
      )
        throw new Error('STORE_NOT_FOUND');
      if (entries.some((w) => w.startMinute === w.endMinute)) throw new Error('INVALID_HOURS');
      await sql`DELETE FROM store_hours WHERE store_id=${storeId}`.execute(tx);
      for (const w of entries)
        await sql`INSERT INTO store_hours(store_id,weekday,start_minute,end_minute) VALUES(${storeId},${w.weekday},${w.startMinute},${w.endMinute})`.execute(
          tx,
        );
    });
  }
  async holiday(actor: string, storeId: string, entry: HolidayEntry): Promise<void> {
    await this.mutate(actor, 'STORE_HOLIDAY_CHANGED', storeId, async (tx) => {
      if (
        !(await sql`SELECT id FROM stores WHERE id=${storeId} FOR UPDATE`.execute(tx)).rows.length
      )
        throw new Error('STORE_NOT_FOUND');
      if (
        (entry.closed && entry.windows.length) ||
        entry.windows.some((w) => w.startMinute === w.endMinute)
      )
        throw new Error('INVALID_HOURS');
      await sql`INSERT INTO store_holidays(store_id,day,closed) VALUES(${storeId},${entry.day}::date,${entry.closed}) ON CONFLICT(store_id,day) DO UPDATE SET closed=EXCLUDED.closed`.execute(
        tx,
      );
      await sql`DELETE FROM store_holiday_hours WHERE store_id=${storeId} AND day=${entry.day}::date`.execute(
        tx,
      );
      for (const w of entry.windows)
        await sql`INSERT INTO store_holiday_hours(store_id,day,start_minute,end_minute) VALUES(${storeId},${entry.day}::date,${w.startMinute},${w.endMinute})`.execute(
          tx,
        );
    });
  }
  async deleteHoliday(actor: string, storeId: string, day: string): Promise<void> {
    await this.mutate(actor, 'STORE_HOLIDAY_DELETED', storeId, async (tx) => {
      if (
        !(
          await sql`DELETE FROM store_holidays WHERE store_id=${storeId} AND day=${day}::date RETURNING day`.execute(
            tx,
          )
        ).rows.length
      )
        throw new Error('RESOURCE_NOT_FOUND');
    });
  }
  async assign(
    actor: string,
    storeId: string,
    userId: string,
    role: 'PICKER' | 'STORE_MANAGER',
    active: boolean,
  ): Promise<void> {
    await this.mutate(actor, 'STORE_ASSIGNMENT_CHANGED', storeId, async (tx) => {
      if (active) {
        if (!(await this.identity.hasRole(userId, [role], tx))) throw new Error('FORBIDDEN');
        await sql`INSERT INTO store_staff(user_id,store_id,role) VALUES(${userId},${storeId},${role}) ON CONFLICT DO NOTHING`.execute(
          tx,
        );
      } else
        await sql`DELETE FROM store_staff WHERE user_id=${userId} AND store_id=${storeId} AND role=${role}`.execute(
          tx,
        );
    });
  }
}
