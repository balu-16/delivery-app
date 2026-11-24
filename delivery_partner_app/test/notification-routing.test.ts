import { clearPartnerTapCache, resolvePartnerNotification, shouldNavigate, isValidPartnerTaskId } from '../src/notification-routing';

const OFFER = 'a1b2c3d4-1234-4abc-8def-123456789abc';
const TASK = 'b1b2c3d4-1234-4abc-8def-123456789abc';
const TICKET = 'c1b2c3d4-1234-4abc-8def-123456789abc';

describe('partner notification resolver', () => {
  beforeEach(() => clearPartnerTapCache());

  test('offer events resolve to /offers/[offerId]', () => {
    expect(resolvePartnerNotification({ type: 'rider.offer', offerId: OFFER })).toEqual({
      kind: 'push', pathname: '/offers/[offerId]', params: { offerId: OFFER },
    });
  });

  test('assignment events resolve to /tasks/[taskId]', () => {
    expect(resolvePartnerNotification({ type: 'task.updated', taskId: TASK })).toEqual({
      kind: 'push', pathname: '/tasks/[taskId]', params: { taskId: TASK },
    });
  });

  test('history events carry attemptNo', () => {
    expect(resolvePartnerNotification({ type: 'rider.history', taskId: TASK, attemptNo: 2 })).toEqual({
      kind: 'push', pathname: '/history/[taskId]', params: { taskId: TASK, attemptNo: '2' },
    });
  });

  test('support thread resolves to /support/[ticketId]', () => {
    expect(resolvePartnerNotification({ type: 'rider.ticket', ticketId: TICKET })).toEqual({
      kind: 'push', pathname: '/support/[ticketId]', params: { ticketId: TICKET },
    });
  });

  test('unknown events fall back to inbox', () => {
    expect(resolvePartnerNotification({ type: 'unknown.event', foo: 'bar' })).toEqual({
      kind: 'fallback', pathname: '/notifications', reason: 'unknown',
    });
  });

  test('expired offers fall back to Tasks', () => {
    expect(resolvePartnerNotification({ type: 'rider.offer_revoked' })).toEqual({
      kind: 'fallback', pathname: '/', reason: 'expired',
    });
  });

  test('invalid UUID falls back', () => {
    expect(resolvePartnerNotification({ type: 'rider.offer', offerId: 'not-a-uuid' })).toEqual({
      kind: 'fallback', pathname: '/', reason: 'invalid',
    });
  });

  test('customer audience is rejected to inbox', () => {
    expect(resolvePartnerNotification({ type: 'rider.offer', offerId: OFFER, audience: 'customer' })).toEqual({
      kind: 'fallback', pathname: '/notifications', reason: 'invalid',
    });
  });

  test('duplicate taps dedupe to one destination', () => {
    const href = { pathname: '/tasks/[taskId]', params: { taskId: TASK } };
    expect(shouldNavigate(href)).toBe(true);
    expect(shouldNavigate(href)).toBe(false);
    clearPartnerTapCache();
    expect(shouldNavigate(href)).toBe(true);
  });

  test('task id validation', () => {
    expect(isValidPartnerTaskId(TASK)).toBe(true);
    expect(isValidPartnerTaskId('nope')).toBe(false);
    expect(isValidPartnerTaskId(undefined)).toBe(false);
  });
});
