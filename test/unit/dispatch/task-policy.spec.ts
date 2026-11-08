import {
  contactVisible,
  DELIVERY_TASK_TRANSITIONS,
  failEndsCustody,
  geofenceFlag,
  locationVisible,
  transitionTask,
} from '../../../src/modules/dispatch/domain/task-policy.js';
import { radiusForAttempt } from '../../../src/modules/dispatch/domain/settings.js';
import type { DeliveryTaskStatus } from '../../../src/modules/dispatch/contracts/tasks.js';

const ALL: DeliveryTaskStatus[] = [
  'UNASSIGNED',
  'OFFERED',
  'ASSIGNED',
  'AT_STORE',
  'PICKED_UP',
  'ARRIVED',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
];

describe('delivery task policy (11.3)', () => {
  test('every declared transition is legal and writes through the machine', () => {
    for (const [from, targets] of Object.entries(DELIVERY_TASK_TRANSITIONS))
      for (const to of targets)
        expect(transitionTask(from as DeliveryTaskStatus, to as DeliveryTaskStatus)).toBe(to);
  });

  test('illegal transitions throw', () => {
    // Cannot skip custody: no direct UNASSIGNED→PICKED_UP or OFFERED→DELIVERED.
    expect(() => transitionTask('UNASSIGNED', 'PICKED_UP')).toThrow('ILLEGAL_STATE_TRANSITION');
    expect(() => transitionTask('OFFERED', 'DELIVERED')).toThrow('ILLEGAL_STATE_TRANSITION');
    expect(() => transitionTask('PICKED_UP', 'UNASSIGNED')).toThrow('ILLEGAL_STATE_TRANSITION');
    expect(() => transitionTask('ARRIVED', 'ASSIGNED')).toThrow('ILLEGAL_STATE_TRANSITION');
    expect(() => transitionTask('DELIVERED', 'FAILED')).toThrow('ILLEGAL_STATE_TRANSITION');
    expect(() => transitionTask('CANCELLED', 'OFFERED')).toThrow('ILLEGAL_STATE_TRANSITION');
  });

  test('pre-pickup states may return to UNASSIGNED; post-pickup cannot (D21)', () => {
    expect(DELIVERY_TASK_TRANSITIONS.ASSIGNED).toContain('UNASSIGNED');
    expect(DELIVERY_TASK_TRANSITIONS.AT_STORE).toContain('UNASSIGNED');
    expect(DELIVERY_TASK_TRANSITIONS.PICKED_UP).not.toContain('UNASSIGNED');
    expect(DELIVERY_TASK_TRANSITIONS.ARRIVED).not.toContain('UNASSIGNED');
    for (const terminal of ['DELIVERED', 'FAILED', 'CANCELLED'] as const)
      expect(DELIVERY_TASK_TRANSITIONS[terminal]).toHaveLength(0);
  });

  test('rider contact is visible only in the custody window (GEO-04)', () => {
    for (const status of ['ASSIGNED', 'AT_STORE', 'PICKED_UP', 'ARRIVED'] as const)
      expect(contactVisible(status)).toBe(true);
    for (const status of ['UNASSIGNED', 'OFFERED', 'DELIVERED', 'FAILED', 'CANCELLED'] as const)
      expect(contactVisible(status)).toBe(false);
  });

  test('live location visibility revokes in terminal states (RTN-01)', () => {
    for (const status of ['UNASSIGNED', 'OFFERED', 'DELIVERED', 'FAILED', 'CANCELLED'] as const)
      expect(locationVisible(status)).toBe(false);
  });

  test('rider-initiated failure ends custody only after pickup', () => {
    expect(failEndsCustody('ASSIGNED')).toBe(false);
    expect(failEndsCustody('AT_STORE')).toBe(false);
    expect(failEndsCustody('PICKED_UP')).toBe(true);
    expect(failEndsCustody('ARRIVED')).toBe(true);
  });

  test('geofence arrivals are flagged beyond the threshold, never blocked (23.3)', () => {
    expect(geofenceFlag(null, 300)).toBeNull();
    expect(geofenceFlag(120, 300)).toBeNull();
    expect(geofenceFlag(301, 300)).toBe(301);
    expect(geofenceFlag(2500.6, 300)).toBe(2500);
  });

  test('radius widening follows the configured steps then holds', () => {
    expect(radiusForAttempt(0, 3000, [1500, 3000, 5000])).toBe(3000);
    expect(radiusForAttempt(1, 3000, [1500, 3000, 5000])).toBe(1500);
    expect(radiusForAttempt(2, 3000, [1500, 3000, 5000])).toBe(3000);
    expect(radiusForAttempt(9, 3000, [1500, 3000, 5000])).toBe(5000);
  });

  test('the transition table covers every status (exhaustive)', () => {
    expect(Object.keys(DELIVERY_TASK_TRANSITIONS).sort()).toEqual([...ALL].sort());
  });
});
