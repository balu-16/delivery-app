import { sql } from 'kysely';
import type { TransactionContext } from '../../../platform/database/database.js';

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
