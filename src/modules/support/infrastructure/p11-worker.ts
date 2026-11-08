import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { sql } from 'kysely';
import { uuidV7 } from '../../../common/ids/ids.js';
import { PLATFORM_CONCERN_QUEUES, PLATFORM_DATABASE } from '../../../platform/contracts/runtime.js';
import type { DatabaseHandle } from '../../../platform/database/database.js';
import type { ConcernQueues } from '../../../platform/queue/concern-queues.js';
import { appendEvent } from '../../../platform/outbox/outbox.js';
import { APP_CONFIG, type AppConfig } from '../../app-config/contracts/config.js';
import { PAYOUTS, type Payouts } from '../../payouts/contracts/payouts.js';
/** Durable database scans recover missed scheduler executions and dedupe incidents/alerts. */
@Injectable()
export class P11Worker implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;
  private active?: Promise<void>;
  private readonly logger = new Logger(P11Worker.name);
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly handle: DatabaseHandle,
    @Inject(PLATFORM_CONCERN_QUEUES) private readonly queue: ConcernQueues,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PAYOUTS) private readonly payouts: Payouts,
  ) {}
  async onApplicationBootstrap(): Promise<void> {
    this.queue.register('maintenance', 'p11-scan', async () => {
      await this.scan();
    });
    await this.queue.upsertScheduler(
      'maintenance',
      'p11-recovery',
      'p11-scan',
      {},
      { everyMs: 60000 },
    );
    this.timer = setInterval(
      () => void this.scan().catch(() => this.logger.error('P11 recovery failed')),
      60000,
    );
    this.timer.unref();
    void this.scan().catch(() => this.logger.error('P11 recovery failed'));
  }
  private scan(): Promise<void> {
    if (this.active) return this.active;
    this.active = (async () => {
      await this.incidents();
      await this.alerts();
      await this.payoutDrafts();
    })().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.active?.catch(() => undefined);
  }
  async incidents(): Promise<void> {
    const first = await this.config.get('supportFirstResponseSlaHours'),
      resolution = await this.config.get('supportResolutionSlaHours');
    await this.handle.db.transaction().execute(async (tx) => {
      // Lock active accounts in a consistent order, fencing erasure before creating incidents.
      const owners = await sql<{
        id: string;
      }>`SELECT u.id FROM users u WHERE u.status='ACTIVE' AND (
        EXISTS(SELECT 1 FROM orders o JOIN delivery_tasks d ON d.order_id=o.id WHERE o.user_id=u.id AND d.status='FAILED' AND NOT EXISTS(SELECT 1 FROM support_tickets t WHERE t.incident_key='delivery:'||d.id::text)) OR
        EXISTS(SELECT 1 FROM orders o JOIN payment_attempts p ON p.order_id=o.id JOIN reconciliation_findings f ON f.aggregate_type='payment_attempt' AND f.aggregate_id=p.id::text WHERE o.user_id=u.id AND f.kind IN ('POLL_PAYMENT_MISMATCH','GATEWAY_CAPTURE_MISMATCH') AND NOT EXISTS(SELECT 1 FROM support_tickets t WHERE t.incident_key='payment-finding:'||f.id::text))
        ) ORDER BY u.id FOR UPDATE OF u SKIP LOCKED LIMIT 100`.execute(tx);
      const ownerIds = owners.rows.map((row) => row.id);
      if (!ownerIds.length) return;
      await sql`INSERT INTO support_tickets(id,owner_id,order_id,category,status,incident_key,first_response_due_at,resolution_due_at)
    SELECT gen_random_uuid(),o.user_id,o.id,'DELIVERY_FAILED','OPEN','delivery:'||d.id::text,clock_timestamp()+${first}*interval '1 hour',clock_timestamp()+${resolution}*interval '1 hour'
    FROM delivery_tasks d JOIN orders o ON o.id=d.order_id WHERE o.user_id=ANY(${ownerIds}::uuid[]) AND d.status='FAILED' AND NOT EXISTS(SELECT 1 FROM support_tickets t WHERE t.incident_key='delivery:'||d.id::text) ORDER BY d.updated_at,d.id LIMIT 100 ON CONFLICT(incident_key) DO NOTHING`.execute(
        tx,
      );
      await sql`INSERT INTO support_tickets(id,owner_id,order_id,category,status,incident_key,first_response_due_at,resolution_due_at)
    SELECT gen_random_uuid(),o.user_id,o.id,'PAYMENT_MISMATCH','OPEN','payment-finding:'||f.id::text,clock_timestamp()+${first}*interval '1 hour',clock_timestamp()+${resolution}*interval '1 hour'
    FROM reconciliation_findings f JOIN payment_attempts p ON f.aggregate_type='payment_attempt' AND p.id::text=f.aggregate_id JOIN orders o ON o.id=p.order_id
    WHERE o.user_id=ANY(${ownerIds}::uuid[]) AND f.kind IN ('POLL_PAYMENT_MISMATCH','GATEWAY_CAPTURE_MISMATCH') AND NOT EXISTS(SELECT 1 FROM support_tickets t WHERE t.incident_key='payment-finding:'||f.id::text) ORDER BY f.created_at,f.id LIMIT 100 ON CONFLICT(incident_key) DO NOTHING`.execute(
        tx,
      );
    });
  }
  async alerts(): Promise<void> {
    await this.handle.db.transaction().execute(async (tx) => {
      const rows = await sql<{
        id: string;
        kind: string;
        sla_cycle: number;
      }>`SELECT t.id,t.sla_cycle,CASE WHEN t.first_response_at IS NULL AND t.first_response_due_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM support_sla_alerts a WHERE a.ticket_id=t.id AND a.cycle=t.sla_cycle AND a.kind='FIRST_RESPONSE') THEN 'FIRST_RESPONSE' ELSE 'RESOLUTION' END AS kind
   FROM support_tickets t WHERE t.status IN ('OPEN','IN_PROGRESS') AND ((t.first_response_at IS NULL AND t.first_response_due_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM support_sla_alerts a WHERE a.ticket_id=t.id AND a.cycle=t.sla_cycle AND a.kind='FIRST_RESPONSE')) OR (t.resolution_due_at<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM support_sla_alerts a WHERE a.ticket_id=t.id AND a.cycle=t.sla_cycle AND a.kind='RESOLUTION'))) ORDER BY t.created_at,t.id FOR UPDATE SKIP LOCKED LIMIT 100`.execute(
        tx,
      );
      for (const row of rows.rows) {
        const inserted =
          await sql`INSERT INTO support_sla_alerts(ticket_id,cycle,kind) VALUES(${row.id}::uuid,${row.sla_cycle},${row.kind}) ON CONFLICT DO NOTHING RETURNING ticket_id`.execute(
            tx,
          );
        if (!inserted.rows.length) continue;
        await appendEvent(
          tx,
          {
            eventId: uuidV7(),
            eventType: 'ops.anomaly',
            schemaVersion: 1,
            aggregateType: 'support_ticket',
            aggregateId: row.id,
            aggregateVersion: String(row.sla_cycle * 2 - (row.kind === 'FIRST_RESPONSE' ? 1 : 0)),
            occurredAt: new Date().toISOString(),
            correlationId: row.id,
            causationId: null,
            payload: { kind: 'SUPPORT_SLA_BREACH', ticketId: row.id, stage: row.kind },
          },
          ['notifications'],
        );
      }
    });
  }
  async payoutDrafts(): Promise<void> {
    const result = await sql<{
      cutoff: Date;
    }>`SELECT date_trunc('week',clock_timestamp() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata' AS cutoff`.execute(
      this.handle.db,
    );
    const cutoff = result.rows[0]?.cutoff;
    if (!cutoff) return;
    const riders = await sql<{
      rider_id: string;
    }>`SELECT DISTINCT e.rider_id FROM rider_earnings e JOIN users u ON u.id=e.rider_id AND u.status='ACTIVE' WHERE e.computed_at<${cutoff.toISOString()}::timestamptz AND e.payout_reference IS NULL AND NOT EXISTS(SELECT 1 FROM payout_earning_claims c WHERE c.earning_id=e.id AND c.active) AND NOT EXISTS(SELECT 1 FROM rider_payouts p WHERE p.rider_id=e.rider_id AND p.state='DRAFT') AND NOT EXISTS(SELECT 1 FROM rider_payouts p JOIN payout_batches b ON b.id=p.batch_id WHERE p.rider_id=e.rider_id AND b.cutoff=${cutoff.toISOString()}::timestamptz AND p.state<>'CANCELLED') ORDER BY e.rider_id LIMIT 100`.execute(
      this.handle.db,
    );
    for (const row of riders.rows) {
      try {
        await this.payouts.draft(row.rider_id, cutoff.toISOString());
      } catch {
        this.logger.error(`Payout draft failed for rider ${row.rider_id}`);
      }
    }
  }
}
