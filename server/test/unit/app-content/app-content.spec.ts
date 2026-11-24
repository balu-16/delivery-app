import {
  assertLocale,
  assertSlot,
  effectiveState,
  safeDestination,
  validateWrite,
} from '../../../src/modules/app-content/domain/app-content.js';
import { slotsFor } from '../../../src/modules/app-content/contracts/app-content.js';

describe('app-content domain (customize2 §3E)', () => {
  it('knows the 5 slots and per-audience subsets', () => {
    expect(slotsFor('CUSTOMER')).toEqual([
      'CUSTOMER_HOME_BANNER',
      'CUSTOMER_OFFERS_CARD',
      'CUSTOMER_HELP',
    ]);
    expect(slotsFor('RIDER')).toEqual(['RIDER_HOME_ANNOUNCEMENT', 'RIDER_HELP']);
    expect(() => assertSlot('CUSTOMER_HOME_BANNER')).not.toThrow();
    expect(() => assertSlot('BOGUS')).toThrow('INVALID_INPUT');
    expect(() => assertLocale('te')).not.toThrow();
    expect(() => assertLocale('fr')).toThrow('INVALID_INPUT');
  });

  it('enforces per-slot destination allowlists with prefix match', () => {
    expect(safeDestination('CUSTOMER_HOME_BANNER', '/cart')).toBe(true);
    expect(safeDestination('CUSTOMER_HOME_BANNER', '/products/milk')).toBe(true);
    expect(safeDestination('CUSTOMER_HOME_BANNER', '/notifications')).toBe(false);
    expect(safeDestination('RIDER_HOME_ANNOUNCEMENT', '/notifications')).toBe(true);
    expect(safeDestination('RIDER_HOME_ANNOUNCEMENT', '/cart')).toBe(false);
    expect(safeDestination('CUSTOMER_HELP', '/support')).toBe(true);
    expect(safeDestination('CUSTOMER_HELP', '/support?topic=orders')).toBe(true);
    expect(safeDestination('CUSTOMER_HOME_BANNER', '//evil.example')).toBe(false);
    expect(safeDestination('CUSTOMER_HOME_BANNER', 'relative')).toBe(false);
    expect(safeDestination('CUSTOMER_HOME_BANNER', null)).toBe(true);
  });

  it('requires text for enabled writes and validates time ordering', () => {
    expect(() =>
      validateWrite('CUSTOMER_HOME_BANNER', 'en', { enabled: true, title: 'Hi', body: 'There' }),
    ).not.toThrow();
    expect(() =>
      validateWrite('CUSTOMER_HOME_BANNER', 'en', { enabled: true, title: '', body: 'There' }),
    ).toThrow('INVALID_INPUT');
    expect(() => validateWrite('CUSTOMER_HOME_BANNER', 'en', { enabled: false })).not.toThrow();
    expect(() =>
      validateWrite('CUSTOMER_HOME_BANNER', 'en', {
        enabled: true,
        title: 'Hi',
        body: 'There',
        startAt: '2026-02-01T00:00:00Z',
        endAt: '2026-01-01T00:00:00Z',
      }),
    ).toThrow('INVALID_INPUT');
    expect(() =>
      validateWrite('RIDER_HELP', 'en', { enabled: true, title: 'x'.repeat(201), body: 'y' }),
    ).toThrow('INVALID_INPUT');
  });

  it('distinguishes unset, disabled, inactive and visible server-time states', () => {
    const now = new Date('2026-06-01T12:00:00Z');
    expect(effectiveState(null, now)).toBe('UNSET');
    expect(effectiveState({ enabled: false, start_at: null, end_at: null }, now)).toBe('DISABLED');
    expect(
      effectiveState({ enabled: true, start_at: '2026-07-01T00:00:00Z', end_at: null }, now),
    ).toBe('INACTIVE');
    expect(
      effectiveState({ enabled: true, start_at: null, end_at: '2026-05-01T00:00:00Z' }, now),
    ).toBe('INACTIVE');
    expect(
      effectiveState(
        { enabled: true, start_at: '2026-05-01T00:00:00Z', end_at: '2026-07-01T00:00:00Z' },
        now,
      ),
    ).toBe('VISIBLE');
  });
});
