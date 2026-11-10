import { sql } from 'kysely';
import type { AppConfig } from '../../app-config/contracts/config.js';
import { uuidV7 } from '../../../common/ids/ids.js';
import type { Database, Json, TransactionContext } from '../../../platform/database/database.js';
import type { EventEnvelope } from '../../../platform/outbox/outbox.js';
import type { ConcernQueues } from '../../../platform/queue/concern-queues.js';
import type {
  NotificationChannel,
  NotificationPipeline,
  NotificationClass,
  NotificationLocale,
  NotificationCategory,
  EmailPort,
  PushPort,
} from '../contracts/notifications.js';
import { dedupeKey } from '../domain/dedupe.js';
import { planForEvent } from '../domain/matrix.js';
import { nextRetryDelaySeconds, MAX_DELIVERY_ATTEMPTS } from '../domain/retry.js';
import { resolveLocale } from '../domain/render.js';
import { ChannelSender, recordSendFailure, type DeliveryContext } from './channel-send.js';
import { resolveRecipients, userLocale } from './recipients.js';
import { loadTemplates, QuietHoursSettings } from './settings.js';

const UUID = /^[0-9a-f-]{36}$/i;

function uuidAt(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

interface NotificationRow {
  id: string;
  user_id: string;
  channel: NotificationChannel;
  template_key: string;
  locale: NotificationLocale;
  class: NotificationClass;
  payload: Json;
  status: string;
  error: string | null;
}

/**
 * Durable notification pipeline (ADR 0011). The outbox consumer only writes
 * DB rows inside consumeOnce's transaction; provider calls happen later in
 * `deliverOnce` (concern queue) or `enqueueDue` (recovery scan), so a failed
 * send can never roll back producer work.
 */
export class PostgresNotificationPipeline implements NotificationPipeline {
  private readonly sender: ChannelSender;
  private readonly quiet: QuietHoursSettings;
  constructor(
    private readonly db: Database,
    push: PushPort,
    email: EmailPort,
    private readonly concerns: ConcernQueues | undefined,
    config: AppConfig,
    private readonly maxAttempts = MAX_DELIVERY_ATTEMPTS,
  ) {
    this.sender = new ChannelSender(db, push, email);
    this.quiet = new QuietHoursSettings(config);
  }

  /** Outbox consumer effect: DB rows only (never external calls). */
  async consume(tx: TransactionContext, event: EventEnvelope): Promise<void> {
    const plan = planForEvent(event);
    // These events are deliberately ignored when they describe an internal
    // transition. All other known notification events need a valid plan.
    const payloadRecord =
      event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as Record<string, unknown>)
        : null;
    const internalTransition =
      event.eventType === 'picking.task_changed' &&
      payloadRecord !== null &&
      uuidAt(payloadRecord, 'taskId') !== null &&
      uuidAt(payloadRecord, 'orderId') !== null &&
      ['PENDING', 'ASSIGNED', 'CANCELLED'].includes(String(payloadRecord?.['status']));
    const required = new Set([
      'ORDER_CONFIRMED',
      'ORDER_PACKED',
      'ORDER_OUT_FOR_DELIVERY',
      'ORDER_DELIVERED',
      'ORDER_CANCELLED',
      'picking.task_changed',
      'picking.item_changed',
      'delivery.failed',
      'delivery.wrong_address_flagged',
      'payments.funding.failed',
      'payments.refund.settled',
      'payments.topup.captured',
      'rider.offer_created',
      'rider.offer_revoked',
      'dispatch.rider_offer_created',
      'dispatch.rider_offer_revoked',
      'dispatch.offer_created',
      'dispatch.offer_revoked',
      'rider.document.approved',
      'rider.document.rejected',
      'identity.rider_document_approved',
      'identity.rider_document_rejected',
      'inventory.low_stock',
      'inventory.expiry_soon',
      'picking.sla_breached',
      'payments.refund.initiated',
      'wallet.low_balance',
      'subscription.reminder',
      'subscription.low_balance',
      'subscription.price_increase',
      'subscription.skipped',
      'marketing.campaign',
      'custody.escalated',
      'ops.anomaly',
      'payments.refund.failed',
      'payments.webhook.failed',
      'outbox.lag_high',
      'subscription.generation_incomplete',
      'store.capacity_breached',
      'dispatch.no_rider',
      'reconciliation.finding',
    ]);
    const reason =
      required.has(event.eventType) && event.schemaVersion !== 1
        ? 'UNSUPPORTED_SCHEMA_VERSION'
        : required.has(event.eventType) && !plan && !internalTransition
          ? 'INVALID_OR_UNSUPPORTED_PAYLOAD'
          : null;
    if (reason) {
      await sql`INSERT INTO notification_event_errors(event_id,event_type,aggregate_id,reason) VALUES (${event.eventId}::uuid,${event.eventType},${event.aggregateId},${reason}) ON CONFLICT DO NOTHING`.execute(
        tx,
      );
      return;
    }
    if (!plan) return;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const plans =
      event.eventType === 'ORDER_CONFIRMED'
        ? [
            plan,
            {
              ...plan,
              templateKey: 'store.new_order',
              category: 'STORE_OPS' as const,
              channels: ['PUSH', 'INBOX'] as const,
              recipients: 'STORE_MANAGERS' as const,
            },
          ]
        : [plan];
    for (const plan of plans) {
      const recipients = await resolveRecipients(tx, plan.recipients, {
        userId: uuidAt(payload, 'userId') ?? uuidAt(payload, 'riderId'),
        orderId: uuidAt(payload, 'orderId'),
        storeId: uuidAt(payload, 'storeId'),
      });
      for (const recipient of recipients) {
        if (
          plan.class === 'PROMOTIONAL' &&
          !(await this.preferenceEnabled(tx, recipient, plan.category))
        )
          continue;
        const locale = resolveLocale(await userLocale(tx, recipient));
        for (const channel of plan.channels) {
          await this.insertNotification(tx, {
            recipientId: recipient,
            channel,
            locale,
            templateKey: plan.templateKey,
            category: plan.category,
            class: plan.class,
            data: plan.data,
            deepLink: plan.deepLink,
            pushPriority: plan.pushPriority,
            eventType: event.eventType,
            aggregateId: event.aggregateId,
            transitionVersion: event.aggregateVersion,
          });
        }
      }
    }
  }

  /** Direct fan-out for operational alerts created outside the event matrix. */
  async notifyRecipient(input: {
    tx: TransactionContext;
    recipientIds: readonly string[];
    templateKey: string;
    category: NotificationCategory;
    class: NotificationClass;
    channels: readonly NotificationChannel[];
    data: Record<string, string>;
    dedupeContext: { eventType: string; aggregateId: string; transitionVersion: string };
  }): Promise<number> {
    let inserted = 0;
    for (const recipientId of input.recipientIds)
      for (const channel of input.channels) {
        const created = await this.insertNotification(input.tx, {
          recipientId,
          channel,
          locale: 'en',
          templateKey: input.templateKey,
          category: input.category,
          class: input.class,
          data: input.data,
          deepLink: null,
          pushPriority: 'NORMAL',
          eventType: input.dedupeContext.eventType,
          aggregateId: input.dedupeContext.aggregateId,
          transitionVersion: input.dedupeContext.transitionVersion,
        });
        if (created) inserted += 1;
      }
    return inserted;
  }

  private async preferenceEnabled(
    tx: TransactionContext,
    userId: string,
    category: NotificationCategory,
  ): Promise<boolean> {
    const rows = await sql<{
      enabled: boolean;
    }>`SELECT enabled FROM notification_preferences WHERE user_id=${userId}::uuid AND category=${category}`.execute(
      tx,
    );
    return rows.rows[0]?.enabled ?? true;
  }

  /** One logical notification per dedupe key; the delivery row commits with it. */
  private async insertNotification(
    tx: TransactionContext,
    input: {
      recipientId: string;
      channel: NotificationChannel;
      locale: NotificationLocale;
      templateKey: string;
      category: NotificationCategory;
      class: NotificationClass;
      data: Record<string, string>;
      deepLink: string | null;
      pushPriority: 'HIGH' | 'NORMAL';
      eventType: string;
      aggregateId: string;
      transitionVersion: string;
    },
  ): Promise<boolean> {
    const payload: Json = {
      data: input.data,
      deepLink: input.deepLink,
      pushPriority: input.pushPriority,
    };
    const rows = await sql<{ id: string }>`WITH ins AS (
        INSERT INTO notifications(id,user_id,channel,template_key,locale,category,class,payload,status,dedupe_key)
        VALUES (${uuidV7()}::uuid,${input.recipientId}::uuid,${input.channel},${input.templateKey},${input.locale},${input.category},${input.class},${JSON.stringify(payload)}::jsonb,'PENDING',
          ${dedupeKey({
            recipientId: input.recipientId,
            channel: input.channel,
            eventType: input.eventType,
            aggregateId: input.aggregateId,
            transitionVersion: input.transitionVersion,
          })})
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING id
      ) INSERT INTO notification_deliveries(id,notification_id,channel)
        SELECT ${uuidV7()}::uuid,ins.id,${input.channel} FROM ins RETURNING notification_id`.execute(
      tx,
    );
    return rows.rows.length > 0;
  }

  /** Concern-queue handler body: one claimed provider attempt, post-commit. */
  async deliverOnce(
    deliveryId: string,
    now?: Date,
  ): Promise<'SENT' | 'RETRY' | 'FAILED' | 'HELD' | 'IDLE'> {
    if (!UUID.test(deliveryId)) throw new Error('INVALID_INPUT');
    const claimed = await this.claim(deliveryId);
    if (!claimed) return 'IDLE';
    const row = claimed.row;
    if (row.status === 'SENT') return this.settle(deliveryId, claimed.leaseToken, 'SENT', null);
    if (row.status === 'SKIPPED' || row.status === 'FAILED')
      return this.settle(deliveryId, claimed.leaseToken, 'FAILED', row.error ?? row.status);
    const context: DeliveryContext = {
      deliveryId,
      leaseToken: claimed.leaseToken,
      notificationId: row.id,
      recipientId: row.user_id,
      channel: row.channel,
      templateKey: row.template_key,
      locale: row.locale,
      class: row.class,
      data: (row.payload as { data?: Record<string, string> })?.data ?? {},
      deepLink: (row.payload as { deepLink?: string | null })?.deepLink ?? null,
      payload: (row.payload ?? {}) as Record<string, unknown>,
    };
    try {
      const templates = await loadTemplates(this.db, [row.template_key]);
      const outcome = await this.sender.send(
        context,
        row.class === 'PROMOTIONAL' ? await this.quiet.get() : { startMinute: 0, endMinute: 0 },
        now ?? new Date(),
        templates,
      );
      if (outcome === 'RETRY')
        return await this.recordFailure(context, claimed.attempts, 'PROVIDER_SEND_FAILED');
      return outcome === 'HELD' ? 'HELD' : outcome === 'SENT' ? 'SENT' : 'IDLE';
    } catch (error) {
      const retryAfter =
        error && typeof error === 'object' && 'retryAfterMs' in error
          ? error.retryAfterMs
          : undefined;
      if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0)
        context.retryAfterSeconds = Math.ceil(retryAfter / 1000);
      return await this.recordFailure(
        context,
        claimed.attempts,
        error instanceof Error ? error.message : 'PROVIDER_SEND_FAILED',
      );
    }
  }

  private async claim(
    deliveryId: string,
  ): Promise<{ row: NotificationRow; attempts: number; leaseToken: string } | null> {
    return this.db.transaction().execute(async (tx) => {
      const leaseToken = uuidV7();
      const updated = await sql<{
        notification_id: string;
        attempts: number;
      }>`UPDATE notification_deliveries SET status='CLAIMED', ambiguous_sends=ambiguous_sends + CASE WHEN status='CLAIMED' THEN 1 ELSE 0 END,lease_token=${leaseToken}::uuid,lease_until=clock_timestamp()+interval '2 minutes',attempts=attempts+1,updated_at=clock_timestamp() WHERE id=${deliveryId}::uuid AND attempts < ${this.maxAttempts} AND ((status='PENDING' AND next_retry_at<=clock_timestamp()) OR (status='CLAIMED' AND lease_until<=clock_timestamp())) RETURNING notification_id,attempts`.execute(
        tx,
      );
      const claim = updated.rows[0];
      if (!claim) return null;
      const rows = await sql<
        NotificationRow & { error: string | null }
      >`SELECT id,user_id,channel,template_key,locale,category,class,payload,status,error FROM notifications WHERE id=${claim.notification_id}::uuid`.execute(
        tx,
      );
      return rows.rows[0] ? { row: rows.rows[0], attempts: claim.attempts, leaseToken } : null;
    });
  }

  /** Terminal completion for notifications already resolved by a prior attempt. */
  private async settle(
    deliveryId: string,
    leaseToken: string,
    status: 'SENT' | 'FAILED',
    error: string | null,
  ): Promise<'SENT' | 'IDLE'> {
    await sql`UPDATE notification_deliveries SET status=${status},last_error=${error},updated_at=clock_timestamp() WHERE id=${deliveryId}::uuid AND status='CLAIMED' AND lease_token=${leaseToken}::uuid`.execute(
      this.db,
    );
    return status === 'SENT' ? 'SENT' : 'IDLE';
  }

  private async recordFailure(
    context: DeliveryContext,
    attempts: number,
    message: string,
  ): Promise<'RETRY' | 'FAILED'> {
    return this.db
      .transaction()
      .execute(async (tx) =>
        recordSendFailure(
          tx,
          context,
          attempts,
          message,
          context.channel === 'PUSH'
            ? Math.max(60, context.retryAfterSeconds ?? 0, nextRetryDelaySeconds(attempts))
            : nextRetryDelaySeconds(attempts),
          this.maxAttempts,
        ),
      );
  }

  /** Recovery scan: releases expired quiet holds and re-kicks due deliveries. */
  async enqueueDue(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('INVALID_INPUT');
    await sql`WITH expired AS (UPDATE notification_deliveries SET status='FAILED',last_error='LEASE_EXPIRED_AT_ATTEMPT_LIMIT',ambiguous_sends=ambiguous_sends+1,lease_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE status='CLAIMED' AND lease_until<=clock_timestamp() AND attempts>=${this.maxAttempts} RETURNING notification_id) UPDATE notifications SET status='FAILED',error='LEASE_EXPIRED_AT_ATTEMPT_LIMIT' WHERE id IN (SELECT notification_id FROM expired) AND status IN ('PENDING','QUIET_HELD')`.execute(
      this.db,
    );
    const released = await sql<{
      id: string;
      notification_id: string;
    }>`UPDATE notification_deliveries SET status='PENDING',updated_at=clock_timestamp() WHERE status='HELD' AND next_retry_at<=clock_timestamp() RETURNING id,notification_id`.execute(
      this.db,
    );
    for (const row of released.rows)
      await sql`UPDATE notifications SET status='PENDING' WHERE id=${row.notification_id}::uuid AND status='QUIET_HELD'`.execute(
        this.db,
      );
    if (!this.concerns) return 0;
    const due = await sql<{
      id: string;
    }>`SELECT id FROM notification_deliveries WHERE (status='PENDING' AND next_retry_at<=clock_timestamp()) OR (status='CLAIMED' AND lease_until<=clock_timestamp()) ORDER BY next_retry_at,id LIMIT ${limit}`.execute(
      this.db,
    );
    for (const row of due.rows)
      await this.concerns.enqueue('notifications', 'deliver', { deliveryId: row.id }, row.id);
    return due.rows.length;
  }
}
