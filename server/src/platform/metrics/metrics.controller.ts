import { Controller, Get, Headers, Inject, NotFoundException, Optional, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { ConfigService } from '../../config/config.service.js';
import {
  PLATFORM_CONCERN_QUEUES,
  PLATFORM_DATABASE,
  PLATFORM_QUEUE,
} from '../contracts/runtime.js';
import type { DatabaseHandle } from '../database/database.js';
import { OutboxStore } from '../outbox/outbox.js';
import type { ConcernQueues } from '../queue/concern-queues.js';
import type { DurableQueue } from '../queue/queue.js';
import { HttpMetrics } from './http-metrics.js';

@ApiExcludeController()
@Controller()
export class MetricsController {
  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpMetrics,
    @Optional() @Inject(PLATFORM_DATABASE) private readonly database?: DatabaseHandle,
    @Optional() @Inject(PLATFORM_QUEUE) private readonly queue?: DurableQueue,
    @Optional() @Inject(PLATFORM_CONCERN_QUEUES) private readonly concerns?: ConcernQueues,
  ) {}
  @Get('metrics') async metrics(
    @Headers('authorization') authorization: string | undefined,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const token = this.config.get('METRICS_BEARER_TOKEN');
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(authorization ?? '');
    if (!token || expected.length !== actual.length || !timingSafeEqual(expected, actual))
      throw new NotFoundException();
    const pool = this.database?.stats();
    const queue = this.queue?.stats();
    const lines = pool
      ? [
          '# TYPE delivery_db_pool_connections gauge',
          `delivery_db_pool_connections{state="total"} ${pool.total}`,
          `delivery_db_pool_connections{state="idle"} ${pool.idle}`,
          `delivery_db_pool_connections{state="waiting"} ${pool.waiting}`,
        ]
      : [];
    if (queue)
      lines.push(
        '# TYPE delivery_outbox_claimed_total counter',
        `delivery_outbox_claimed_total ${queue.relayClaims}`,
        '# TYPE delivery_outbox_relay_errors_total counter',
        `delivery_outbox_relay_errors_total ${queue.relayFailures}`,
        '# TYPE delivery_queue_jobs_total counter',
        `delivery_queue_jobs_total{result="completed"} ${queue.jobsCompleted}`,
        `delivery_queue_jobs_total{result="failed"} ${queue.jobsFailed}`,
        '# TYPE delivery_outbox_recovery_active gauge',
        `delivery_outbox_recovery_active ${Number(queue.recovering)}`,
      );
    if (this.queue) {
      // Scrapes remain available when transport is unavailable; producer commands have a deadline.
      try {
        const depths = await this.queue.depths();
        lines.push('# TYPE delivery_queue_depth gauge');
        for (const state of ['waiting', 'active', 'delayed', 'failed'] as const)
          lines.push(`delivery_queue_depth{state="${state}"} ${depths[state]}`);
      } catch {
        /* readiness reports the unavailable transport */
      }
    }
    if (this.database) {
      try {
        const data = await new OutboxStore(this.database.db).metrics();
        lines.push(
          '# TYPE delivery_outbox_obligations gauge',
          `delivery_outbox_obligations{state="pending"} ${data.pending}`,
          `delivery_outbox_obligations{state="suspended"} ${data.suspended}`,
          '# TYPE delivery_outbox_oldest_pending_seconds gauge',
          `delivery_outbox_oldest_pending_seconds ${data.oldestSeconds}`,
        );
      } catch {
        /* readiness reports database unavailability */
      }
    }
    if (this.concerns) {
      try {
        const depths = await this.concerns.depths();
        lines.push('# TYPE delivery_concern_queue_depth gauge');
        for (const depth of depths)
          for (const state of ['waiting', 'active', 'delayed', 'failed'] as const)
            lines.push(
              `delivery_concern_queue_depth{concern="${depth.concern}",state="${state}"} ${depth[state]}`,
            );
      } catch {
        /* readiness reports queue unavailability */
      }
    }
    reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(this.http.render() + (lines.length ? `${lines.join('\n')}\n` : ''));
  }
}
