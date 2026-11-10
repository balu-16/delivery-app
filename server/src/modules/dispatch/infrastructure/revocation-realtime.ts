import type { EventEnvelope } from '../../../platform/outbox/outbox.js';
import type { RealtimeBroadcasts } from '../../tracking/contracts/tracking.js';

/** Called for committed revocation events by the independent outbox consumer. */
export async function publishOfferRevocation(
  event: EventEnvelope,
  broadcasts: RealtimeBroadcasts,
): Promise<void> {
  if (event.eventType !== 'rider.offer_revoked') return;
  const payload = event.payload as {
    riderId?: unknown;
    offerId?: unknown;
    taskId?: unknown;
    reason?: unknown;
  } | null;
  if (
    !payload ||
    typeof payload.riderId !== 'string' ||
    typeof payload.offerId !== 'string' ||
    typeof payload.taskId !== 'string' ||
    typeof payload.reason !== 'string'
  )
    throw new Error('UNPARSEABLE_EVENT');
  broadcasts.emitRiderEvent(payload.riderId, 'offer.revoked', {
    offerId: payload.offerId,
    taskId: payload.taskId,
    reason: payload.reason,
  });
}
