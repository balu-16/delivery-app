import { memo } from 'react'
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { cn, fmtDelta, fmtINR, fmtNum, fmtPct } from '@/lib/utils'
import { useCountUp } from '@/hooks/misc'
import { Sparkline } from './charts'

export type KpiFormat = 'inr' | 'compact' | 'num' | 'pct' | 'raw'

/** Animated KPI card: icon tile, count-up value, good-direction delta, optional sparkline. */
export const KpiCard = memo(function KpiCard({
  label, value, format = 'num', delta, deltaGood = 'up', icon: Icon, tint = 'green',
  sparkline, sparkColor, highlight, className, suffix,
}: {
  label: string
  value: number
  format?: KpiFormat
  delta?: number
  /** Which direction of the delta is GOOD (drives green/red). */
  deltaGood?: 'up' | 'down' | 'none'
  icon?: LucideIcon
  tint?: 'green' | 'amber' | 'blue' | 'red' | 'violet'
  sparkline?: Array<Record<string, number | string>>
  sparkColor?: string
  highlight?: boolean
  className?: string
  suffix?: string
}) {
  const display = useCountUp(value)
  const fmt = (v: number) => {
    if (!Number.isFinite(v)) return '—'
    if (format === 'inr') return fmtINR(v)
    if (format === 'compact') return fmtINR(v) === '' ? '' : fmtCompact(v)
    if (format === 'pct') return fmtPct(v)
    return fmtNum(v)
  }
  function fmtCompact(v: number) {
    if (Math.abs(v) >= 1e5) {
      const l = v / 1e5
      return `₹${l >= 100 ? l.toFixed(0) : l.toFixed(2).replace(/\.00$/, '').replace(/0$/, '')}L`
    }
    return fmtINR(v)
  }
  const good = delta === undefined ? null : deltaGood === 'none' ? null : deltaGood === 'up' ? delta >= 0 : delta < 0
  const tints = {
    green: 'bg-brand-50 text-brand-700 ring-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20',
    amber: 'bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20',
    blue: 'bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20',
    red: 'bg-rose-50 text-rose-600 ring-rose-100 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/20',
    violet: 'bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/20',
  }
  return (
    <motion.div
      variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } } }}
      className={cn(
        'group relative overflow-hidden rounded-card border bg-card p-4 shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-lift sm:p-5',
        highlight ? 'border-brand-200 bg-gradient-to-br from-brand-50/80 to-card' : 'border-border/70',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-muted-foreground">{label}</div>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-[23px] font-extrabold leading-none tracking-tight tabular sm:text-[25px]">
              {format === 'compact' ? fmtCompact(value) : fmt(display)}{suffix}
            </span>
          </div>
        </div>
        {Icon && (
          <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1', tints[tint])}>
            <Icon className="h-5 w-5" strokeWidth={2} />
          </div>
        )}
      </div>
      <div className="mt-2.5 flex items-end justify-between gap-3">
        {delta !== undefined && (
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11.5px] font-bold tabular',
              good === null ? 'bg-muted text-muted-foreground' : good ? 'bg-success-soft text-success' : 'bg-destructive-soft text-destructive',
            )}
          >
            {deltaGood === 'none' || good === null ? <Minus className="h-3 w-3" /> : delta >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
            {fmtDelta(delta)}
          </span>
        )}
        {sparkline && (
          <div className="h-11 w-28 shrink-0 opacity-90 transition-opacity group-hover:opacity-100">
            <Sparkline data={sparkline} color={sparkColor ?? (good === false ? '#E5484D' : '#2E7D1A')} height={44} />
          </div>
        )}
      </div>
    </motion.div>
  )
})
