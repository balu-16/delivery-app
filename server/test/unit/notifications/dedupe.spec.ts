import { dedupeKey } from '../../../src/modules/notifications/domain/dedupe.js';

describe('notification dedupe keys', () => {
  const base = {
    recipientId: '018f0000-0000-7000-8000-000000000001',
    channel: 'PUSH' as const,
    eventType: 'ORDER_CONFIRMED',
    aggregateId: '018f0000-0000-7000-8000-000000000002',
    transitionVersion: '3',
  };
  it('is stable for identical inputs', () => {
    expect(dedupeKey(base)).toBe(dedupeKey({ ...base }));
  });
  it('separates recipients, channels, event types, aggregates and versions', () => {
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, recipientId: 'x' }));
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, channel: 'EMAIL' }));
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, eventType: 'ORDER_DELIVERED' }));
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, aggregateId: 'y' }));
    // A later legitimate transition is never mistaken for a duplicate.
    expect(dedupeKey(base)).not.toBe(dedupeKey({ ...base, transitionVersion: '4' }));
  });
  it('rejects empty identity components', () => {
    expect(() => dedupeKey({ ...base, recipientId: '' })).toThrow('INVALID_DEDUPE_INPUT');
    expect(() => dedupeKey({ ...base, eventType: '' })).toThrow('INVALID_DEDUPE_INPUT');
    expect(() => dedupeKey({ ...base, aggregateId: '' })).toThrow('INVALID_DEDUPE_INPUT');
  });
});
