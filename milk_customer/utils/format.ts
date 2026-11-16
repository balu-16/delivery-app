export const formatCurrency = (value: number) => `₹${Math.round(value).toLocaleString('en-IN')}`;

export const formatCompact = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(1).replace('.0', '')}k` : `${value}`;

export const formatDateShort = (date: Date) =>
  date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
