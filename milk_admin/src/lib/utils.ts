import { clsx, type ClassValue } from 'clsx'

/** Merge class values. (tailwind-merge was dropped to keep the initial bundle lean.) */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs)
}

/** ₹12,48,320 — Indian grouping. Non-finite values (÷0, NaN) render as — . */
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
export function fmtINR(n: number, withSymbol = true) {
  if (!Number.isFinite(n)) return '—'
  return (withSymbol ? '₹' : '') + inr.format(Math.round(n))
}

/** ₹12.48L / ₹1.09Cr — compact Indian format */
export function fmtCompactINR(n: number) {
  if (!Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e7) return `₹${trim(n / 1e7)}Cr`
  if (abs >= 1e5) return `₹${trim(n / 1e5)}L`
  if (abs >= 1e3) return `₹${trim(n / 1e3)}K`
  return `₹${trim(n)}`
}
function trim(v: number) {
  return v.toFixed(v >= 100 ? 0 : 2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')
}

const num = new Intl.NumberFormat('en-IN')
export function fmtNum(n: number) {
  if (!Number.isFinite(n)) return '—'
  return num.format(Math.round(n))
}

export function fmtPct(n: number, digits = 1) {
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(digits)}%`
}

/** +12.6% / −5.1% with proper minus sign */
export function fmtDelta(n: number) {
  if (!Number.isFinite(n)) return '—'
  return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`
}

export function fmtDate(d: Date | string, opts?: Intl.DateTimeFormatOptions) {
  return new Date(d).toLocaleDateString('en-IN', opts ?? { day: '2-digit', month: 'short', year: 'numeric' })
}

export function fmtTime(d: Date | string) {
  return new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
}

export function fmtDateTime(d: Date | string) {
  return `${fmtDate(d, { day: '2-digit', month: 'short' })}, ${fmtTime(d)}`
}

export function timeAgo(d: Date | string, now: Date) {
  const diff = now.getTime() - new Date(d).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} hour${h > 1 ? 's' : ''} ago`
  const days = Math.floor(h / 24)
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  return fmtDate(d)
}

export function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

export function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

export function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
}

/** Human label for status enums across the new domain */
export const STATUS_LABEL: Record<string, string> = {
  placed: 'Placed', confirmed: 'Confirmed', picking: 'Picking', ready: 'Ready',
  out_for_delivery: 'Out for Delivery', delivered: 'Delivered', cancelled: 'Cancelled', on_hold: 'On Hold',
  online: 'Online', paused: 'Paused',
  published: 'Published', unpublished: 'Unpublished',
  captured: 'Captured', failed: 'Failed', initiated: 'Initiated',
  requested: 'Requested', processing: 'Processing', paid: 'Paid', cod: 'COD',
  topup: 'Top-up', order_payment: 'Order payment', refund_credit: 'Refund credit', adjustment: 'Adjustment',
  active: 'Active', blocked: 'Blocked', invited: 'Invited',
  application_pending: 'Application pending', application_approved: 'Application approved', application_rejected: 'Application rejected', suspended: 'Suspended',
  pending: 'Pending', submitted: 'Submitted', verified: 'Verified', rejected: 'Rejected',
  pending_review: 'Pending review', approved: 'Approved',
  inactive: 'Inactive', scheduled: 'Scheduled', expired: 'Expired', sent: 'Sent', draft: 'Draft',
  completed: 'Completed', partial: 'Partial',
  open: 'Open', resolved: 'Resolved', closed: 'Closed',
  investigating: 'Investigating', cleared: 'Cleared', released: 'Released',
  mismatch: 'Mismatch', unresolved_payment: 'Unresolved payment', missing_payout: 'Missing payout',
}
