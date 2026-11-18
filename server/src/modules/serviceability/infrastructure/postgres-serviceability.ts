import { sql, type Kysely } from 'kysely';
import type { PlatformSchema, TransactionContext } from '../../../platform/database/database.js';
import type { StoreAvailability } from '../../stores/contracts/schedule.js';
import type { Candidate, ServiceabilityRepository } from '../application/serviceability.js';
import type { ServiceabilityInput } from '../contracts/serviceability.js';

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

/** PIN assignments are read from the database so disabling one takes effect immediately. */
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
    _cache?: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string, ttl: number): Promise<void>;
    },
  ) {}
  async findCandidate(
    input: ServiceabilityInput,
    tx?: TransactionContext,
  ): Promise<Candidate | null> {
    if (!input.pincode) return null;
    const result = await sql<CandidateRow>`
      SELECT p.id AS zone_id, p.version::text AS zone_version, c.zone_version::text AS city_zone_version,
        s.id AS store_id, s.status, s.last_order_buffer_minutes AS buffer,
        s.hourly_capacity::int AS capacity, COALESCE(b.claimed, 0)::int AS claimed
      FROM delivery_pincodes p JOIN stores s ON s.id=p.store_id JOIN cities c ON c.id=s.city_id
      LEFT JOIN store_capacity_buckets b ON b.store_id=s.id AND b.slot_start=(date_trunc('hour', ${input.targetTime}::timestamptz AT TIME ZONE ${this.timezone}) AT TIME ZONE ${this.timezone})
      WHERE p.pincode=${input.pincode} AND p.active LIMIT 1`.execute(tx ?? this.db);
    const row = result.rows[0];
    if (!row) return null;
    return {
      zone: {
        kind: 'PINCODE',
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
