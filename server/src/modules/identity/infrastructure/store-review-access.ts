import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';
import type { RiderReviewerScope } from '../contracts/uploads.js';

/** Lock the manager's current role and store assignment for the whole review. */
export async function assertRiderReviewAccess(
  tx: TransactionContext,
  reviewerId: string,
  riderId: string,
  profileLock: 'share' | 'update' = 'share',
): Promise<void> {
  if (reviewerId === riderId) throw new Error('FORBIDDEN');
  const manager = await sql<{ store_id: string }>`
    SELECT s.store_id FROM users u
    JOIN user_roles r ON r.user_id=u.id AND r.role='STORE_MANAGER'
    JOIN store_staff s ON s.user_id=u.id AND s.role='STORE_MANAGER'
    JOIN rider_profiles p ON p.home_store_id=s.store_id AND p.user_id=${riderId}::uuid
    WHERE u.id=${reviewerId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE'
    FOR SHARE OF u,r,s`.execute(tx);
  if (!manager.rows.length) throw new Error('FORBIDDEN');
  const target =
    await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role='RIDER'
    WHERE u.id=${riderId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' FOR SHARE OF u,r`.execute(
      tx,
    );
  if (!target.rows.length) throw new Error('FORBIDDEN');
  // Lock in the same user-then-profile order used by rider submissions. Reviews
  // take the write lock immediately so concurrent reviewers cannot deadlock on an upgrade.
  const storeId = manager.rows[0]!.store_id;
  const profile =
    profileLock === 'update'
      ? await sql`SELECT user_id FROM rider_profiles WHERE user_id=${riderId}::uuid AND home_store_id=${storeId}::uuid FOR UPDATE`.execute(
          tx,
        )
      : await sql`SELECT user_id FROM rider_profiles WHERE user_id=${riderId}::uuid AND home_store_id=${storeId}::uuid FOR SHARE`.execute(
          tx,
        );
  if (!profile.rows.length) throw new Error('FORBIDDEN');
}

/**
 * Admin branch: recheck the SUPER_ADMIN role and ACTIVE status inside the
 * review transaction. Admin reviews span stores, so there is no home-store
 * join. Lock order is shared with the manager branch: self-check, then the
 * user/role row lock, then the active-rider target, then the profile lock
 * last (so concurrent reviewers cannot deadlock on an upgrade).
 */
export async function assertAdminRiderReviewAccess(
  tx: TransactionContext,
  reviewerId: string,
  riderId: string,
  profileLock: 'share' | 'update' = 'share',
): Promise<void> {
  if (reviewerId === riderId) throw new Error('FORBIDDEN');
  const admin = await sql<{ id: string }>`
    SELECT u.id FROM users u
    JOIN user_roles r ON r.user_id=u.id AND r.role='SUPER_ADMIN'
    WHERE u.id=${reviewerId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE'
    FOR SHARE OF u,r`.execute(tx);
  if (!admin.rows.length) throw new Error('FORBIDDEN');
  const target =
    await sql`SELECT u.id FROM users u JOIN user_roles r ON r.user_id=u.id AND r.role='RIDER'
    WHERE u.id=${riderId}::uuid AND u.pool='WORKFORCE' AND u.status='ACTIVE' FOR SHARE OF u,r`.execute(
      tx,
    );
  if (!target.rows.length) throw new Error('FORBIDDEN');
  // Lock in the same user-then-profile order used by rider submissions. Reviews
  // take the write lock immediately so concurrent reviewers cannot deadlock on an upgrade.
  const profile =
    profileLock === 'update'
      ? await sql`SELECT user_id FROM rider_profiles WHERE user_id=${riderId}::uuid FOR UPDATE`.execute(
          tx,
        )
      : await sql`SELECT user_id FROM rider_profiles WHERE user_id=${riderId}::uuid FOR SHARE`.execute(
          tx,
        );
  if (!profile.rows.length) throw new Error('FORBIDDEN');
}

/** Dispatch to the branch matching the server-derived reviewer scope. */
export async function assertScopedRiderReviewAccess(
  tx: TransactionContext,
  reviewerId: string,
  riderId: string,
  scope: RiderReviewerScope,
  profileLock: 'share' | 'update' = 'share',
): Promise<void> {
  if (scope.role === 'SUPER_ADMIN')
    return assertAdminRiderReviewAccess(tx, reviewerId, riderId, profileLock);
  return assertRiderReviewAccess(tx, reviewerId, riderId, profileLock);
}
