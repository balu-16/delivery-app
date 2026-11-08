import type { QuoteIssue } from '../contracts/quote.js';
export interface CartEvaluation {
  variantId: string;
  storedQuantity: bigint;
  storedUnitPricePaise: bigint;
  currentUnitPricePaise: bigint | null;
  available: bigint;
  saleable: boolean;
}
export const MAX_QUANTITY = 1000n;
/** Absolute quantity write: validated then clamped to the per-order maximum. */
export function parseQuantity(raw: string): bigint {
  if (!/^[0-9]{1,10}$/.test(raw)) throw new Error('INVALID_QUANTITY');
  const value = BigInt(raw);
  if (value > MAX_QUANTITY) throw new Error('INVALID_QUANTITY');
  return value;
}
export function clampToMaxPerOrder(
  quantity: bigint,
  maxPerOrder: number,
): {
  quantity: bigint;
  clamped: boolean;
} {
  if (!Number.isSafeInteger(maxPerOrder) || maxPerOrder < 1) throw new Error('INVALID_INPUT');
  const cap = BigInt(maxPerOrder);
  return quantity > cap ? { quantity: cap, clamped: true } : { quantity, clamped: false };
}
/**
 * Fresh evaluation of stored lines against live catalog/stock. Unavailable or
 * repriced lines are flagged, never dropped; quantity issues carry the clamp.
 */
export function evaluateLines(lines: CartEvaluation[]): QuoteIssue[] {
  const issues: QuoteIssue[] = [];
  for (const line of lines) {
    if (!line.saleable || line.currentUnitPricePaise === null || line.available <= 0n) {
      issues.push({
        code: 'ITEM_UNAVAILABLE',
        variantId: line.variantId,
        detail: 'item is not currently saleable at this store',
      });
      continue;
    }
    if (line.currentUnitPricePaise !== line.storedUnitPricePaise)
      issues.push({
        code: 'PRICE_CHANGED',
        variantId: line.variantId,
        detail: `price moved from ${line.storedUnitPricePaise} to ${line.currentUnitPricePaise}`,
      });
    if (line.storedQuantity > line.available)
      issues.push({
        code: 'QTY_REDUCED',
        variantId: line.variantId,
        detail: `quantity reduced to ${line.available}`,
      });
  }
  return issues;
}
export function expectedVersion(raw: number): number {
  if (!Number.isSafeInteger(raw) || raw < 1) throw new Error('INVALID_INPUT');
  return raw;
}
export function requireVersion(current: bigint, expected: number): void {
  if (current !== BigInt(expected)) throw new Error('CONCURRENT_MODIFICATION');
}
