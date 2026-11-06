import { gatewayMoneyNumber, moneyString, parseMoney } from '../../../src/common/money/money.js';
import { SystemIdGenerator, SystemRandom, uuidV7 } from '../../../src/common/ids/ids.js';
import { decideTransition, transition } from '../../../src/common/state-machine/state-machine.js';
import { FixedClock } from '../../../src/common/time/clock.js';

describe('P0 pure primitives', () => {
  it('round trips canonical integer money and rejects unsafe gateway numbers', () => {
    expect(moneyString(parseMoney('9223372036854775807'))).toBe('9223372036854775807');
    for (const value of ['1.2', '01', '-0', '-1', '9223372036854775808'])
      expect(() => parseMoney(value)).toThrow();
    expect(() => gatewayMoneyNumber(9007199254740992n)).toThrow('UNSAFE_GATEWAY_AMOUNT');
    expect(gatewayMoneyNumber(500n)).toBe(500);
  });
  it('generates RFC 9562 version 7 identifiers with timestamp ordering', () => {
    const a = uuidV7(1_700_000_000_000);
    const b = uuidV7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, () => uuidV7(1_700_000_000_000))).size).toBe(1000);
    expect(new SystemIdGenerator().newId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(new SystemRandom().int(5, 6)).toBe(5);
  });
  it('enforces transitions and does not expose mutable test clock state', () => {
    const allowed = { NEW: ['DONE'], DONE: [] } as const;
    expect(transition('NEW', 'DONE', allowed)).toBe('DONE');
    expect(() => transition('DONE', 'NEW', allowed)).toThrow('INVALID_STATE_TRANSITION');
    const clock = new FixedClock(new Date('2026-01-01T00:00:00Z'));
    clock.now().setFullYear(2000);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });
  it('applies actor and guard checks and returns pure event intent', () => {
    const rules = [
      {
        from: 'NEW',
        to: 'DONE',
        actors: ['worker'],
        guard: (context: { ready: boolean }) => context.ready,
        events: () => ['done'],
      },
    ];
    expect(decideTransition('NEW', 'DONE', 'worker', { ready: true }, rules)).toEqual({
      state: 'DONE',
      events: ['done'],
    });
    expect(() => decideTransition('NEW', 'DONE', 'customer', { ready: true }, rules)).toThrow(
      'ILLEGAL_STATE_TRANSITION',
    );
    expect(() => decideTransition('NEW', 'DONE', 'worker', { ready: false }, rules)).toThrow(
      'ILLEGAL_STATE_TRANSITION',
    );
    expect(() => decideTransition('DONE', 'NEW', 'worker', { ready: true }, rules)).toThrow(
      'ILLEGAL_STATE_TRANSITION',
    );
    expect(() =>
      decideTransition('NEW', 'DONE', 'worker', { ready: true }, [...rules, ...rules]),
    ).toThrow('ILLEGAL_STATE_TRANSITION');
  });
});
