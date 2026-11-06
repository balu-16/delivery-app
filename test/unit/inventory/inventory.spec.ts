import { eligible, quantity } from '../../../src/modules/inventory/domain/quantity.js';
import { InventoryWorker } from '../../../src/modules/inventory/infrastructure/worker.js';
import type { InventoryExpiry } from '../../../src/modules/inventory/infrastructure/expiry.js';
test('whole-unit validation uses bigint bounds and never rounds', () => {
  expect(quantity('9223372036854775807')).toBe(9223372036854775807n);
  for (const bad of ['1.5', '-1', '00', '9223372036854775808', '0'])
    expect(() => quantity(bad)).toThrow('INVALID_QUANTITY');
  expect(quantity('0', true)).toBe(0n);
  expect(eligible(new Date('2030-01-01T01:00:00Z'), new Date('2030-01-01T00:00:00Z'), 3600)).toBe(
    false,
  );
  expect(eligible(new Date('2030-01-01T01:00:01Z'), new Date('2030-01-01T00:00:00Z'), 3600)).toBe(
    true,
  );
});
test('worker drains active maintenance before application shutdown', async () => {
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const entered = new Promise<void>((r) => {
    started = r;
  });
  let drained = false;
  const expiry = {
    expireHolds: async () => {
      started();
      await gate;
      return 0;
    },
    writeOffExpired: async () => 0,
    emitDueAlerts: async () => 0,
  } as unknown as InventoryExpiry;
  const worker = new InventoryWorker(expiry);
  worker.onApplicationBootstrap();
  await entered;
  const stopped = worker.beforeApplicationShutdown().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  release();
  await stopped;
  expect(drained).toBe(true);
});
test('reservation transitions treat equality as expired and never expire committed stock', async () => {
  const { canTransition } =
    await import('../../../src/modules/inventory/domain/reservation-policy.js');
  const now = new Date('2030-01-01T00:00:00Z'),
    future = new Date('2030-01-01T00:00:01Z');
  expect(canTransition('HELD', 'COMMIT', future, now)).toBe(true);
  expect(canTransition('HELD', 'COMMIT', now, now)).toBe(false);
  expect(canTransition('HELD', 'EXPIRE', now, now)).toBe(true);
  expect(canTransition('COMMITTED', 'EXPIRE', null, now)).toBe(false);
  expect(canTransition('COMMITTED', 'PICK', null, now)).toBe(true);
  expect(canTransition('RESOLVED', 'RELEASE', null, now)).toBe(false);
});
