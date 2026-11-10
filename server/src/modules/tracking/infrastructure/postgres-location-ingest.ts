import { sql } from 'kysely';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
} from '../../../platform/database/database.js';
import type {
  ActiveOrderResolverHolder,
  IngestOutcome,
  LocationIngest,
  LocationPointInput,
  RealtimeBroadcasts,
} from '../contracts/tracking.js';
import { screenBatch, shouldPersist, type IntegrityConfig } from '../domain/integrity.js';
import { RedisRiderGeo } from './redis-geo.js';

export class PostgresLocationIngest implements LocationIngest {
  constructor(
    private readonly db: Database,
    private readonly geo: RedisRiderGeo,
    private readonly resolverHolder: ActiveOrderResolverHolder,
    private readonly broadcasts: RealtimeBroadcasts,
    private readonly integrity: IntegrityConfig | (() => Promise<IntegrityConfig>),
    private readonly ttlSeconds: number | (() => Promise<number>),
  ) {}

  async ingestBatch(
    riderId: string,
    points: readonly LocationPointInput[],
  ): Promise<IngestOutcome> {
    const integrity =
      typeof this.integrity === 'function' ? await this.integrity() : this.integrity;
    const ttlSeconds =
      typeof this.ttlSeconds === 'function' ? await this.ttlSeconds() : this.ttlSeconds;
    const result = await transactionWithRetry(this.db, async (tx) => {
      const active =
        await sql`SELECT id FROM users WHERE id=${riderId}::uuid AND status='ACTIVE' FOR UPDATE`.execute(
          tx,
        );
      if (!active.rows.length) throw new Error('ACCOUNT_DISABLED');
      await sql`INSERT INTO rider_status(rider_id) VALUES(${riderId}::uuid) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
      const locked = await sql<{
        ts: Date | null;
        lat: number | null;
        lng: number | null;
      }>`SELECT last_location_at AS ts, ST_Y(last_location::geometry) AS lat, ST_X(last_location::geometry) AS lng FROM rider_status WHERE rider_id=${riderId}::uuid FOR UPDATE`.execute(
        tx,
      );
      const current = locked.rows[0]!;
      const last = current.ts
        ? { ts: current.ts, lat: Number(current.lat), lng: Number(current.lng) }
        : null;
      const screened = screenBatch(points, await databaseTimeAfterLock(tx), last, integrity);
      const history = await sql<{
        ts: Date;
        lat: number;
        lng: number;
      }>`SELECT ts, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM rider_location_history WHERE rider_id=${riderId}::uuid ORDER BY ts DESC LIMIT 1`.execute(
        tx,
      );
      let anchor = history.rows[0]
        ? {
            ts: history.rows[0].ts,
            lat: Number(history.rows[0].lat),
            lng: Number(history.rows[0].lng),
          }
        : null;
      let persisted = 0;
      for (const point of screened.accepted) {
        const sample = { ts: point.ts, lat: point.input.lat, lng: point.input.lng };
        if (shouldPersist(anchor, sample, integrity)) {
          await sql`SELECT ensure_location_partition((${point.ts.toISOString()}::timestamptz AT TIME ZONE 'UTC')::date)`.execute(
            tx,
          );
          await sql`INSERT INTO rider_location_history(rider_id,ts,location,accuracy_m,speed_mps,is_mock,battery_pct) VALUES(${riderId}::uuid,${point.ts.toISOString()}::timestamptz,ST_SetSRID(ST_MakePoint(${point.input.lng},${point.input.lat}),4326)::geography,${point.input.accuracyM ?? null},${point.input.speedMps ?? null},false,${point.input.batteryPct ?? null})`.execute(
            tx,
          );
          anchor = sample;
          persisted++;
        }
      }
      const latest = screened.accepted.at(-1);
      if (latest)
        await sql`UPDATE rider_status SET last_location=ST_SetSRID(ST_MakePoint(${latest.input.lng},${latest.input.lat}),4326)::geography, last_location_at=${latest.ts.toISOString()}::timestamptz,last_location_source='GPS',last_heartbeat_at=GREATEST(COALESCE(last_heartbeat_at,'-infinity'::timestamptz),${latest.ts.toISOString()}::timestamptz),unreachable_since=NULL,version=version+1 WHERE rider_id=${riderId}::uuid`.execute(
          tx,
        );
      return { screened, persisted, latest };
    });
    const latest = result.latest;
    if (latest && (await this.geo.updateMember(riderId, latest.input, ttlSeconds))) {
      const order = await this.resolverHolder.get()?.activeOrderForRider(riderId);
      if (
        order &&
        !['DELIVERED', 'FAILED', 'CANCELLED', 'UNASSIGNED', 'OFFERED'].includes(order.taskStatus)
      ) {
        this.broadcasts.emitOrderLocation(order.orderId, {
          lat: latest.input.lat,
          lng: latest.input.lng,
          at: latest.ts.toISOString(),
          accuracyM: latest.input.accuracyM ?? null,
          speedMps: latest.input.speedMps ?? null,
        });
      }
    }
    return {
      accepted: result.screened.accepted.length,
      rejected: {
        count: result.screened.rejected.reduce((sum, entry) => sum + entry.count, 0),
        reasons: Object.fromEntries(
          result.screened.rejected.map((entry) => [entry.reason, entry.count]),
        ),
      },
      persisted: result.persisted,
    };
  }
}
