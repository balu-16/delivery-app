export type PendingCardAction = { cardId: string; action: 'add_to_cart'; payload: string; id: string };

const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

/** Restore only a complete action; an unreadable record must not be silently replaced. */
export function readPendingCardAction(raw: string): PendingCardAction | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    if (typeof item.cardId !== 'string' || !uuid.test(item.cardId) || item.action !== 'add_to_cart' ||
      typeof item.id !== 'string' || !uuid.test(item.id) || typeof item.payload !== 'string') return null;
    const payload: unknown = JSON.parse(item.payload);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const details = payload as Record<string, unknown>;
    if (typeof details.variantId !== 'string' || !uuid.test(details.variantId) ||
      typeof details.addressId !== 'string' || !uuid.test(details.addressId) ||
      typeof details.quantity !== 'number' || !Number.isSafeInteger(details.quantity) || details.quantity < 1) return null;
    return { cardId: item.cardId, action: 'add_to_cart', payload: item.payload, id: item.id };
  } catch { return null; }
}

export const pendingCardActionKey = (threadId: string) => `@dairydirect/agent-card-action/${threadId}`;
