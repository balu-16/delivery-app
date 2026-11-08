import { sql, type Kysely } from 'kysely';
import type { PlatformSchema, TransactionContext } from '../../../platform/database/database.js';
import type { StoreAvailability } from '../../stores/contracts/schedule.js';
import type { Candidate, ServiceabilityRepository } from '../application/serviceability.js';
import type { ServiceabilityInput } from '../contracts/serviceability.js';
import { createHash } from 'node:crypto';

interface CandidateRow {
  zone_id: string;
  zone_version: string;
  city_zone_version: string;
  store_id: string;
  status: 'ONLINE' | 'PAUSED' | 'OFFLINE';
  buffer: number;
  capacity: number;
  claimed: number;
}

/** The external maps provider is intentionally not used for zone membership. */
export class PostgresServiceability implements ServiceabilityRepository {
  constructor(
    private readonly db: Kysely<PlatformSchema>,
    private readonly timezone: string,
    private readonly availability: StoreAvailability,
    private readonly noRiders: (
      storeId: string,
      at: Date,
      tx?: TransactionContext,
    ) => Promise<boolean>,
    private readonly cache?: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string, ttl: number): Promise<void>;
    },
  ) {}
  async findCandidate(
    input: ServiceabilityInput,
    tx?: TransactionContext,
  ): Promise<Candidate | null> {
    // Every hit is keyed by the authoritative versions of all cities. Lost Redis
    // invalidation therefore cannot retain a stale polygon or store ordering.
    let chosen: string | null = null;
    let cacheKey: string | undefined;
    if (this.cache && !tx) {
      const versions = await sql<{
        id: string;
        zone_version: string;
      }>`SELECT id,zone_version::text FROM cities ORDER BY id`.execute(tx ?? this.db);
      const digest = createHash('sha256')
        .update(JSON.stringify([versions.rows, input.lat, input.lng]))
        .digest('hex');
      cacheKey = `delivery:zones:v1:${digest}`;
      chosen = await this.cache.get(cacheKey).catch(() => null);
      if (chosen === '-') return null;
      if (chosen && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(chosen))
        chosen = null;
    }
    if (!chosen) {
      const match = await sql<{
        id: string;
      }>`SELECT z.id FROM zones z JOIN stores s ON s.id=z.store_id
        WHERE z.active AND ST_Covers(z.polygon, ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}), 4326))
        ORDER BY z.priority DESC, ST_Distance(s.location, ST_SetSRID(ST_MakePoint(${input.lng}, ${input.lat}),4326)::geography), s.id, z.id LIMIT 1`.execute(
        tx ?? this.db,
      );
      chosen = match.rows[0]?.id ?? '-';
      if (cacheKey && this.cache) await this.cache.set(cacheKey, chosen, 60).catch(() => undefined);
      if (chosen === '-') return null;
    }
    const result = await sql<CandidateRow>`
      SELECT z.id AS zone_id, z.version::text AS zone_version, c.zone_version::text AS city_zone_version,
        s.id AS store_id, s.status, s.last_order_buffer_minutes AS buffer,
        s.hourly_capacity::int AS capacity, COALESCE(b.claimed, 0)::int AS claimed
      FROM zones z JOIN stores s ON s.id=z.store_id JOIN cities c ON c.id=s.city_id
      LEFT JOIN store_capacity_buckets b ON b.store_id=s.id AND b.slot_start=(date_trunc('hour', ${input.targetTime}::timestamptz AT TIME ZONE ${this.timezone}) AT TIME ZONE ${this.timezone})
      WHERE z.id=${chosen}::uuid AND z.active LIMIT 1`.execute(tx ?? this.db);
    const row = result.rows[0];
    if (!row) return null;
    return {
      zone: {
        zoneId: row.zone_id,
        zoneVersion: row.zone_version,
        cityZoneVersion: row.city_zone_version,
        storeId: row.store_id,
      },
      status: row.status,
      open: await this.availability.isOpenAt(row.store_id, input.targetTime, tx),
      capacityRemaining: row.claimed < row.capacity,
      noRidersAvailable: await this.noRiders(row.store_id, input.targetTime, tx),
    };
  }
}
