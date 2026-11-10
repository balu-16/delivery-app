/** PostgreSQL bigint bound, checked before any database work. */
const MAX = 9223372036854775807n;
export function quantity(value: string, allowZero = false): bigint {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) throw new Error('INVALID_QUANTITY');
  const result = BigInt(value);
  if (result > MAX || (!allowZero && result === 0n)) throw new Error('INVALID_QUANTITY');
  return result;
}
export function eligible(expiresAt: Date | null, target: Date, shelfLifeSeconds: number): boolean {
  return expiresAt === null || expiresAt.getTime() > target.getTime() + shelfLifeSeconds * 1000;
}
