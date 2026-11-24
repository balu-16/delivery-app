import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { VerifiedIdentity } from '../contracts/identity.js';
import type { RiderApplications, RiderApplicationView } from '../contracts/rider-applications.js';
import { canBootstrapRole } from '../domain/identity-policy.js';
import { assertRiderReviewAccess } from './store-review-access.js';
import {
  maybeAdvanceRiderReview,
  readRiderApplication,
  requireActiveRider,
} from './rider-application-reader.js';

/** Self-enrolment never adopts a workforce identity by email or approves a rider. */
export class PostgresRiderApplications implements RiderApplications {
  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
  ) {}

  async bootstrap(
    identity: VerifiedIdentity,
  ): Promise<{ userId: string; status: string; groupPending: boolean }> {
    if (
      identity.pool !== 'WORKFORCE' ||
      identity.tokenUse !== 'id' ||
      !identity.email ||
      !identity.sub
    )
      throw new Error('INVALID_BOOTSTRAP_IDENTITY');
    if (identity.emailVerified !== true) throw new Error('EMAIL_NOT_VERIFIED');
    if (!canBootstrapRole(identity.groups, 'RIDER')) throw new Error('ROLE_CONFLICT');
    const email = identity.email.trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new Error('INVALID_EMAIL');

    return this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`identity:subject:${identity.sub}`}, 0))`.execute(
        tx,
      );
      const subjectConflict =
        await sql`SELECT 1 FROM users WHERE cognito_sub=${identity.sub} AND pool<>'WORKFORCE' LIMIT 1`.execute(
          tx,
        );
      if (subjectConflict.rows.length) throw new Error('ROLE_CONFLICT');
      const existing = await sql<{
        id: string;
        status: string;
      }>`SELECT id,status FROM users
        WHERE pool='WORKFORCE' AND cognito_sub=${identity.sub} FOR UPDATE`.execute(tx);
      const user = existing.rows[0];
      const userId = user?.id ?? uuidV7();
      let status: string | null = null;
      if (user) {
        if (user.status !== 'ACTIVE') throw new Error('ACCOUNT_DISABLED');
        const rider = await sql<{ status: string | null }>`
          SELECT p.status FROM user_roles r LEFT JOIN rider_profiles p ON p.user_id=r.user_id
          WHERE r.user_id=${userId}::uuid AND r.role='RIDER'`.execute(tx);
        if (!rider.rows[0]) throw new Error('ROLE_CONFLICT');
        status = rider.rows[0].status;
      } else {
        // A provisioning saga or another workforce identity with this email needs manual review.
        const conflict =
          await sql`SELECT 1 FROM users WHERE pool='WORKFORCE' AND normalized_email=${email}
          UNION ALL SELECT 1 FROM identity_provisioning WHERE normalized_email=${email} LIMIT 1`.execute(
            tx,
          );
        if (conflict.rows.length) throw new Error('RIDER_ENROLLMENT_REQUIRES_REVIEW');
        try {
          await sql`INSERT INTO users(id,pool,cognito_sub,normalized_email,name,email_verified)
            VALUES(${userId}::uuid,'WORKFORCE',${identity.sub},${email},${identity.name?.trim().slice(0, 100) || email},true)`.execute(
            tx,
          );
        } catch (error: unknown) {
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code === '23505'
          )
            throw new Error('RIDER_ENROLLMENT_REQUIRES_REVIEW', { cause: error });
          throw error;
        }
        await sql`INSERT INTO user_roles(user_id,role) VALUES(${userId}::uuid,'RIDER')`.execute(tx);
      }
      if (status === null) {
        await sql`INSERT INTO rider_profiles(user_id,status) VALUES(${userId}::uuid,'PENDING')`.execute(
          tx,
        );
        await sql`INSERT INTO identity_status_history(id,user_id,actor_id,action,details)
          VALUES(${uuidV7()}::uuid,${userId}::uuid,${userId}::uuid,'RIDER_APPLICATION_CREATED','{}'::jsonb)`.execute(
          tx,
        );
        await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id)
          VALUES(${uuidV7()}::uuid,${userId}::uuid,'RIDER_APPLICATION_CREATED','user',${userId})`.execute(
          tx,
        );
        status = 'PENDING';
      }
      if (identity.groups.includes('RIDER')) return { userId, status, groupPending: false };
      const pending = await sql<{
        pending: boolean;
      }>`SELECT EXISTS(SELECT 1 FROM identity_sync_operations
        WHERE user_id=${userId}::uuid AND action='ROLE_GRANTED' AND details->>'role'='RIDER' AND state<>'COMPLETE') AS pending`.execute(
        tx,
      );
      if (!pending.rows[0]?.pending) {
        // Reconcile a missing group for an existing applicant as well as a new
        // signup. The subject lock above prevents duplicate pending operations.
        await sql`INSERT INTO identity_sync_operations(id,user_id,action,details)
          VALUES(${uuidV7()}::uuid,${userId}::uuid,'ROLE_GRANTED',${JSON.stringify({ role: 'RIDER' })}::jsonb)`.execute(
          tx,
        );
      }
      return { userId, status, groupPending: true };
    });
  }

  async get(
    userId: string,
    tx?: TransactionContext,
    requiredDocuments?: string[],
  ): Promise<RiderApplicationView> {
    const required = requiredDocuments ?? (await this.config.get('requiredRiderDocuments'));
    return readRiderApplication(tx ?? this.db, userId, required);
  }

  async stores(): Promise<Array<{ id: string; name: string; city: string }>> {
    const rows = await sql<{ id: string; name: string; city: string }>`
      SELECT s.id,s.name,c.name AS city FROM stores s JOIN cities c ON c.id=s.city_id
      ORDER BY c.name,s.name,s.id LIMIT 500`.execute(this.db);
    return rows.rows;
  }

  async selectStore(userId: string, storeId: string): Promise<RiderApplicationView> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storeId))
      throw new Error('INVALID_INPUT');
    const required = await this.config.get('requiredRiderDocuments');
    return this.db.transaction().execute(async (tx) => {
      await requireActiveRider(tx, userId);
      // Validate against the same source as the picker list.
      const store = await sql`SELECT s.id FROM stores s JOIN cities c ON c.id=s.city_id
        WHERE s.id=${storeId}::uuid FOR SHARE OF s`.execute(tx);
      if (!store.rows.length) throw new Error('STORE_NOT_FOUND');
      const previous = await sql<{
        status: string;
        home_store_id: string | null;
      }>`SELECT status,home_store_id FROM rider_profiles
        WHERE user_id=${userId}::uuid FOR UPDATE`.execute(tx);
      if (!previous.rows.length) throw new Error('RIDER_STATE_INVALID');
      const current = previous.rows[0]!;
      // Replay-safe: an already-saved selection returns the current snapshot
      // without another audit event or status change, even mid-review.
      if (current.home_store_id === storeId) return readRiderApplication(tx, userId, required);
      if (!['PENDING', 'REJECTED'].includes(current.status)) throw new Error('RIDER_STATE_INVALID');
      const profile = await sql`UPDATE rider_profiles SET home_store_id=${storeId}::uuid
        WHERE user_id=${userId}::uuid AND status IN ('PENDING','REJECTED') RETURNING user_id`.execute(
        tx,
      );
      if (!profile.rows.length) throw new Error('RIDER_STATE_INVALID');
      if (current.home_store_id && current.home_store_id !== storeId) {
        // A manager at the newly selected store must review approvals from the old store.
        const approved = await sql<{
          document_type: string;
          media_id: string;
        }>`SELECT document_type,media_id FROM (
          SELECT DISTINCT ON (document_type) document_type,media_id,status FROM rider_documents
          WHERE rider_id=${userId}::uuid ORDER BY document_type,created_at DESC,id DESC
        ) latest WHERE status='APPROVED'`.execute(tx);
        for (const doc of approved.rows)
          await sql`INSERT INTO rider_documents(id,rider_id,document_type,media_id,status)
            VALUES(${uuidV7()}::uuid,${userId}::uuid,${doc.document_type},${doc.media_id}::uuid,'PENDING')`.execute(
            tx,
          );
      }
      await maybeAdvanceRiderReview(tx, userId, required);
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id,details)
        VALUES(${uuidV7()}::uuid,${userId}::uuid,'RIDER_STORE_SELECTED','user',${userId},${JSON.stringify({ storeId })}::jsonb)`.execute(
        tx,
      );
      return readRiderApplication(tx, userId, required);
    });
  }

  async getForStore(actorId: string, userId: string): Promise<RiderApplicationView> {
    const required = await this.config.get('requiredRiderDocuments');
    return this.db.transaction().execute(async (tx) => {
      await assertRiderReviewAccess(tx, actorId, userId);
      const result = await this.get(userId, tx, required);
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id)
        VALUES(${uuidV7()}::uuid,${actorId}::uuid,'RIDER_APPLICATION_READ','user',${userId})`.execute(
        tx,
      );
      return result;
    });
  }

  async listForStore(actorId: string, storeId: string, before?: string, status?: string) {
    const allowed = ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'];
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      !uuid.test(storeId) ||
      (before && !uuid.test(before)) ||
      (status && !allowed.includes(status))
    )
      throw new Error('INVALID_APPLICATION_FILTER');
    return this.db.transaction().execute(async (tx) => {
      const permitted = await sql`SELECT u.id FROM users u
        JOIN user_roles r ON r.user_id=u.id AND r.role='STORE_MANAGER'
        JOIN store_staff s ON s.user_id=u.id AND s.role='STORE_MANAGER' AND s.store_id=${storeId}::uuid
        WHERE u.id=${actorId}::uuid AND u.status='ACTIVE' AND u.pool='WORKFORCE' FOR SHARE OF u,r,s`.execute(
        tx,
      );
      if (!permitted.rows.length) throw new Error('FORBIDDEN');
      const rows = await sql<{
        id: string;
        name: string;
        normalized_email: string;
        status: string;
        vehicle_type: string | null;
        vehicle_no: string | null;
        applied_at: Date;
      }>`
        SELECT u.id,u.name,u.normalized_email,p.status,p.vehicle_type,p.vehicle_no,u.created_at AS applied_at
        FROM rider_profiles p JOIN users u ON u.id=p.user_id
        JOIN user_roles ur ON ur.user_id=u.id AND ur.role='RIDER'
        WHERE u.pool='WORKFORCE' AND u.status='ACTIVE' AND p.home_store_id=${storeId}::uuid
          AND (${before ?? null}::uuid IS NULL OR u.id<${before ?? null}::uuid)
          AND (${status ?? null}::text IS NULL OR p.status=${status ?? null}) ORDER BY u.id DESC LIMIT 51`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id)
        VALUES(${uuidV7()}::uuid,${actorId}::uuid,'RIDER_APPLICATION_LIST','store',${storeId})`.execute(
        tx,
      );
      const page = rows.rows.slice(0, 50);
      return {
        items: page.map((row) => ({
          userId: row.id,
          name: row.name,
          email: row.normalized_email,
          phone: null,
          appliedAt: row.applied_at.toISOString(),
          status: row.status,
          vehicleType: row.vehicle_type,
          vehicleNo: row.vehicle_no,
        })),
        nextCursor: rows.rows.length > 50 ? page.at(-1)!.id : null,
      };
    });
  }

  async getForAdmin(actorId: string, userId: string): Promise<RiderApplicationView> {
    const result = await this.get(userId);
    await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id)
      VALUES(${uuidV7()}::uuid,${actorId}::uuid,'RIDER_APPLICATION_READ','user',${userId})`.execute(
      this.db,
    );
    return result;
  }

  async list(
    actorId: string,
    before?: string,
    status?: string,
  ): Promise<{
    items: Array<{ userId: string; name: string; email: string; status: string }>;
    nextCursor: string | null;
  }> {
    const allowed = ['PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'SUSPENDED'];
    if (status && !allowed.includes(status)) throw new Error('INVALID_APPLICATION_FILTER');
    if (before && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(before))
      throw new Error('INVALID_APPLICATION_FILTER');
    const rows = await sql<{ id: string; name: string; normalized_email: string; status: string }>`
      SELECT u.id,u.name,u.normalized_email,p.status FROM rider_profiles p JOIN users u ON u.id=p.user_id
      JOIN user_roles ur ON ur.user_id=u.id AND ur.role='RIDER'
      WHERE (${before ?? null}::uuid IS NULL OR u.id<${before ?? null}::uuid)
        AND (${status ?? null}::text IS NULL OR p.status=${status ?? null}) ORDER BY u.id DESC LIMIT 51`.execute(
      this.db,
    );
    await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id)
      VALUES(${uuidV7()}::uuid,${actorId}::uuid,'RIDER_APPLICATION_LIST','rider_application','queue')`.execute(
      this.db,
    );
    const page = rows.rows.slice(0, 50);
    return {
      items: page.map((row) => ({
        userId: row.id,
        name: row.name,
        email: row.normalized_email,
        status: row.status,
      })),
      nextCursor: rows.rows.length > 50 ? page.at(-1)!.id : null,
    };
  }
}
