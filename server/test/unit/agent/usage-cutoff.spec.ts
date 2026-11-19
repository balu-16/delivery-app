import { countedTokenWindowStart } from '../../../src/modules/agent/infrastructure/usage-cutoff.js';

describe('assistant usage cutoff', () => {
  const dayStart = new Date('2026-11-19T00:00:00+05:30');

  test('counts tokens from the day start without a cutoff', () => {
    expect(countedTokenWindowStart(dayStart, null).toISOString()).toBe(dayStart.toISOString());
  });

  test('zeroes counted tokens after a same-day reset while turns keep counting', () => {
    const cutoff = new Date('2026-11-19T13:25:21Z');
    expect(countedTokenWindowStart(dayStart, cutoff).toISOString()).toBe(cutoff.toISOString());
  });

  test('a cutoff from yesterday expires at midnight IST', () => {
    const yesterday = new Date('2026-11-18T10:00:00Z');
    expect(countedTokenWindowStart(dayStart, yesterday).toISOString()).toBe(dayStart.toISOString());
  });
});
