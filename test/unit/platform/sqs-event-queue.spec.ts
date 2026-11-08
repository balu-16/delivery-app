import { eventPointer } from '../../../src/platform/queue/sqs-event-queue.js';

test('event pointers are deterministic and distinguish consumers without including event payloads', () => {
  const eventId = '01800000-0000-7000-8000-000000000001';
  const a = eventPointer(eventId, 'notifications');
  expect(a).toEqual(eventPointer(eventId, 'notifications'));
  expect(a.jobId).not.toBe(eventPointer(eventId, 'payments').jobId);
  expect(a.jobId).toMatch(/^01800000-0000-7000-8000-000000000001-[0-9a-f]{64}$/);
  expect(a).toEqual({ version: 1, jobId: a.jobId, generation: 1 });
});

test.each([
  ['invalid', 'consumer'],
  ['01800000-0000-7000-8000-000000000001', ''],
])('rejects malformed event pointers', (eventId, consumer) =>
  expect(() => eventPointer(eventId, consumer)).toThrow('INVALID_EVENT_POINTER'),
);
