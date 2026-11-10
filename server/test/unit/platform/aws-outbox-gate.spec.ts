import { outboxGatePasses, type OutboxResult } from '../../load/aws-outbox-gate.js';

const completed: OutboxResult = {
  completed: '6',
  processed: '6',
  backlog: '0',
  suspended: '0',
  p50: 500,
  p95: 2000,
  p99: 2400,
};
const valid = {
  profile: 'local' as const,
  expected: 6,
  generated: 6,
  result: completed,
  interruptedBacklog: 1,
  errors: [] as string[],
};

it('requires complete, exactly-once recovery and an eligible p95 within the local target', () => {
  expect(outboxGatePasses(valid)).toBe(true);
  expect(outboxGatePasses({ ...valid, generated: 5 })).toBe(false);
  expect(outboxGatePasses({ ...valid, result: { ...completed, processed: '5' } })).toBe(false);
  expect(outboxGatePasses({ ...valid, result: { ...completed, backlog: '1' } })).toBe(false);
  expect(outboxGatePasses({ ...valid, result: { ...completed, suspended: '1' } })).toBe(false);
  expect(outboxGatePasses({ ...valid, result: { ...completed, p95: null } })).toBe(false);
  expect(outboxGatePasses({ ...valid, result: { ...completed, p95: 2001 } })).toBe(false);
  expect(outboxGatePasses({ ...valid, interruptedBacklog: 0 })).toBe(false);
  expect(outboxGatePasses({ ...valid, errors: ['worker failed'] })).toBe(false);
});

it('allows missing latency samples only for the explicitly non-acceptance smoke profile', () => {
  expect(
    outboxGatePasses({ ...valid, profile: 'smoke', result: { ...completed, p95: null } }),
  ).toBe(true);
  expect(
    outboxGatePasses({ ...valid, profile: 'smoke', result: { ...completed, processed: '5' } }),
  ).toBe(false);
});
