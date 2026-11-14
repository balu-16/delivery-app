/** Format an integer number of paise without converting it to a JavaScript number. */
export function formatPaise(value: string): string {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return '—';

  const isNegative = value.startsWith('-');
  const digits = (isNegative ? value.slice(1) : value).replace(/^0+(?=\d)/, '');
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  const leading = whole.slice(0, -3);
  const grouped = leading
    ? `${leading.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${whole.slice(-3)}`
    : whole;

  return `${isNegative && digits !== '0' ? '−' : ''}₹${grouped}.${fraction}`;
}
