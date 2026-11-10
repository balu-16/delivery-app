import { gatewayMoneyNumber, parseMoney } from '../../../common/money/money.js';

/**
 * Gateway-boundary money (ADD-01, plan 5.2): integer paise as canonical
 * decimal strings. Adapters (which may import only this module's contracts)
 * and module infrastructure share these helpers so every conversion to a
 * provider number passes the safe-integer fence and every accepted amount is
 * currency-compared first.
 */
const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;

export function gatewayAmountPaise(value: string, minimum = 1n): bigint {
  const parsed = parseMoney(value);
  if (parsed < minimum) throw new Error('INVALID_MONEY');
  if (parsed > MAX_PG_BIGINT) throw new Error('MONEY_OUT_OF_RANGE');
  return parsed;
}

/** Zero is valid only where the contract explicitly allows it (refund capacity). */
export function nonNegativeAmountPaise(value: string): bigint {
  const parsed = parseMoney(value);
  if (parsed < 0n || parsed > MAX_PG_BIGINT) throw new Error('MONEY_OUT_OF_RANGE');
  return parsed;
}

/** Throws before any numeric conversion when the amount exceeds 2^53-1 paise. */
export function amountToGatewayNumber(value: string): number {
  return gatewayMoneyNumber(gatewayAmountPaise(value, 0n));
}

export function assertCurrency(expected: string, actual: string): void {
  if (!/^[A-Z]{3}$/.test(expected) || !/^[A-Z]{3}$/.test(actual)) throw new Error('INVALID_INPUT');
  if (expected !== actual) throw new Error('AMOUNT_MISMATCH');
}
