export type ReservationState = 'HELD' | 'COMMITTED' | 'RESOLVED';
export type ReservationAction = 'COMMIT' | 'RELEASE' | 'PICK' | 'EXPIRE';
/** All timestamps passed here must be sampled after acquiring database locks. */
export function canTransition(
  state: ReservationState,
  action: ReservationAction,
  expiresAt: Date | null,
  now: Date,
): boolean {
  if (action === 'COMMIT') return state === 'HELD' && expiresAt !== null && expiresAt > now;
  if (action === 'EXPIRE') return state === 'HELD' && expiresAt !== null && expiresAt <= now;
  if (action === 'PICK') return state === 'COMMITTED';
  return state === 'HELD' || state === 'COMMITTED';
}
