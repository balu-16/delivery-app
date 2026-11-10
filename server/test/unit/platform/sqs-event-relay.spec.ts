import { jest } from '@jest/globals';
import type { Database } from '../../../src/platform/database/database.js';
import type { ClaimedDelivery } from '../../../src/platform/outbox/outbox.js';
import { SqsEventQueue } from '../../../src/platform/queue/sqs-event-queue.js';
import type { SqsTransport } from '../../../src/platform/queue/sqs-transport.js';

function deliveries(count: number): ClaimedDelivery[] {
  return Array.from({ length: count }, (_, i) => ({
    token: '00000000-0000-7000-8000-000000000001',
    consumer: 'orders',
    event: {
      eventId: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
      eventType: 'test.event',
      schemaVersion: 1,
      aggregateType: 'test',
      aggregateId: '00000000-0000-7000-8000-000000000002',
      aggregateVersion: '1',
      occurredAt: '2026-01-01T00:00:00.000Z',
      correlationId: 'test',
      causationId: null,
      payload: {},
    },
  }));
}

it('publishes claimed events concurrently with a bounded number of sends', async () => {
  let active = 0;
  let peak = 0;
  const send = jest.fn(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
  });
  const queue = new SqsEventQueue({
    db: {} as Database,
    transport: { send } as unknown as SqsTransport,
  });
  const claimed = deliveries(25);
  jest.spyOn(queue.outbox, 'claim').mockResolvedValue(claimed);
  const acknowledge = jest.spyOn(queue.outbox, 'acknowledge').mockResolvedValue(true);
  const fail = jest.spyOn(queue.outbox, 'fail').mockResolvedValue();
  expect(await queue.recoverOnce()).toBe(25);
  expect(send).toHaveBeenCalledTimes(25);
  expect(acknowledge).toHaveBeenCalledTimes(25);
  expect(fail).not.toHaveBeenCalled();
  expect(peak).toBeGreaterThan(1);
  expect(peak).toBeLessThanOrEqual(10);
});

it('stops starting new sends after failure and releases all unacknowledged claims', async () => {
  const send = jest.fn(async () => {
    if (send.mock.calls.length === 1) throw new Error('transport unavailable');
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const queue = new SqsEventQueue({
    db: {} as Database,
    transport: { send } as unknown as SqsTransport,
  });
  const claimed = deliveries(25);
  jest.spyOn(queue.outbox, 'claim').mockResolvedValue(claimed);
  const acknowledge = jest.spyOn(queue.outbox, 'acknowledge').mockResolvedValue(true);
  const fail = jest.spyOn(queue.outbox, 'fail').mockResolvedValue();
  expect(await queue.recoverOnce()).toBe(25);
  expect(send.mock.calls.length).toBeLessThanOrEqual(10);
  const acknowledged = acknowledge.mock.calls.map(([item]) => item);
  const released = fail.mock.calls.map(([item]) => item);
  expect(new Set([...acknowledged, ...released])).toEqual(new Set(claimed));
  expect(acknowledged.some((item) => released.includes(item))).toBe(false);
  expect(queue.stats().relayFailures).toBeGreaterThan(0);
});

it('releases a claim when a sent event cannot be acknowledged', async () => {
  const send = jest.fn(async () => undefined);
  const queue = new SqsEventQueue({
    db: {} as Database,
    transport: { send } as unknown as SqsTransport,
  });
  const [claimed] = deliveries(1);
  jest.spyOn(queue.outbox, 'claim').mockResolvedValue([claimed!]);
  jest.spyOn(queue.outbox, 'acknowledge').mockRejectedValue(new Error('database unavailable'));
  const fail = jest.spyOn(queue.outbox, 'fail').mockResolvedValue();
  expect(await queue.recoverOnce()).toBe(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(fail).toHaveBeenCalledWith(claimed);
  expect(queue.stats().relayFailures).toBe(1);
});
