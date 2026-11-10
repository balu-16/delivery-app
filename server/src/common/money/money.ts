const MAX_PG_BIGINT = 9_223_372_036_854_775_807n;
const MIN_PG_BIGINT = -9_223_372_036_854_775_808n;
/** Money is paise. JSON and DB representations are canonical decimal strings. */
export function parseMoney(value: string, allowNegative = false): bigint {
  if (!/^(0|[1-9]\d*|-[1-9]\d*)$/.test(value)) throw new Error('INVALID_MONEY');
  const result = BigInt(value);
  if ((!allowNegative && result < 0n) || result < MIN_PG_BIGINT || result > MAX_PG_BIGINT)
    throw new Error('MONEY_OUT_OF_RANGE');
  return result;
}
export function moneyString(value: bigint, allowNegative = false): string {
  return parseMoney(value.toString(), allowNegative).toString();
}
export function gatewayMoneyNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('UNSAFE_GATEWAY_AMOUNT');
  return Number(value);
}
