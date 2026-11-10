import type { FastifyReply } from 'fastify';
import type { ConfigService } from '../../../src/config/config.service.js';
import type { DatabaseHandle } from '../../../src/platform/database/database.js';
import { HttpMetrics } from '../../../src/platform/metrics/http-metrics.js';
import { MetricsController } from '../../../src/platform/metrics/metrics.controller.js';
import { OutboxStore } from '../../../src/platform/outbox/outbox.js';
import type { ConcernQueues } from '../../../src/platform/queue/concern-queues.js';
import type { DurableQueue } from '../../../src/platform/queue/queue.js';

it('renders bounded database obligations and queue depths and protects the scrape', async () => {
  const original = OutboxStore.prototype.metrics;
  let lookups = 0;
  OutboxStore.prototype.metrics = async () => {
    lookups++;
    return { pending: 3, suspended: 1, oldestSeconds: 12.5 };
  };
  try {
    const config = { get: () => 'secret' } as unknown as ConfigService;
    const db = {
      db: {},
      stats: () => ({ total: 3, idle: 1, waiting: 2 }),
    } as unknown as DatabaseHandle;
    const queue = {
      stats: () => ({
        relayClaims: 4,
        relayFailures: 1,
        jobsCompleted: 2,
        jobsFailed: 1,
        recovering: false,
      }),
      depths: async () => ({ waiting: 2, active: 1, delayed: 0, failed: 0 }),
    } as unknown as DurableQueue;
    const concerns = {
      depths: async () => [
        { concern: 'notifications', waiting: 3, active: 0, delayed: 1, failed: 2 },
      ],
    } as unknown as ConcernQueues;
    let body = '';
    const reply = {
      type: () => reply,
      send: (value: string) => {
        body = value;
      },
    } as unknown as FastifyReply;
    const controller = new MetricsController(config, new HttpMetrics(), db, queue, concerns);
    await expect(controller.metrics('Bearer wrong', reply)).rejects.toThrow();
    expect(lookups).toBe(0);
    await controller.metrics('Bearer secret', reply);
    expect(body).toContain('delivery_outbox_obligations{state="pending"} 3');
    expect(body).toContain('delivery_outbox_obligations{state="suspended"} 1');
    expect(body).toContain('delivery_outbox_oldest_pending_seconds 12.5');
    expect(body).toContain(
      'delivery_concern_queue_depth{concern="notifications",state="waiting"} 3',
    );
    expect(body).toContain('delivery_queue_depth{state="waiting"} 2');
  } finally {
    OutboxStore.prototype.metrics = original;
  }
});
