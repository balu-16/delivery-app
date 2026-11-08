import { jest } from '@jest/globals';
import { ConfigService } from '../../../src/config/config.service.js';
import { readEnv } from '../../../src/config/env.schema.js';
import { HealthController } from '../../../src/platform/health/health.controller.js';

test('allows dependencies to become ready within the configured cloud timeout', async () => {
  jest.useFakeTimers();
  try {
    let complete!: () => void;
    const probe = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const controller = new HealthController(
      [{ name: 'aws', check: () => probe }],
      new ConfigService(readEnv({ READINESS_TIMEOUT_MS: '15000' })),
    );
    const ready = controller.ready();
    await jest.advanceTimersByTimeAsync(5000);
    complete();
    await expect(ready).resolves.toEqual({ status: 'ok' });
  } finally {
    jest.useRealTimers();
  }
});

test('still fails readiness when dependencies exceed the configured timeout', async () => {
  jest.useFakeTimers();
  try {
    const controller = new HealthController(
      [{ name: 'aws', check: () => new Promise<void>(() => undefined) }],
      new ConfigService(readEnv({ READINESS_TIMEOUT_MS: '4000' })),
    );
    const failure = expect(controller.ready()).rejects.toThrow('Service Unavailable');
    await jest.advanceTimersByTimeAsync(4000);
    await failure;
  } finally {
    jest.useRealTimers();
  }
});
