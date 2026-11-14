export function formatMoney(value: string | null | undefined): string {
  if (value == null || !/^-?\d+$/.test(value)) return '—';
  const amount = BigInt(value);
  const abs = amount < 0n ? -amount : amount;
  return `${amount < 0n ? '-' : ''}₹${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
export function shortTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
