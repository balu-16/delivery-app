import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { RiderApplicationView } from '../contracts/rider-applications.js';
import { documentsReady } from '../domain/identity-policy.js';

export type ApplicationConnection = Database | TransactionContext;

/**
 * The checklist for an application: the review snapshot while the
 * application is under review or approved, otherwise the live config
 * (editable applications, new submissions). A missing snapshot falls back
 * to the live config so pre-cutover rows stay readable.
 */
export function effectiveRequiredDocuments(
  status: string,
  snapshot: string[] | null,
  live: string[],
): string[] {
  if (
    (status === 'UNDER_REVIEW' || status === 'APPROVED') &&
    snapshot !== null &&
    snapshot.length > 0
  )
    return [...snapshot];
  return [...live];
}

/** One transaction-aware reader: user + profile joined to the selected store, latest document per type. */
export async function readRiderApplication(
  db: ApplicationConnection,
  userId: string,
  required: string[],
): Promise<RiderApplicationView> {
  const profile = await sql<{
    status: string;
    vehicle_type: string | null;
    vehicle_no: string | null;
    home_store_id: string | null;
    review_required_documents: string[] | null;
    store_id: string | null;
    store_name: string | null;
    store_city: string | null;
    name: string;
    email: string;
    applied_at: Date;
  }>`
    SELECT p.status,p.vehicle_type,p.vehicle_no,p.home_store_id,p.review_required_documents,
      s.id AS store_id,s.name AS store_name,c.name AS store_city,
      u.name,u.normalized_email AS email,u.created_at AS applied_at
    FROM rider_profiles p
    JOIN users u ON u.id=p.user_id
    LEFT JOIN stores s ON s.id=p.home_store_id
    LEFT JOIN cities c ON c.id=s.city_id
    WHERE p.user_id=${userId}::uuid`.execute(db);
  const row = profile.rows[0];
  if (!row) throw new Error('RIDER_APPLICATION_NOT_FOUND');
  const documents = await sql<{
    id: string;
    document_type: string;
    status: string;
    reason: string | null;
    created_at: Date;
  }>`
    SELECT DISTINCT ON (document_type) id,document_type,status,reason,created_at FROM rider_documents
    WHERE rider_id=${userId}::uuid ORDER BY document_type,created_at DESC,id DESC`.execute(db);
  return {
    userId,
    name: row.name,
    email: row.email,
    phone: null,
    appliedAt: row.applied_at.toISOString(),
    status: row.status,
    vehicleType: row.vehicle_type,
    vehicleNo: row.vehicle_no,
    homeStoreId: row.home_store_id,
    homeStore:
      row.store_id && row.store_name && row.store_city
        ? { id: row.store_id, name: row.store_name, city: row.store_city }
        : null,
    requiredDocuments: effectiveRequiredDocuments(
      row.status,
      row.review_required_documents,
      required,
    ),
    documents: documents.rows.map((doc) => ({
      id: doc.id,
      type: doc.document_type,
      status: doc.status,
      reason: doc.reason,
      createdAt: doc.created_at.toISOString(),
    })),
  };
}

/** Recheck the active rider and role before any serialized profile/media lock in the caller. */
export async function requireActiveRider(tx: TransactionContext, userId: string): Promise<void> {
  const actor = await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id
    WHERE u.id=${userId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' AND r.role='RIDER' FOR SHARE OF u,r`.execute(
    tx,
  );
  if (!actor.rows[0]) throw new Error('FORBIDDEN');
}

/**
 * Shared review rule: the last completed prerequisite advances an editable
 * application to UNDER_REVIEW exactly once, guarded on the editable states.
 * The transition persists the current requirements as the review snapshot;
 * later config changes cannot move the checklist mid-review. The snapshot
 * is replaced only here (a new submission after rejection re-enters review
 * with the then-current requirements).
 */
export async function maybeAdvanceRiderReview(
  tx: TransactionContext,
  userId: string,
  required: string[],
): Promise<void> {
  const documents = await sql<{
    document_type: string;
    status: string;
  }>`SELECT DISTINCT ON (document_type) document_type,status FROM rider_documents
    WHERE rider_id=${userId}::uuid ORDER BY document_type,created_at DESC,id DESC`.execute(tx);
  if (!documentsReady(required, documents.rows)) return;
  await sql`UPDATE rider_profiles SET status='UNDER_REVIEW',review_required_documents=${required}::text[] WHERE user_id=${userId}::uuid
    AND status IN ('PENDING','REJECTED')
    AND btrim(vehicle_type) <> '' AND btrim(vehicle_no) <> '' AND home_store_id IS NOT NULL`.execute(
    tx,
  );
}
