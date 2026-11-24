import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { RiderProfileOnboarding } from '../contracts/identity.js';
import type { RiderApplicationView } from '../contracts/rider-applications.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import {
  maybeAdvanceRiderReview,
  readRiderApplication,
  requireActiveRider,
} from './rider-application-reader.js';

/** Trim both fields, cap at the existing 1-40 limit, uppercase registration letters. */
export function normalizeVehicle(
  vehicleType: string,
  vehicleNo: string,
): { vehicleType: string; vehicleNo: string } {
  const type = typeof vehicleType === 'string' ? vehicleType.trim() : '';
  const no = typeof vehicleNo === 'string' ? vehicleNo.trim().toUpperCase() : '';
  if (!type || type.length > 40 || !no || no.length > 40) throw new Error('INVALID_RIDER_PROFILE');
  return { vehicleType: type, vehicleNo: no };
}

export class RiderProfileService implements RiderProfileOnboarding {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}
  async profile(
    userId: string,
    vehicleType: string,
    vehicleNo: string,
  ): Promise<RiderApplicationView> {
    const normalized = normalizeVehicle(vehicleType, vehicleNo);
    const required = await this.config.get('requiredRiderDocuments');
    return this.db.transaction().execute(async (tx) => {
      await requireActiveRider(tx, userId);
      const existing = await sql<{
        status: string;
        vehicle_type: string | null;
        vehicle_no: string | null;
      }>`SELECT status,vehicle_type,vehicle_no FROM rider_profiles
        WHERE user_id=${userId}::uuid FOR UPDATE`.execute(tx);
      const row = existing.rows[0];
      if (!row) {
        await sql`INSERT INTO rider_profiles(user_id,status,vehicle_type,vehicle_no)
          VALUES(${userId}::uuid,'PENDING',${normalized.vehicleType},${normalized.vehicleNo})`.execute(
          tx,
        );
      } else if (
        row.vehicle_type === normalized.vehicleType &&
        row.vehicle_no === normalized.vehicleNo
      ) {
        // Replay-safe: equivalent save returns the snapshot without an audit
        // or status change, even after review has begun.
        return readRiderApplication(tx, userId, required);
      } else {
        if (!['PENDING', 'REJECTED'].includes(row.status)) throw new Error('RIDER_STATE_INVALID');
        await sql`UPDATE rider_profiles SET vehicle_type=${normalized.vehicleType},vehicle_no=${normalized.vehicleNo}
          WHERE user_id=${userId}::uuid`.execute(tx);
      }
      await maybeAdvanceRiderReview(tx, userId, required);
      return readRiderApplication(tx, userId, required);
    });
  }
}
