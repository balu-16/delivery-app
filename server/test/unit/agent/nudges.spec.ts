import { jest } from '@jest/globals';
import type { Database } from '../../../src/platform/database/database.js';
import type { AppConfig } from '../../../src/modules/app-config/contracts/config.js';
import {
  AgentNudges,
  isReorderDue,
  medianIntervalMs,
  selectReorderCandidates,
  utcWeekStart,
  type PurchaseHistory,
} from '../../../src/modules/agent/infrastructure/nudges.js';
import { createNudgeTools } from '../../../src/modules/agent/infrastructure/nudge-tools.js';
import { AgentToolKit } from '../../../src/modules/agent/infrastructure/tool-kit.js';

const DAY = 24 * 60 * 60 * 1000;
const base = new Date('2026-01-05T10:00:00.000Z'); // a Monday
const daysAgo = (...offsets: number[]): Date[] =>
  offsets.map((offset) => new Date(base.getTime() - offset * DAY));
const historyOf = (variantId: string, dates: Date[], name = 'Toned Milk'): PurchaseHistory => ({
  name,
  dates,
});

test('median interval handles odd and even gap counts', () => {
  // Three purchases → two gaps (even): average of the middle pair.
  expect(medianIntervalMs(daysAgo(3, 5, 9))).toBe(3 * DAY);
  // Four purchases → three gaps (odd): middle gap.
  expect(medianIntervalMs(daysAgo(1, 3, 9, 10))).toBe(2 * DAY);
  expect(medianIntervalMs([base])).toBeNull();
  expect(medianIntervalMs([])).toBeNull();
});

test('a variant is due once 0.8× the median cadence has elapsed', () => {
  const lastPurchase = daysAgo(10)[0]!;
  const median = 10 * DAY;
  expect(isReorderDue(lastPurchase, median, new Date(base.getTime() - 2 * DAY))).toBe(true);
  expect(isReorderDue(lastPurchase, median, new Date(base.getTime() - 2 * DAY - 1))).toBe(false);
});

test('candidates respect cart, active-order, cadence and budget suppressions', () => {
  const history = new Map([
    ['v-cart', historyOf('v-cart', daysAgo(10, 20, 30))],
    ['v-active', historyOf('v-active', daysAgo(10, 20, 30))],
    ['v-not-due', historyOf('v-not-due', daysAgo(2, 12, 22))],
    ['v-bunched', historyOf('v-bunched', daysAgo(2, 2, 2))],
    ['v-under', historyOf('v-under', daysAgo(10, 20))],
    ['v-old', historyOf('v-old', daysAgo(15, 25, 35), 'Old Milk')],
    ['v-due', historyOf('v-due', daysAgo(10, 20, 30))],
  ]);
  const pick = (limit: number) =>
    selectReorderCandidates({
      history,
      cartVariantIds: new Set(['v-cart']),
      activeVariantIds: new Set(['v-active']),
      now: base,
      limit,
    });
  // Under three purchases, zero cadence, not yet due, in cart, active order.
  expect(pick(10)).toEqual([
    { variantId: 'v-old', productName: 'Old Milk', lastPurchase: daysAgo(15)[0]! },
    { variantId: 'v-due', productName: 'Toned Milk', lastPurchase: daysAgo(10)[0]! },
  ]);
  // Most overdue first; the weekly budget caps the batch size.
  expect(pick(1)).toEqual([
    { variantId: 'v-old', productName: 'Old Milk', lastPurchase: daysAgo(15)[0]! },
  ]);
  expect(pick(0)).toEqual([]);
});

test('the weekly budget window starts Monday 00:00 UTC', () => {
  expect(utcWeekStart(new Date('2026-01-05T10:00:00.000Z'))).toEqual(
    new Date('2026-01-05T00:00:00.000Z'),
  );
  expect(utcWeekStart(new Date('2026-01-11T23:59:59.000Z'))).toEqual(
    new Date('2026-01-05T00:00:00.000Z'),
  );
  expect(utcWeekStart(new Date('2026-01-04T23:59:59.000Z'))).toEqual(
    new Date('2025-12-29T00:00:00.000Z'),
  );
});

test('the sweep is a no-op while the global kill switch is off', async () => {
  const config = { get: jest.fn(async () => false) } as unknown as AppConfig;
  const nudges = new AgentNudges(
    {} as Database,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    config,
  );
  await expect(nudges.runSweep(new Date())).resolves.toEqual({ checked: 0, sent: 0 });
});

test('setPreference rejects malformed tool call ids before touching the database', async () => {
  const nudges = new AgentNudges(
    {} as Database,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as unknown as AppConfig,
  );
  await expect(nudges.setPreference('user', true, 'thread', '')).rejects.toThrow('INVALID_INPUT');
  await expect(nudges.setPreference('user', true, 'thread', 'x'.repeat(201))).rejects.toThrow(
    'INVALID_INPUT',
  );
});

test('set_reorder_nudges registers one tool that forwards the tool call id', async () => {
  const setPreference = jest.fn(async () => ({ enabled: true }));
  const nudges = { setPreference } as unknown as AgentNudges;
  const tools = createNudgeTools(
    { nudges },
    { userId: 'user', threadId: 'thread' },
    new AgentToolKit(5),
  );
  expect(tools).toHaveLength(1);
  const tool = tools[0]!;
  expect(tool.name).toBe('set_reorder_nudges');
  expect(tool.description).toContain('restock reminders');
  const runtime = { toolCallId: 'call-1' } as unknown as Parameters<typeof tool.invoke>[1];
  const result = await tool.invoke({ enabled: true }, runtime);
  expect(JSON.parse(result)).toEqual({ ok: true, data: { enabled: true } });
  expect(setPreference).toHaveBeenCalledWith('user', true, 'thread', 'call-1');
});
