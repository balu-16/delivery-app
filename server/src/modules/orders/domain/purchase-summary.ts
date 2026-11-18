import type { UsualPurchase } from '../contracts/orders.js';

/** One purchased line inside a delivered order. Repeated lines for a variant are summed. */
export interface DeliveredPurchaseLine {
  readonly orderId: string;
  readonly placedAt: string;
  readonly variantId: string;
  readonly name: string;
  readonly orderedQty: number;
}

/**
 * Rank delivered purchases by how often the variant was bought, then by the
 * newest purchase. Each variant counts once per order. The quantity is the
 * summed quantity from that variant's newest order, even when rows arrive
 * newest-first.
 */
export function rankUsualPurchases(lines: readonly DeliveredPurchaseLine[]): UsualPurchase[] {
  const perOrder = new Map<
    string,
    { placedAt: string; variantId: string; name: string; quantity: number }
  >();
  for (const line of lines) {
    const key = `${line.orderId}\u0000${line.variantId}`;
    const known = perOrder.get(key);
    if (!known) {
      perOrder.set(key, {
        placedAt: line.placedAt,
        variantId: line.variantId,
        name: line.name,
        quantity: line.orderedQty,
      });
      continue;
    }
    known.quantity += line.orderedQty;
    if (line.placedAt > known.placedAt) {
      known.placedAt = line.placedAt;
      known.name = line.name;
    }
  }
  const byVariant = new Map<string, UsualPurchase>();
  for (const line of perOrder.values()) {
    const known = byVariant.get(line.variantId);
    if (!known || line.placedAt > known.lastOrderedAt) {
      byVariant.set(line.variantId, {
        variantId: line.variantId,
        name: line.name,
        orderCount: (known?.orderCount ?? 0) + 1,
        lastQuantity: line.quantity,
        lastOrderedAt: line.placedAt,
      });
      continue;
    }
    known.orderCount += 1;
  }
  return [...byVariant.values()]
    .sort((a, b) => b.orderCount - a.orderCount || b.lastOrderedAt.localeCompare(a.lastOrderedAt))
    .slice(0, 8);
}
