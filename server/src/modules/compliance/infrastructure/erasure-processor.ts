import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type { SubscriptionObligations } from '../../subscriptions/contracts/subscriptions.js';
import type { TrackingPrivacy } from '../../tracking/contracts/privacy.js';
import type { Payouts } from '../../payouts/contracts/payouts.js';

export interface ErasureSupport {
  anonymizeUser(userId: string, tx: TransactionContext): Promise<void>;
}
export interface ErasureMedia {
  fenceForErasure(userId: string, tx: TransactionContext): Promise<void>;
  eraseFenced(userId: string): Promise<boolean>;
}
/** Locally revokes first; provider and object cleanup are durable subsequent stages. */
export class ErasureProcessor {
  constructor(
    private readonly db: Database,
    private readonly subscriptions: SubscriptionObligations,
    private readonly payouts: Payouts,
    private readonly support: ErasureSupport,
    private readonly media: ErasureMedia,
    private readonly tracking?: TrackingPrivacy,
  ) {}

  async runOne(): Promise<boolean> {
    const candidate = await sql<{
      id: string;
      user_id: string;
      status: string;
    }>`SELECT id,user_id,status FROM erasure_requests
      WHERE status IN ('REQUESTED','BLOCKED','CLEANUP') AND retry_after<=clock_timestamp()
      ORDER BY retry_after,created_at,id LIMIT 1`.execute(this.db);
    const request = candidate.rows[0];
    if (!request) return false;
    if (request.status === 'CLEANUP') {
      await this.finishCleanup(request.id, request.user_id);
      return true;
    }
    await this.db.transaction().execute(async (tx) => {
      // Shares the global role-change lock used by maker-checker and identity changes.
      await sql`SELECT pg_advisory_xact_lock(701002)`.execute(tx);
      // Identity lock precedes subscription, order, wallet, payout and support locks.
      const user = await sql<{
        status: string;
        pool: string;
      }>`SELECT status,pool FROM users WHERE id=${request.user_id}::uuid FOR UPDATE`.execute(tx);
      const locked = await sql<{
        status: string;
      }>`SELECT status FROM erasure_requests WHERE id=${request.id}::uuid FOR UPDATE`.execute(tx);
      if (
        !user.rows[0] ||
        !locked.rows[0] ||
        !['REQUESTED', 'BLOCKED'].includes(locked.rows[0].status)
      )
        return;
      if (user.rows[0].status !== 'ACTIVE') throw new Error('ACCOUNT_DISABLED');
      const blockers: string[] = [];
      const active = await sql<{
        has_order: boolean;
        has_payment: boolean;
        has_refund: boolean;
        has_balance: boolean;
        has_hold: boolean;
        has_custody: boolean;
        has_cash: boolean;
        has_earnings: boolean;
        last_super: boolean;
      }>`SELECT
        EXISTS(SELECT 1 FROM orders WHERE user_id=${request.user_id}::uuid AND status IN ('PENDING_PAYMENT','CONFIRMED','PICKING','PACKED','OUT_FOR_DELIVERY','DELIVERY_FAILED')) AS has_order,
        EXISTS(SELECT 1 FROM payment_attempts WHERE user_id=${request.user_id}::uuid AND status IN ('CREATED','AUTHORIZED','UNKNOWN')) AS has_payment,
        EXISTS(SELECT 1 FROM payment_refunds r JOIN orders o ON o.id=r.order_id WHERE o.user_id=${request.user_id}::uuid AND r.status IN ('PENDING','UNKNOWN','FAILED')) AS has_refund,
        EXISTS(SELECT 1 FROM wallet_accounts WHERE user_id=${request.user_id}::uuid AND (cash_balance_paise<>0 OR promo_balance_paise<>0)) AS has_balance,
        EXISTS(SELECT 1 FROM privacy_legal_holds WHERE user_id=${request.user_id}::uuid AND released_at IS NULL) AS has_hold,
        (EXISTS(SELECT 1 FROM delivery_tasks WHERE (rider_id=${request.user_id}::uuid OR offered_rider_id=${request.user_id}::uuid) AND status IN ('OFFERED','ASSIGNED','AT_STORE','PICKED_UP','ARRIVED')) OR EXISTS(SELECT 1 FROM pick_tasks WHERE assigned_to=${request.user_id}::uuid AND status IN ('ASSIGNED','IN_PROGRESS'))) AS has_custody,
        COALESCE((SELECT sum(delta_paise)<>0 FROM rider_cash_ledger WHERE rider_id=${request.user_id}::uuid),false) AS has_cash,
        EXISTS(SELECT 1 FROM rider_earnings e WHERE e.rider_id=${request.user_id}::uuid AND NOT EXISTS (SELECT 1 FROM payout_earning_claims c WHERE c.earning_id=e.id AND c.active)) AS has_earnings,
        EXISTS(SELECT 1 FROM user_roles WHERE user_id=${request.user_id}::uuid AND role='SUPER_ADMIN') AND (SELECT count(*) FROM users u JOIN user_roles r ON r.user_id=u.id WHERE u.status='ACTIVE' AND r.role='SUPER_ADMIN')<=1 AS last_super`.execute(
        tx,
      );
      const row = active.rows[0]!;
      if (row.has_order) blockers.push('ACTIVE_ORDER');
      if (await this.subscriptions.hasLiveObligations(request.user_id, tx))
        blockers.push('ACTIVE_SUBSCRIPTION');
      if (row.has_balance) blockers.push('WALLET_BALANCE');
      if (row.has_payment) blockers.push('PENDING_PAYMENT');
      if (row.has_refund) blockers.push('PENDING_REFUND');
      if (row.has_hold) blockers.push('LEGAL_HOLD');
      if (row.has_custody) blockers.push('ACTIVE_CUSTODY');
      if (row.has_cash) blockers.push('COD_BALANCE');
      if (row.has_earnings || (await this.payouts.hasUnsettledPayout(request.user_id, tx)))
        blockers.push('PAYOUT_DUE');
      if (row.last_super) blockers.push('LAST_SUPER_ADMIN');
      if (blockers.length) {
        await sql`UPDATE erasure_requests SET status='BLOCKED',blockers=${JSON.stringify(blockers)}::jsonb,retry_after=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp() WHERE id=${request.id}::uuid`.execute(
          tx,
        );
        return;
      }
      await this.media.fenceForErasure(request.user_id, tx);
      await this.tracking?.fence(request.user_id, tx);
      await this.support.anonymizeUser(request.user_id, tx);
      const deliveries = await sql<{
        lease_until: Date | null;
      }>`SELECT d.lease_until FROM notification_deliveries d JOIN notifications n ON n.id=d.notification_id WHERE n.user_id=${request.user_id}::uuid AND d.status IN ('PENDING','HELD','CLAIMED') FOR UPDATE OF d`.execute(
        tx,
      );
      const latestLease = deliveries.rows.reduce(
        (latest, row) => Math.max(latest, row.lease_until?.getTime() ?? 0),
        0,
      );
      const cleanupAfter = latestLease
        ? new Date(Math.max(Date.now(), latestLease) + 120000)
        : new Date();
      await sql`UPDATE notification_deliveries SET status='FAILED',last_error='ACCOUNT_ERASED',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE notification_id IN (SELECT id FROM notifications WHERE user_id=${request.user_id}::uuid) AND status IN ('PENDING','HELD','CLAIMED')`.execute(
        tx,
      );
      await sql`INSERT INTO compliance_export_objects(object_key,job_id,remove_after)
        SELECT object_key,id,CASE WHEN status='RUNNING' THEN GREATEST(COALESCE(lease_until,clock_timestamp()),clock_timestamp()) ELSE clock_timestamp() END
        FROM compliance_export_jobs WHERE owner_id=${request.user_id}::uuid AND object_key IS NOT NULL
        ON CONFLICT(object_key) DO UPDATE SET remove_after=GREATEST(compliance_export_objects.remove_after,EXCLUDED.remove_after)`.execute(
        tx,
      );
      await sql`UPDATE compliance_export_jobs SET status='EXPIRED',lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
        WHERE owner_id=${request.user_id}::uuid AND status<>'EXPIRED'`.execute(tx);
      await sql`DELETE FROM notification_token_results WHERE token_id IN (SELECT id FROM device_tokens WHERE user_id=${request.user_id}::uuid)`.execute(
        tx,
      );
      await sql`DELETE FROM device_tokens WHERE user_id=${request.user_id}::uuid`.execute(tx);
      await sql`DELETE FROM notification_preferences WHERE user_id=${request.user_id}::uuid`.execute(
        tx,
      );
      await sql`UPDATE notifications SET payload='{}'::jsonb,error=NULL,status=CASE WHEN status IN ('PENDING','QUIET_HELD') THEN 'SKIPPED' ELSE status END,retention_anonymized_at=clock_timestamp() WHERE user_id=${request.user_id}::uuid`.execute(
        tx,
      );
      await sql`UPDATE consents SET ip=NULL WHERE user_id=${request.user_id}::uuid`.execute(tx);
      await sql`DELETE FROM carts WHERE user_id=${request.user_id}::uuid`.execute(tx);
      await sql`DELETE FROM customer_favorites WHERE user_id=${request.user_id}::uuid`.execute(tx);
      await sql`DELETE FROM referral_codes WHERE user_id=${request.user_id}::uuid`.execute(tx);
      await sql`UPDATE addresses SET line1='[erased]',line2=NULL,landmark=NULL,pincode='000000',contact_name='[erased]',contact_phone='+10000000000',point=ST_SetSRID(ST_MakePoint(0,0),4326)::geography,is_default=false,deleted_at=COALESCE(deleted_at,clock_timestamp()),updated_at=clock_timestamp() WHERE user_id=${request.user_id}::uuid`.execute(
        tx,
      );
      await sql`UPDATE orders SET address_snapshot='{}'::jsonb WHERE user_id=${request.user_id}::uuid`.execute(
        tx,
      );
      await sql`UPDATE rider_profiles SET vehicle_no=NULL WHERE user_id=${request.user_id}::uuid`.execute(
        tx,
      );
      await sql`UPDATE identity_provisioning SET name='[erased]',normalized_email=${`erased-${request.user_id}@invalid.example`} WHERE cognito_sub=(SELECT cognito_sub FROM users WHERE id=${request.user_id}::uuid)`.execute(
        tx,
      );
      await sql`UPDATE local_identity_directory SET name='[erased]',email=${`erased-${request.user_id}@invalid.example`} WHERE (pool,sub)=(SELECT pool,cognito_sub FROM users WHERE id=${request.user_id}::uuid)`.execute(
        tx,
      );
      await sql`UPDATE users SET status='DELETED',normalized_email=${`erased-${request.user_id}@invalid.example`},name='[erased]',email_verified=false,auth_version=auth_version+1,updated_at=clock_timestamp() WHERE id=${request.user_id}::uuid`.execute(
        tx,
      );
      const syncId = uuidV7();
      await sql`INSERT INTO identity_sync_operations(id,user_id,action,details) VALUES (${syncId}::uuid,${request.user_id}::uuid,'USER_BLOCKED','{}'::jsonb)`.execute(
        tx,
      );
      await sql`UPDATE erasure_requests SET status='CLEANUP',blockers='[]'::jsonb,identity_sync_id=${syncId}::uuid,cleanup_after=${cleanupAfter},retry_after=clock_timestamp(),updated_at=clock_timestamp() WHERE id=${request.id}::uuid`.execute(
        tx,
      );
      await sql`INSERT INTO audit_log(id,actor_id,action,subject_type,subject_id) VALUES (${uuidV7()}::uuid,NULL,'ERASURE_LOCAL_COMPLETE','user',${request.user_id})`.execute(
        tx,
      );
    });
    return true;
  }
  private async finishCleanup(id: string, userId: string): Promise<void> {
    const mediaDone = await this.media.eraseFenced(userId);
    const trackingDone = this.tracking ? await this.tracking.eraseBatch(userId) : true;
    const exports =
      await sql`SELECT 1 FROM compliance_export_objects o JOIN compliance_export_jobs j ON j.id=o.job_id WHERE j.owner_id=${userId}::uuid LIMIT 1`.execute(
        this.db,
      );
    const result = await sql<{
      done: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM erasure_requests r JOIN identity_sync_operations s ON s.id=r.identity_sync_id WHERE r.id=${id}::uuid AND s.state='COMPLETE' AND r.cleanup_after<=clock_timestamp()) AS done`.execute(
      this.db,
    );
    if (!mediaDone || !trackingDone || exports.rows.length || !result.rows[0]?.done) {
      await sql`UPDATE erasure_requests SET retry_after=clock_timestamp()+interval '1 minute',updated_at=clock_timestamp() WHERE id=${id}::uuid AND status='CLEANUP'`.execute(
        this.db,
      );
      return;
    }
    await sql`UPDATE erasure_requests SET status='COMPLETE',updated_at=clock_timestamp() WHERE id=${id}::uuid AND status='CLEANUP'`.execute(
      this.db,
    );
  }
}
