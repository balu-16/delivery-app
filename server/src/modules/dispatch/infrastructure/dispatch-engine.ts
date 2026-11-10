import type { MapsPort } from '../../serviceability/contracts/maps.js';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import {
  databaseTimeAfterLock,
  transactionWithRetry,
  type Database,
  type TransactionContext,
} from '../../../platform/database/database.js';
import type { RealtimeBroadcasts, RiderGeo } from '../../tracking/contracts/tracking.js';
import { haversineMetres } from '../domain/geo.js';
import type { AppConfig } from '../../app-config/contracts/config.js';
import type { RiderEligibility } from '../../riders/contracts/riders.js';
import type { DeliveryTaskCancellation } from '../contracts/tasks.js';
import type { OrderSystemCancel } from '../contracts/dependencies.js';
import {
  nextOfferCandidate,
  scoreCandidates,
  type CandidateScoreInput,
} from '../domain/scoring.js';
import { radiusForAttempt } from '../domain/settings.js';
import { taskEvent, taskHistory, type TaskRow } from './primitives.js';
import type { DispatchSettings } from './settings.js';

const GEO_CANDIDATE_LIMIT = 20;
const NO_CANDIDATE_BACKOFF_SECONDS = 10;

/**
 * Dispatch engine (23.2): GEO prefilter → DB revalidation under locks → pure
 * scoring → sequential offers with expiry/widening/no-rider alerts and the
 * configured auto-cancel. Exactly-once assignment comes from the atomic
 * conditional update in the accept flow; the engine only ever offers.
 */
export class DispatchEngine {
  constructor(
    readonly db: Database,
    readonly settings: DispatchSettings,
    readonly config: AppConfig,
    readonly broadcasts: RealtimeBroadcasts,
    readonly riderGeo: RiderGeo,
    readonly eligibility: RiderEligibility,
    readonly orderSystemCancel: OrderSystemCancel,
    readonly cancellation: DeliveryTaskCancellation,
    readonly maps?: MapsPort,
  ) {}

  /** Attempts one dispatch round for a single order (locks order → task). */
  async dispatchOne(orderId: string): Promise<'OFFERED' | 'RETRY' | 'INELIGIBLE' | 'CANCELLED'> {
    let notification:
      | { riderId: string; offerId: string; taskId: string; orderId: string; expiresAt: string }
      | undefined;
    const result = await transactionWithRetry(this.db, async (tx) => {
      notification = undefined;
      const order = await txSelectOrder(tx, orderId);
      if (!order || order.on_hold) return 'INELIGIBLE';
      const tasks =
        await sql<TaskRow>`SELECT * FROM delivery_tasks WHERE order_id=${orderId}::uuid AND status='UNASSIGNED' ORDER BY created_at DESC FOR UPDATE`.execute(
          tx,
        );
      const task = tasks.rows[0];
      if (!task) return 'INELIGIBLE';
      const now = await databaseTimeAfterLock(tx);
      const gate = await sql<{
        ready: boolean;
      }>`SELECT dispatch_not_before <= clock_timestamp() AS ready FROM delivery_tasks WHERE id=${task.id}::uuid`.execute(
        tx,
      );
      if (!gate.rows[0]?.ready) return 'INELIGIBLE';
      if (await this.maybeAutoCancel(tx, task, now)) return 'CANCELLED';
      const store = await storePoint(tx, task.store_id);
      if (!store) return 'INELIGIBLE';
      const [baseRadius, steps] = await Promise.all([
        this.settings.number('dispatchRadiusM'),
        this.settings.wideningSteps(),
      ]);
      const radius = radiusForAttempt(task.dispatch_attempts, baseRadius, steps);
      const geoIds = await this.riderGeo.candidatesNear(store, radius, GEO_CANDIDATE_LIMIT);
      const codAmount = order.payment_method === 'COD' ? order.amount_due_paise : undefined;
      const eligible = await this.eligibility.eligibleForDispatch({
        riderIds: geoIds,
        at: now,
        codAmountPaise: codAmount,
      });
      const excluded = await this.excludedRiders(tx, task.id, now);
      const candidates = geoIds.filter(
        (riderId) => eligible[riderId]?.eligible && !excluded.has(riderId),
      );
      if (!candidates.length) {
        await this.scheduleRetry(tx, task, now);
        return 'RETRY';
      }
      const scored = scoreCandidates(
        await this.scoreInputs(candidates, store),
        await this.settings.weights(),
      );
      const best = nextOfferCandidate(scored, new Set());
      if (!best) {
        await this.scheduleRetry(tx, task, now);
        return 'RETRY';
      }
      notification = await this.sendOffer(tx, task, best.riderId, now);
      return 'OFFERED' as const;
    });
    if (notification) {
      const n = notification as {
        riderId: string;
        offerId: string;
        taskId: string;
        orderId: string;
        expiresAt: string;
      };
      this.broadcasts.emitRiderEvent(n.riderId, 'offer.created', n);
    }
    return result;
  }

  /** Sweep: due UNASSIGNED tasks get one dispatch round (SKIP LOCKED claim). */
  async dispatchDue(limit = 20): Promise<number> {
    const due = await sql<{ order_id: string }>`SELECT order_id FROM delivery_tasks
      WHERE status='UNASSIGNED' AND dispatch_not_before <= clock_timestamp() AND (next_dispatch_at IS NULL OR next_dispatch_at <= clock_timestamp())
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id=delivery_tasks.order_id AND o.on_hold)
      ORDER BY COALESCE(next_dispatch_at, created_at), id LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`.execute(this.db);
    let offered = 0;
    for (const row of due.rows) {
      const result = await this.dispatchOne(row.order_id).catch(() => 'RETRY' as const);
      if (result === 'OFFERED') offered += 1;
    }
    return offered;
  }

  /** Expires stale offers and returns affected tasks to the pool. */
  async expireOffers(): Promise<number> {
    const candidates = await sql<{
      id: string;
      task_id: string;
      order_id: string;
    }>`SELECT o.id,o.task_id,t.order_id FROM rider_offers o JOIN delivery_tasks t ON t.id=o.task_id WHERE o.status='SENT' AND o.expires_at <= clock_timestamp() ORDER BY o.expires_at LIMIT 100`.execute(
      this.db,
    );
    let count = 0;
    for (const candidate of candidates.rows) {
      const expired = await transactionWithRetry(this.db, async (tx) => {
        await txSelectOrder(tx, candidate.order_id);
        const tasks =
          await sql<TaskRow>`SELECT * FROM delivery_tasks WHERE id=${candidate.task_id}::uuid FOR UPDATE`.execute(
            tx,
          );
        const task = tasks.rows[0];
        if (!task) return false;
        const offers = await sql<{
          rider_id: string;
        }>`UPDATE rider_offers SET status='EXPIRED' WHERE id=${candidate.id}::uuid AND status='SENT' AND expires_at <= clock_timestamp() RETURNING rider_id`.execute(
          tx,
        );
        const offer = offers.rows[0];
        if (!offer) return false;
        if (task.status === 'OFFERED' && task.offered_rider_id === offer.rider_id) {
          await sql`UPDATE delivery_tasks SET status='UNASSIGNED',offered_rider_id=NULL,next_dispatch_at=clock_timestamp(),version=version+1 WHERE id=${task.id}::uuid`.execute(
            tx,
          );
          await taskHistory(tx, task.id, 'OFFERED', 'UNASSIGNED', null, 'offer expired');
        }
        await taskEvent(
          tx,
          task.id,
          task.order_id,
          'rider.offer_revoked',
          {
            riderId: offer.rider_id,
            offerId: candidate.id,
            taskId: task.id,
            orderId: task.order_id,
            storeId: task.store_id,
            reason: 'EXPIRED',
          },
          ['notifications'],
        );
        return true;
      });
      if (expired) count++;
    }
    return count;
  }

  private async maybeAutoCancel(
    tx: TransactionContext,
    task: TaskRow,
    now: Date,
  ): Promise<boolean> {
    const autoCancelMinutes = await this.settings.number('dispatchAutoCancelMinutes');
    const release = await sql<{
      release_at: Date;
    }>`SELECT GREATEST(created_at,dispatch_not_before) AS release_at FROM delivery_tasks WHERE id=${task.id}::uuid`.execute(
      tx,
    );
    const ageMinutes =
      (now.getTime() -
        (task.dispatched_at ?? release.rows[0]?.release_at ?? task.created_at ?? now).getTime()) /
      60000;
    if (ageMinutes < autoCancelMinutes) return false; // alerts fire on the retry path only
    const reason = 'dispatch_auto_cancel_no_rider';
    await this.orderSystemCancel.systemCancel(task.order_id, reason, tx);
    await this.cancellation.cancel(task.order_id, reason, tx);
    return true;
  }

  private async maybeAlertNoRider(tx: TransactionContext, task: TaskRow): Promise<void> {
    const alertAfter = await this.settings.number('dispatchNoRiderAlertAfterAttempts');
    if (task.no_rider_alerted_at || task.dispatch_attempts < alertAfter) return;
    // Aggregate-scoped event with the task's next history version so the
    // outbox unique key (type, id, version) never collides.
    await taskEvent(
      tx,
      task.id,
      task.order_id,
      'dispatch.no_rider',
      { storeId: task.store_id, attempts: task.dispatch_attempts },
      ['notifications'],
    );
    await sql`UPDATE delivery_tasks SET no_rider_alerted_at=clock_timestamp() WHERE id=${task.id}::uuid`.execute(
      tx,
    );
  }

  private async scheduleRetry(tx: TransactionContext, task: TaskRow, now: Date): Promise<void> {
    const next = new Date(now.getTime() + NO_CANDIDATE_BACKOFF_SECONDS * 1000);
    await sql`UPDATE delivery_tasks SET dispatch_attempts=dispatch_attempts+1,dispatched_at=COALESCE(dispatched_at,${now.toISOString()}::timestamptz),next_dispatch_at=${next.toISOString()}::timestamptz WHERE id=${task.id}::uuid`.execute(
      tx,
    );
    await this.maybeAlertNoRider(tx, { ...task, dispatch_attempts: task.dispatch_attempts + 1 });
  }

  /** Riders with a live offer or a recent decline for this task are excluded. */
  private async excludedRiders(
    tx: TransactionContext,
    taskId: string,
    now: Date,
  ): Promise<Set<string>> {
    const cooldownSeconds = await this.settings.number('offerDeclineCooldownSeconds');
    const rows = await sql<{ rider_id: string }>`SELECT DISTINCT rider_id FROM rider_offers
      WHERE task_id=${taskId}::uuid AND (
        (status='SENT' AND expires_at > ${now.toISOString()}::timestamptz)
        OR (status='DECLINED' AND responded_at > ${new Date(now.getTime() - cooldownSeconds * 1000).toISOString()}::timestamptz)
        OR status='ACCEPTED')`.execute(tx);
    return new Set(rows.rows.map((row) => row.rider_id));
  }

  private async scoreInputs(
    candidates: string[],
    store: { lat: number; lng: number },
  ): Promise<CandidateScoreInput[]> {
    const speedKph = await this.config.get('mapFallbackSpeedKph');
    const speedMps = Math.max(speedKph, 1) / 3.6;
    const rows = await sql<{
      rider_id: string;
      lat: number | null;
      lng: number | null;
      idle_since: Date | null;
    }>`SELECT rider_id,ST_Y(last_location::geometry) AS lat,ST_X(last_location::geometry) AS lng,idle_since
      FROM rider_status WHERE rider_id=ANY(${candidates}::uuid[])`.execute(this.db);
    const acceptance = await sql<{
      rider_id: string;
      accepted: string;
      declined: string;
    }>`SELECT rider_id,
        count(*) FILTER (WHERE status='ACCEPTED')::text AS accepted,
        count(*) FILTER (WHERE status='DECLINED')::text AS declined
      FROM rider_offers WHERE rider_id=ANY(${candidates}::uuid[]) GROUP BY rider_id`.execute(
      this.db,
    );
    const rates = new Map(
      acceptance.rows.map((row) => {
        const total = Number(row.accepted) + Number(row.declined);
        return [row.rider_id, total === 0 ? null : Number(row.accepted) / total];
      }),
    );
    const now = Date.now();
    const eligibleRows = rows.rows
      .filter((row) => row.lat !== null && row.lng !== null)
      .sort(
        (a, b) =>
          haversineMetres(store, { lat: Number(a.lat), lng: Number(a.lng) }) -
          haversineMetres(store, { lat: Number(b.lat), lng: Number(b.lng) }),
      );
    const topK = Math.max(1, Math.min(await this.config.get('mapMatrixTopK'), GEO_CANDIDATE_LIMIT));
    const selected = eligibleRows.slice(0, topK);
    const estimates = new Map<string, number>();
    if (this.maps && selected.length) {
      const matrix = await this.maps.distanceMatrix(
        selected.map((row) => ({ lat: Number(row.lat), lng: Number(row.lng) })),
        [store],
      );
      selected.forEach((row, index) => {
        const estimate = matrix[index]?.[0];
        if (estimate && Number.isFinite(estimate.durationSeconds) && estimate.durationSeconds >= 0)
          estimates.set(row.rider_id, estimate.durationSeconds);
      });
    }
    return rows.rows.map((row) => ({
      riderId: row.rider_id,
      etaToStoreSeconds:
        estimates.get(row.rider_id) ??
        (row.lat === null || row.lng === null
          ? 60
          : haversineMetres(store, { lat: Number(row.lat), lng: Number(row.lng) }) / speedMps),
      idleSeconds: row.idle_since ? Math.max(0, (now - row.idle_since.getTime()) / 1000) : 0,
      acceptanceRate: rates.get(row.rider_id) ?? null,
    }));
  }

  private async sendOffer(
    tx: TransactionContext,
    task: TaskRow,
    riderId: string,
    now: Date,
  ): Promise<{
    riderId: string;
    offerId: string;
    taskId: string;
    orderId: string;
    expiresAt: string;
  }> {
    const timeoutSeconds = await this.settings.number('offerTimeoutSeconds');
    const expiresAt = new Date(now.getTime() + timeoutSeconds * 1000);
    const offerId = uuidV7();
    await sql`INSERT INTO rider_offers(id,task_id,rider_id,attempt_no,status,sent_at,expires_at)
      VALUES(${offerId}::uuid,${task.id}::uuid,${riderId}::uuid,${task.attempt_no},'SENT',${now.toISOString()}::timestamptz,${expiresAt.toISOString()}::timestamptz)`.execute(
      tx,
    );
    await sql`UPDATE delivery_tasks SET status='OFFERED',offered_rider_id=${riderId}::uuid,dispatch_attempts=dispatch_attempts+1,dispatched_at=COALESCE(dispatched_at,${now.toISOString()}::timestamptz),next_dispatch_at=${new Date(expiresAt.getTime() + 1000).toISOString()}::timestamptz,version=version+1 WHERE id=${task.id}::uuid`.execute(
      tx,
    );
    await taskHistory(tx, task.id, task.status, 'OFFERED', null, 'offer sent');
    await taskEvent(
      tx,
      task.id,
      task.order_id,
      'rider.offer_created',
      { riderId, offerId, taskId: task.id, orderId: task.order_id, storeId: task.store_id },
      ['notifications'],
    );
    return {
      riderId,
      offerId,
      taskId: task.id,
      orderId: task.order_id,
      expiresAt: expiresAt.toISOString(),
    };
  }
}

async function txSelectOrder(tx: TransactionContext, orderId: string) {
  const rows = await sql<{
    id: string;
    payment_method: string | null;
    amount_due_paise: string;
    on_hold: boolean;
  }>`SELECT id,payment_method,COALESCE((SELECT expected_amount_paise FROM cod_collections WHERE order_id=orders.id),amount_due_paise)::text AS "amount_due_paise",on_hold FROM orders WHERE id=${orderId}::uuid FOR UPDATE`.execute(
    tx,
  );
  return rows.rows[0] ?? null;
}

async function storePoint(tx: TransactionContext, storeId: string) {
  const rows = await sql<{
    lat: string | null;
    lng: string | null;
  }>`SELECT ST_Y(location::geometry)::text AS lat,ST_X(location::geometry)::text AS lng FROM stores WHERE id=${storeId}::uuid`.execute(
    tx,
  );
  const row = rows.rows[0];
  return row?.lat && row?.lng ? { lat: Number(row.lat), lng: Number(row.lng) } : null;
}
