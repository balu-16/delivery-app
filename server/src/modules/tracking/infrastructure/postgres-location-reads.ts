import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type {
  EtaInput,
  EtaProvider,
  EtaRange,
  RiderLastLocation,
  RiderLocationReads,
} from '../contracts/tracking.js';
import { computeEta, type EtaConfig } from '../domain/eta.js';

/** Last accepted point per rider (DB authority for freshness and snapshots). */
export class PostgresLocationReads implements RiderLocationReads {
  constructor(private readonly db: Database) {}
  async lastLocation(riderId: string): Promise<RiderLastLocation | null> {
    const rows = await sql<{
      rider_id: string;
      lat: number | null;
      lng: number | null;
      at: Date | null;
      speed_mps: number | null;
    }>`SELECT s.rider_id,ST_Y(s.last_location::geometry) AS lat,ST_X(s.last_location::geometry) AS lng,s.last_location_at AS at,h.speed_mps
      FROM rider_status s
      LEFT JOIN LATERAL (SELECT speed_mps FROM rider_location_history r WHERE r.rider_id=s.rider_id ORDER BY ts DESC LIMIT 1) h ON true
      WHERE s.rider_id=${riderId}::uuid`.execute(this.db);
    const row = rows.rows[0];
    if (!row?.at || row.lat === null || row.lng === null) return null;
    return {
      riderId: row.rider_id,
      location: { lat: Number(row.lat), lng: Number(row.lng) },
      at: row.at.toISOString(),
      speedMps: row.speed_mps === null ? null : Number(row.speed_mps),
    };
  }
}

/** Config-driven v1 ETA; external route calls stay out of transaction paths. */
export class ConfigEtaProvider implements EtaProvider {
  constructor(private readonly config: () => Promise<EtaConfig>) {}
  async eta(input: EtaInput): Promise<EtaRange> {
    return computeEta(input, await this.config());
  }
}
