import type { NotificationChannel } from '../contracts/notifications.js';

/**
 * Stable logical notification identity. Replay of the same aggregate
 * transition produces one row per recipient+channel; a distinct transition
 * version (a later legitimate status) notifies again. The aggregate id is
 * part of the key — the source's own example `order:{id}:status:{status}`
 * scopes dedupe to one aggregate, so two different orders never suppress
 * each other.
 */
export function dedupeKey(input: {
  recipientId: string;
  channel: NotificationChannel;
  eventType: string;
  aggregateId: string;
  transitionVersion: string;
}): string {
  if (!input.recipientId || !input.eventType || !input.aggregateId)
    throw new Error('INVALID_DEDUPE_INPUT');
  return [
    input.recipientId,
    input.channel,
    input.eventType,
    input.aggregateId,
    input.transitionVersion,
  ].join('|');
}
