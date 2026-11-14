import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { CalendarDays, ChevronRight, CreditCard, Search, X } from 'lucide-react'
import { cn, STATUS_LABEL } from '@/lib/utils'
import { Kbd } from '@/components/ui/base'
import { useOS } from '@/hooks/misc'
import { headerArtwork, type HeaderArtwork } from '@/illustrations/headerArtwork'

/* ── Status pill ────────────────────────────────────────────── */
const STATUS_TONE: Record<string, { cls: string; dot?: string }> = {
  delivered: { cls: 'bg-success-soft text-success', dot: 'bg-success' },
  captured: { cls: 'bg-success-soft text-success' },
  paid: { cls: 'bg-success-soft text-success' },
  active: { cls: 'bg-success-soft text-success', dot: 'bg-success' },
  online: { cls: 'bg-success-soft text-success', dot: 'bg-success' },
  published: { cls: 'bg-success-soft text-success' },
  verified: { cls: 'bg-success-soft text-success' },
  approved: { cls: 'bg-success-soft text-success' },
  sent: { cls: 'bg-success-soft text-success' },
  completed: { cls: 'bg-success-soft text-success' },
  resolved: { cls: 'bg-success-soft text-success' },
  cleared: { cls: 'bg-success-soft text-success' },
  ready: { cls: 'bg-info-soft text-info', dot: 'bg-info' },
  confirmed: { cls: 'bg-info-soft text-info', dot: 'bg-info' },
  out_for_delivery: { cls: 'bg-info-soft text-info', dot: 'bg-info' },
  rendering: { cls: 'bg-info-soft text-info' },
  open: { cls: 'bg-info-soft text-info', dot: 'bg-info' },
  processing: { cls: 'bg-warning-soft text-amber-600 dark:text-warning', dot: 'bg-warning' },
  picking: { cls: 'bg-warning-soft text-amber-600 dark:text-warning', dot: 'bg-warning' },
  paused: { cls: 'bg-warning-soft text-amber-600 dark:text-warning', dot: 'bg-warning' },
  on_hold: { cls: 'bg-warning-soft text-amber-600 dark:text-warning', dot: 'bg-warning' },
  requested: { cls: 'bg-warning-soft text-amber-600 dark:text-warning', dot: 'bg-warning' },
  submitted: { cls: 'bg-warning-soft text-amber-600 dark:text-warning' },
  pending: { cls: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300', dot: 'bg-violet-500' },
  placed: { cls: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300', dot: 'bg-violet-500' },
  invited: { cls: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300' },
  scheduled: { cls: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300' },
  draft: { cls: 'bg-muted text-muted-foreground' },
  pending_review: { cls: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300', dot: 'bg-violet-500' },
  investigating: { cls: 'bg-warning-soft text-amber-600 dark:text-warning' },
  application_pending: { cls: 'bg-warning-soft text-amber-600 dark:text-warning', dot: 'bg-warning' },
  application_approved: { cls: 'bg-success-soft text-success' },
  application_rejected: { cls: 'bg-destructive-soft text-destructive' },
  blocked: { cls: 'bg-destructive-soft text-destructive', dot: 'bg-destructive' },
  cancelled: { cls: 'bg-destructive-soft text-destructive' },
  failed: { cls: 'bg-destructive-soft text-destructive' },
  rejected: { cls: 'bg-destructive-soft text-destructive' },
  expired: { cls: 'bg-destructive-soft text-destructive' },
  suspended: { cls: 'bg-destructive-soft text-destructive' },
  removed: { cls: 'bg-destructive-soft text-destructive' },
  confirmed_fraud: { cls: 'bg-destructive-soft text-destructive' },
  inactive: { cls: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' },
  unpublished: { cls: 'bg-muted text-muted-foreground' },
  closed: { cls: 'bg-muted text-muted-foreground' },
  offline: { cls: 'bg-muted text-muted-foreground' },
  released: { cls: 'bg-muted text-muted-foreground' },
  cod: { cls: 'bg-warning-soft text-amber-600 dark:text-warning' },
  processed: { cls: 'bg-info-soft text-info' },
}

export function StatusPill({ status, dot, className }: { status: string; dot?: boolean; className?: string }) {
  const tone = STATUS_TONE[status] ?? { cls: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' }
  const label = STATUS_LABEL[status] ?? status.replace(/_/g, ' ')
  return (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold capitalize', tone.cls, className)}>
      {(dot ?? tone.dot) && <span className={cn('h-1.5 w-1.5 rounded-full animate-pulse-soft', tone.dot ?? 'bg-current')} />}
      {label}
    </span>
  )
}

export function PaymentPill({ method, status }: { method: string; status: string }) {
  if (method === 'cod' && (status === 'cod_pending' || status === 'pending')) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2.5 py-1 text-[11px] font-bold text-amber-600 dark:text-warning">
        <CreditCard className="h-3 w-3" /> COD
      </span>
    )
  }
  return <StatusPill status="paid" />
}

export const METHOD_ICON: Record<string, string> = { upi: 'UPI', card: 'Card', netbanking: 'Net Banking', wallet: 'Wallet', cod: 'COD', none: '—' }

/* ── Delta text ─────────────────────────────────────────────── */
export function DeltaText({ value, good = 'up', className, suffix }: { value: number; good?: 'up' | 'down' | 'none'; className?: string; suffix?: string }) {
  const isGood = good === 'none' ? null : good === 'up' ? value >= 0 : value < 0
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-bold tabular', isGood === null ? 'text-muted-foreground' : isGood ? 'text-success' : 'text-destructive', className)}>
      {value >= 0 ? '↑' : '↓'} {Math.abs(value).toFixed(1)}%{suffix}
    </span>
  )
}

/* ── Page header (breadcrumb + title + section artwork) ─────── */
export function PageHeader({
  title, titleAccent, subtitle, artwork, actions, controls, breadcrumb,
}: {
  title: string
  titleAccent?: string
  subtitle?: string
  artwork?: HeaderArtwork
  actions?: React.ReactNode
  /** Filters rendered between the title block and the artwork (left of the image). */
  controls?: React.ReactNode
  breadcrumb?: string[]
}) {
  return (
    <div className={cn('relative flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-4', artwork && 'sm:min-h-[150px]')}>
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="relative z-10 min-w-0 flex-1 pb-1"
      >
        <div className="min-w-0">
          {breadcrumb && breadcrumb.length > 0 && (
            <nav className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground" aria-label="Breadcrumb">
              <span>Home</span>
              {breadcrumb.map((b) => (
                <span key={b} className="flex items-center gap-1.5">
                  <ChevronRight className="h-3 w-3 opacity-60" />
                  <span className="text-foreground/80">{b}</span>
                </span>
              ))}
            </nav>
          )}
          <h1 className="text-[30px] font-extrabold leading-tight tracking-tight sm:text-display">
            {title}
            {titleAccent && <> <span className="text-gradient">{titleAccent}</span></>}
          </h1>
          {subtitle && <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">{subtitle}</p>}
          {actions && <div className="mt-4 flex flex-wrap items-center gap-2.5">{actions}</div>}
        </div>
      </motion.div>
      {controls && (
        <div className="relative z-10 flex flex-wrap items-center gap-2.5 pb-1">
          {controls}
        </div>
      )}
      {artwork && (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none flex h-[100px] w-full shrink-0 justify-end sm:w-[38%] sm:max-w-[480px]',
            artwork === 'reports' ? 'sm:h-[195px] lg:h-[210px]' : 'sm:h-[150px]',
          )}
        >
          <img
            src={headerArtwork[artwork]}
            alt=""
            decoding="async"
            className={cn(
              'h-full w-full object-contain object-right',
              artwork === 'stores' && 'lg:origin-right lg:scale-x-[1.25]',
            )}
          />
        </div>
      )}
    </div>
  )
}

/** Top-right controls next to the header (date chip etc.). */
export function HeaderAside({ children }: { children: React.ReactNode }) {
  return <div className="relative z-10 flex justify-end">{children}</div>
}

export function DateChip({ label, onClick, active }: { label: string; onClick?: () => void; active?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'inline-flex h-10 items-center gap-2 rounded-full border bg-card px-4 text-[13px] font-semibold shadow-soft transition hover:border-brand-300',
        active && 'border-brand-300 ring-2 ring-ring/30',
      )}
    >
      <CalendarDays className="h-4 w-4 text-brand-600" />
      {label}
      <ChevronRight className="h-3.5 w-3.5 -rotate-90 text-muted-foreground" />
    </button>
  )
}

/* ── Search input ───────────────────────────────────────────── */
export function SearchInput({
  value, onChange, placeholder = 'Search…', className, kbd,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  className?: string
  kbd?: boolean
}) {
  const os = useOS()
  return (
    <div className={cn('relative', className)}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-10 w-full rounded-xl border border-input bg-card pl-10 pr-16 text-sm shadow-innersoft transition placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-ring/60 focus:border-brand-300"
      />
      <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-1">
        {value ? (
          <button onClick={() => onChange('')} className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:text-foreground" aria-label="Clear search">
            <X className="h-3.5 w-3.5" />
          </button>
        ) : kbd ? (
          <Kbd>{os === 'mac' ? '⌘K' : 'Ctrl K'}</Kbd>
        ) : null}
      </div>
    </div>
  )
}

/* ── Range toggle (7D / 30D / 90D) ──────────────────────────── */
export function RangeToggle({ value, onChange, options = ['7d', '30d', '90d'], id }: {
  value: string
  onChange: (v: string) => void
  options?: string[]
  id: string
}) {
  return (
    <div className="flex items-center rounded-full border border-border bg-muted/60 p-1">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className="relative rounded-full px-3.5 py-1.5 text-xs font-bold"
        >
          {value === o && (
            <motion.span layoutId={`range-${id}`} className="absolute inset-0 rounded-full gradient-primary shadow-pill" transition={{ type: 'spring', stiffness: 400, damping: 32 }} />
          )}
          <span className={cn('relative z-10', value === o ? 'text-white' : 'text-muted-foreground')}>
            {o === 'today' ? 'Today' : o.toUpperCase()}
          </span>
        </button>
      ))}
    </div>
  )
}

/* ── Tabs (pill style) ──────────────────────────────────────── */
export function TabPills({ tabs, value, onChange, id, className }: {
  tabs: Array<{ value: string; label: string; count?: number }>
  value: string
  onChange: (v: string) => void
  id: string
  className?: string
}) {
  return (
    <div className={cn('scrollbar-thin flex max-w-full items-center gap-1 overflow-x-auto rounded-full', className)} role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className="relative whitespace-nowrap rounded-full px-4 py-2.5 text-[13px] font-semibold transition-colors"
        >
          {value === t.value && (
            <motion.span layoutId={`tab-${id}`} className="absolute inset-0 rounded-full gradient-primary shadow-pill" transition={{ type: 'spring', stiffness: 380, damping: 32 }} />
          )}
          <span className={cn('relative z-10', value === t.value ? 'text-white' : 'text-muted-foreground hover:text-foreground')}>
            {t.label}
            {t.count !== undefined && <span className="ml-1.5 opacity-90">({t.count.toLocaleString('en-IN')})</span>}
          </span>
        </button>
      ))}
    </div>
  )
}

/* ── Empty state ────────────────────────────────────────────── */
export function EmptyState({ icon: Icon, title, body, action }: { icon?: LucideIcon; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-14 text-center">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 260, damping: 18 }}
        className="grid h-16 w-16 place-items-center rounded-2xl bg-primary-soft text-brand-700 dark:text-brand-300"
      >
        {Icon ? <Icon className="h-7 w-7" /> : <span className="text-2xl">🥛</span>}
      </motion.div>
      <div>
        <div className="text-sm font-bold">{title}</div>
        {body && <div className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">{body}</div>}
      </div>
      {action}
    </div>
  )
}
