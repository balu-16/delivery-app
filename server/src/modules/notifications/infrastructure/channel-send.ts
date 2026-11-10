import { sql } from 'kysely';
import type { Database, TransactionContext } from '../../../platform/database/database.js';
import type {
  EmailPort,
  NotificationChannel,
  NotificationLocale,
  PushPort,
  PushTokenResult,
} from '../contracts/notifications.js';
import { chunkBounded } from '../domain/cursor.js';
import { renderTemplate, selectTemplate, type TemplateRow } from '../domain/render.js';
import { isInQuietHours, quietHoursEnd, type QuietWindow } from '../domain/quiet-hours.js';

export interface DeliveryContext {
  deliveryId: string;
  leaseToken: string;
  notificationId: string;
  recipientId: string;
  channel: NotificationChannel;
  templateKey: string;
  locale: string;
  class: 'TRANSACTIONAL' | 'PROMOTIONAL';
  data: Record<string, string>;
  deepLink: string | null;
  payload: Record<string, unknown>;
  retryAfterSeconds?: number;
}

const UUID = /^[0-9a-f-]{36}$/i;

/**
 * Executes one channel send after the claim transaction has committed.
 * Never runs inside a producer transaction; transport failures propagate to
 * the caller so the durable delivery row drives the bounded retry.
 */
export class ChannelSender {
  constructor(
    private readonly db: Database,
    private readonly push: PushPort,
    private readonly email: EmailPort,
  ) {}

  /**
   * Sends (or skips/holds) one delivery. Returns 'SENT' | 'HELD' | 'SKIPPED' |
   * 'RETRY'; 'RETRY' leaves the row PENDING with a scheduled next attempt.
   */
  async send(
    context: DeliveryContext,
    quiet: QuietWindow,
    now: Date,
    templates: readonly TemplateRow[],
  ): Promise<'SENT' | 'HELD' | 'SKIPPED' | 'RETRY'> {
    if (context.class === 'PROMOTIONAL' && isInQuietHours(now, quiet)) {
      const releaseAt = quietHoursEnd(now, quiet);
      await this.db.transaction().execute(async (tx) => {
        if (!(await ownsLease(tx, context))) return;
        await sql`UPDATE notifications SET status='QUIET_HELD' WHERE id=${context.notificationId}::uuid AND status='PENDING'`.execute(
          tx,
        );
        await sql`UPDATE notification_deliveries SET status='HELD',next_retry_at=${releaseAt.toISOString()}::timestamptz,updated_at=clock_timestamp() WHERE id=${context.deliveryId}::uuid AND status='CLAIMED' AND lease_token=${context.leaseToken}::uuid`.execute(
          tx,
        );
      });
      return 'HELD';
    }
    switch (context.channel) {
      case 'INBOX':
        return this.complete(context, null);
      case 'PUSH':
        return this.sendPush(context, now, templates);
      case 'EMAIL':
        return this.sendEmail(context, templates);
    }
  }

  private async complete(context: DeliveryContext, messageId: string | null): Promise<'SENT'> {
    await this.db.transaction().execute(async (tx) => {
      if (!(await ownsLease(tx, context))) return;
      await sql`UPDATE notifications SET status='SENT',sent_at=clock_timestamp(),error=NULL WHERE id=${context.notificationId}::uuid AND status IN ('PENDING','QUIET_HELD')`.execute(
        tx,
      );
      await sql`UPDATE notification_deliveries SET status='SENT',provider_message_id=${messageId},last_error=NULL,updated_at=clock_timestamp() WHERE id=${context.deliveryId}::uuid AND status='CLAIMED' AND lease_token=${context.leaseToken}::uuid`.execute(
        tx,
      );
    });
    return 'SENT';
  }

  private async skip(context: DeliveryContext, reason: string): Promise<'SKIPPED'> {
    await this.db.transaction().execute(async (tx) => {
      if (!(await ownsLease(tx, context))) return;
      await sql`UPDATE notifications SET status='SKIPPED',error=${reason} WHERE id=${context.notificationId}::uuid AND status IN ('PENDING','QUIET_HELD')`.execute(
        tx,
      );
      await sql`UPDATE notification_deliveries SET status='FAILED',last_error=${reason},updated_at=clock_timestamp() WHERE id=${context.deliveryId}::uuid AND status='CLAIMED' AND lease_token=${context.leaseToken}::uuid`.execute(
        tx,
      );
    });
    return 'SKIPPED';
  }

  private async sendPush(
    context: DeliveryContext,
    now: Date,
    templates: readonly TemplateRow[],
  ): Promise<'SENT' | 'SKIPPED' | 'RETRY'> {
    if (!UUID.test(context.recipientId)) return this.skip(context, 'NO_ACTIVE_DEVICES');
    const campaignId =
      typeof context.payload['campaignId'] === 'string' && UUID.test(context.payload['campaignId'])
        ? context.payload['campaignId']
        : null;
    if (campaignId && context.class === 'PROMOTIONAL') {
      const pref = await sql<{
        enabled: boolean;
      }>`SELECT enabled FROM notification_preferences WHERE user_id=${context.recipientId}::uuid AND category='PROMOTIONS'`.execute(
        this.db,
      );
      if (pref.rows[0]?.enabled === false) return this.skip(context, 'PREFERENCE_DISABLED');
    }
    const campaignApp = context.payload['app'];
    const app =
      campaignId && ['CUSTOMER', 'RIDER', 'STORE', 'ADMIN'].includes(String(campaignApp))
        ? String(campaignApp)
        : context.templateKey.startsWith('rider.')
          ? 'RIDER'
          : context.templateKey.startsWith('store.')
            ? 'STORE'
            : context.templateKey.startsWith('admin.')
              ? 'ADMIN'
              : 'CUSTOMER';
    const tokens = await sql<{
      id: string;
      token: string;
      updated_at: string;
      identifier_type: 'FCM_TOKEN' | 'FID';
    }>`SELECT d.id,d.token,d.identifier_type,d.updated_at::text AS updated_at FROM device_tokens d LEFT JOIN notification_token_results r ON r.delivery_id=${context.deliveryId}::uuid AND r.token_id=d.id JOIN users u ON u.id=d.user_id WHERE d.user_id=${context.recipientId}::uuid AND u.status='ACTIVE' AND d.app=${app} AND d.active AND (r.status IS NULL OR r.status='RETRY') AND (${campaignId}::uuid IS NULL OR EXISTS (SELECT 1 FROM push_campaign_targets t WHERE t.campaign_id=${campaignId}::uuid AND t.notification_id=${context.notificationId}::uuid AND t.token_id=d.id AND t.user_id=d.user_id AND t.token_updated_at=d.updated_at)) ORDER BY d.id`.execute(
      this.db,
    );
    if (!tokens.rows.length) {
      const sent = await sql<{
        count: string;
      }>`SELECT count(*)::text AS count FROM notification_token_results WHERE delivery_id=${context.deliveryId}::uuid AND status='SENT'`.execute(
        this.db,
      );
      return Number(sent.rows[0]?.count ?? 0)
        ? this.complete(context, null)
        : this.skip(context, 'NO_ACTIVE_DEVICES');
    }
    const template = selectTemplate(
      templates,
      context.templateKey,
      'PUSH',
      context.locale as NotificationLocale,
    );
    const payload = {
      title:
        campaignId && typeof context.payload['title'] === 'string'
          ? context.payload['title']
          : template
            ? renderTemplate(template.subject, context.data)
            : 'Notification',
      body:
        campaignId && typeof context.payload['body'] === 'string'
          ? context.payload['body']
          : template
            ? renderTemplate(template.body, context.data)
            : '',
      deepLink: context.deepLink,
      ...(campaignId && typeof context.payload['imageUrl'] === 'string'
        ? { imageUrl: context.payload['imageUrl'] }
        : {}),
      data: {
        ...context.data,
        messageId: context.notificationId,
        notificationId: context.notificationId,
        collapseKey: context.notificationId,
      },
      priority: (context.payload['pushPriority'] as 'HIGH' | 'NORMAL') ?? 'NORMAL',
    };
    let retry = false;
    for (const identifierType of ['FCM_TOKEN', 'FID'] as const) {
      for (const selected of chunkBounded(
        tokens.rows.filter((row) => row.identifier_type === identifierType),
        500,
      )) {
        // Recheck the owner immediately before handing registrations to the provider.
        const current = await sql<{
          id: string;
          token: string;
          updated_at: string;
        }>`SELECT id,token,updated_at::text AS updated_at FROM device_tokens WHERE id=ANY(${selected.map((row) => row.id)}::uuid[]) AND user_id=${context.recipientId}::uuid AND app=${app} AND active`.execute(
          this.db,
        );
        const registrations = new Map(current.rows.map((row) => [row.id, row]));
        const batch = selected.filter((row) => {
          const registration = registrations.get(row.id);
          return registration?.token === row.token && registration.updated_at === row.updated_at;
        });
        if (!batch.length) continue;
        // A large fan-out may take longer than one lease; extend it before each bounded provider call.
        const lease = await sql<{
          id: string;
        }>`UPDATE notification_deliveries SET lease_until=clock_timestamp()+interval '2 minutes' WHERE id=${context.deliveryId}::uuid AND status='CLAIMED' AND lease_token=${context.leaseToken}::uuid AND lease_until>clock_timestamp() RETURNING id`.execute(
          this.db,
        );
        if (!lease.rows.length) return 'RETRY';
        const results: PushTokenResult[] = await this.push.send(
          batch.map((row) => row.token),
          payload,
          identifierType,
        );
        const byToken = new Map(results.map((result) => [result.token, result]));
        await this.db.transaction().execute(async (tx) => {
          if (!(await ownsLease(tx, context))) return;
          for (const device of batch) {
            const result = byToken.get(device.token);
            const status = result?.ok
              ? 'SENT'
              : result?.invalidToken
                ? 'INVALID'
                : result?.retryable === false
                  ? 'FAILED'
                  : 'RETRY';
            if (status === 'RETRY') retry = true;
            if (status === 'RETRY' && result?.retryAfterMs)
              context.retryAfterSeconds = Math.max(
                context.retryAfterSeconds ?? 0,
                Math.ceil(result.retryAfterMs / 1000),
              );
            await sql`INSERT INTO notification_token_results(delivery_id,token_id,status,provider_message_id,error) VALUES (${context.deliveryId}::uuid,${device.id}::uuid,${status},${result?.messageId ?? null},${result ? result.error : 'MISSING_PROVIDER_RESULT'}) ON CONFLICT (delivery_id,token_id) DO UPDATE SET status=EXCLUDED.status,provider_message_id=EXCLUDED.provider_message_id,error=EXCLUDED.error,updated_at=clock_timestamp()`.execute(
              tx,
            );
            if (status === 'INVALID')
              await sql`UPDATE device_tokens SET active=false,updated_at=${now.toISOString()}::timestamptz WHERE id=${device.id}::uuid AND token=${device.token} AND user_id=${context.recipientId}::uuid AND app=${app} AND updated_at=${device.updated_at}::timestamptz`.execute(
                tx,
              );
          }
        });
      }
    }
    if (retry) return 'RETRY';
    const sent = await sql<{
      count: string;
    }>`SELECT count(*)::text AS count FROM notification_token_results WHERE delivery_id=${context.deliveryId}::uuid AND status='SENT'`.execute(
      this.db,
    );
    return Number(sent.rows[0]?.count ?? 0)
      ? this.complete(context, null)
      : this.skip(context, 'NO_DELIVERABLE_TOKENS');
  }

  private async sendEmail(
    context: DeliveryContext,
    templates: readonly TemplateRow[],
  ): Promise<'SENT' | 'SKIPPED'> {
    if (!UUID.test(context.recipientId)) return this.skip(context, 'NO_EMAIL_ADDRESS');
    const rows = await sql<{
      email: string | null;
    }>`SELECT normalized_email AS email FROM users WHERE id=${context.recipientId}::uuid AND status='ACTIVE'`.execute(
      this.db,
    );
    const address = rows.rows[0]?.email;
    if (!address) return this.skip(context, 'NO_EMAIL_ADDRESS');
    const template = selectTemplate(
      templates,
      context.templateKey,
      'EMAIL',
      context.locale as NotificationLocale,
    );
    if (!template) return this.skip(context, 'TEMPLATE_MISSING');
    const result = await this.email.send({
      to: address,
      messageId: context.notificationId,
      subject: renderTemplate(template.subject, context.data),
      body: renderTemplate(template.body, context.data),
    });
    return this.complete(context, result.messageId);
  }
}

/** Records a failed attempt with bounded jittered backoff; terminal at the cap. */
export async function recordSendFailure(
  tx: TransactionContext,
  context: DeliveryContext,
  attempts: number,
  lastError: string,
  nextRetrySeconds: number,
  maxAttempts: number,
): Promise<'RETRY' | 'FAILED'> {
  if (!(await ownsLease(tx, context))) return 'RETRY';
  const terminal = attempts >= maxAttempts;
  await sql`UPDATE notification_deliveries SET ambiguous_sends=ambiguous_sends+1,last_error=${lastError.slice(0, 300)},
      next_retry_at=clock_timestamp()+${nextRetrySeconds}*interval '1 second',
      status=${terminal ? 'FAILED' : 'PENDING'},updated_at=clock_timestamp()
    WHERE id=${context.deliveryId}::uuid AND status='CLAIMED' AND lease_token=${context.leaseToken}::uuid`.execute(
    tx,
  );
  if (terminal)
    await sql`UPDATE notifications SET status='FAILED',error=${lastError.slice(0, 300)} WHERE id=${context.notificationId}::uuid AND status IN ('PENDING','QUIET_HELD')`.execute(
      tx,
    );
  return terminal ? 'FAILED' : 'RETRY';
}

async function ownsLease(tx: TransactionContext, context: DeliveryContext): Promise<boolean> {
  const row = await sql<{
    id: string;
  }>`SELECT id FROM notification_deliveries WHERE id=${context.deliveryId}::uuid AND status='CLAIMED' AND lease_token=${context.leaseToken}::uuid AND lease_until>clock_timestamp() FOR UPDATE`.execute(
    tx,
  );
  return row.rows.length > 0;
}
