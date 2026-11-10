import { sql } from 'kysely';
import type { Database } from '../../../platform/database/database.js';
import type { RiderProfileOnboarding } from '../contracts/identity.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import { documentsReady } from '../domain/identity-policy.js';
export class RiderProfileService implements RiderProfileOnboarding {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}
  async profile(userId: string, vehicleType: string, vehicleNo: string): Promise<void> {
    if (
      !vehicleType.trim() ||
      vehicleType.length > 40 ||
      !vehicleNo.trim() ||
      vehicleNo.length > 40
    )
      throw new Error('INVALID_RIDER_PROFILE');
    const required = await this.config.get('requiredRiderDocuments');
    await this.db.transaction().execute(async (tx) => {
      const actor = await sql<{
        id: string;
      }>`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.id=${userId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role='RIDER' FOR SHARE OF u,r`.execute(
        tx,
      );
      if (!actor.rows[0]) throw new Error('FORBIDDEN');
      const updated =
        await sql`INSERT INTO rider_profiles(user_id,status,vehicle_type,vehicle_no) VALUES (${userId}::uuid,'PENDING',${vehicleType.trim()},${vehicleNo.trim()})
        ON CONFLICT(user_id) DO UPDATE SET vehicle_type=EXCLUDED.vehicle_type,vehicle_no=EXCLUDED.vehicle_no WHERE rider_profiles.status IN ('PENDING','REJECTED')`.execute(
          tx,
        );
      if (!updated.numAffectedRows) throw new Error('RIDER_STATE_INVALID');
      const documents = await sql<{
        document_type: string;
        status: string;
      }>`SELECT DISTINCT ON (document_type) document_type,status FROM rider_documents WHERE rider_id=${userId}::uuid ORDER BY document_type,created_at DESC,id DESC`.execute(
        tx,
      );
      if (documentsReady(required, documents.rows)) {
        await sql`UPDATE rider_profiles SET status='UNDER_REVIEW' WHERE user_id=${userId}::uuid`.execute(
          tx,
        );
      }
    });
  }
}
