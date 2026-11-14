import { useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ShoppingCart, Loader, Truck, XCircle, PauseCircle, Wallet, RotateCcw,
  BadgeIndianRupee, Store, ArrowRight, ClipboardList, Users, Receipt,
  ChevronRight, Check, PackageOpen,
} from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import { useDashboard, useStoreOptions } from '@/hooks/queries'
import { dashboardMetrics } from '@/api/dashboard'
import { PageHeader, DateChip, EmptyState } from '@/components/shared/misc'
import { Select } from '@/components/ui/form'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/overlays'
import { Card } from '@/components/ui/base'
import { KpiCard } from '@/components/shared/KpiCard'
import type { RangeKey } from '@/types'
import { fmtDate, fmtINR } from '@/lib/utils'

const RANGE_OPTIONS: Array<{ value: RangeKey; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
]

/** Pending-count row that deep-links into the owning page. */
function PendingLink({ to, label, right }: { to: string; label: string; right: React.ReactNode }) {
  return (
    <Link
      to={to}
      className="group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-primary-soft"
    >
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{label}</span>
      <span className="shrink-0 text-[12.5px] font-bold tabular text-muted-foreground">{right}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

/** Small alert row used by the pipeline breakdown lists. */
function AlertRow({ title, sub, right, danger }: { title: string; sub: string; right: React.ReactNode; danger?: boolean }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2.5">
      <span className={`h-2 w-2 shrink-0 rounded-full ${danger ? 'bg-destructive' : 'bg-warning'}`} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold">{title}</p>
        <p className="truncate text-[11px] text-muted-foreground">{sub}</p>
      </div>
      <span className={`shrink-0 text-[12px] font-bold tabular ${danger ? 'text-destructive' : 'text-amber-600 dark:text-warning'}`}>{right}</span>
    </div>
  )
}

export function Dashboard() {
  const container = useStagger()
  const [range, setRange] = useState<RangeKey>('30d')
  const [storeId, setStoreId] = useState<string>('all')

  const storeOptions = useStoreOptions()
  const dash = useDashboard(range, storeId)
  const d = dash.data ? dashboardMetrics(dash.data) : null

  const rangeLabel = RANGE_OPTIONS.find((r) => r.value === range)?.label ?? 'Last 30 days'
  const storeLabel = storeId === 'all' ? 'All stores' : storeOptions.data?.find((s) => s.id === storeId)?.name ?? 'All stores'

  const num = (v: number | null) => (v == null ? '—' : String(v))
  const inr = (v: number | null) => (v == null ? '—' : fmtINR(v))

  const pipeline: Array<{ key: string; label: string; value: number | null; danger?: boolean }> = [
    { key: 'placed', label: 'Pending payment', value: d?.ordersPlaced ?? null },
    { key: 'ofd', label: 'Out for delivery', value: d?.ordersOutForDelivery ?? null },
    { key: 'hold', label: 'On hold', value: d?.ordersOnHold ?? null, danger: true },
    { key: 'cancelled', label: 'Cancelled / expired', value: d?.ordersCancelled ?? null, danger: true },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        title="Operations"
        titleAccent="dashboard"
        subtitle="Live health of stores, orders and money movement across the network."
        artwork="dashboard"
        breadcrumb={['Dashboard']}
        controls={
          <>
            {/* Store filter */}
            <div className="w-44">
              <Select
                value={storeId}
                onValueChange={(v) => setStoreId(v || 'all')}
                options={[{ value: 'all', label: 'All stores' }, ...(storeOptions.data ?? []).map((s) => ({ value: s.id, label: s.name }))]}
              />
            </div>
            {/* Date range chip + popover */}
            <Popover>
              <PopoverTrigger asChild>
                <span>
                  <DateChip label={rangeLabel} active />
                </span>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-48 p-1.5">
                {RANGE_OPTIONS.map((r) => (
                  <button
                    key={r.value}
                    onClick={() => setRange(r.value)}
                    className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-[13px] font-medium transition-colors hover:bg-primary-soft ${range === r.value ? 'font-bold text-brand-700 dark:text-brand-300' : ''}`}
                  >
                    {r.label}
                    {range === r.value && <Check className="h-3.5 w-3.5 text-brand-600" />}
                  </button>
                ))}
              </PopoverContent>
            </Popover>
          </>
        }
      />

      {dash.isError ? (
        <Card className="p-8">
          <EmptyState icon={PackageOpen} title="Dashboard unavailable" body="The metrics service did not respond. Try again shortly." />
        </Card>
      ) : (
        <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-5">
          {/* ── KPI row 1: order pipeline ── */}
          <motion.section variants={container.item} className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
            <KpiCard label="Orders placed" value={d?.ordersPlaced ?? 0} icon={ShoppingCart} tint="violet" />
            <KpiCard label="In progress" value={d?.ordersInProgress ?? 0} icon={Loader} tint="blue" />
            <KpiCard label="Delivered" value={d?.ordersDelivered ?? 0} icon={Truck} tint="green" />
            <KpiCard label="Cancelled / expired" value={d?.ordersCancelled ?? 0} icon={XCircle} tint="red" />
            <KpiCard
              label="On hold"
              value={d?.ordersOnHold ?? 0}
              icon={PauseCircle}
              tint="amber"
              delta={0}
              deltaGood="none"
              highlight={(d?.ordersOnHold ?? 0) > 0}
             
            />
          </motion.section>

          {/* ── KPI row 2: three separate financial figures — never combined ── */}
          <motion.section variants={container.item} className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <KpiCard label="Sales (invoiced)" value={d?.sales ?? 0} format="compact" icon={BadgeIndianRupee} tint="green" />
            <KpiCard label="Wallet top-ups" value={d?.walletTopUps ?? 0} format="compact" icon={Wallet} tint="amber" suffix={storeId !== 'all' && d?.walletTopUps == null ? '(unavailable)' : undefined} />
            <KpiCard label="Refunds processed" value={d?.refundsProcessed ?? 0} format="compact" icon={RotateCcw} tint="red" />
          </motion.section>

          {/* credit notes strip (displayed separately from sales — never merged) */}
          <motion.section variants={container.item}>
            <Card className="flex flex-wrap items-center gap-3 p-4 text-[13px]">
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-muted text-muted-foreground"><Receipt className="h-4 w-4" /></span>
              <span className="font-semibold">Credit notes in period</span>
              <span className="ml-auto font-extrabold tabular">{inr(d?.creditNotes ?? null)}</span>
              <span className="text-xs text-muted-foreground">Net invoiced = {inr(d?.sales ?? null)} − credit notes {inr(d?.creditNotes ?? null)}</span>
            </Card>
          </motion.section>

          {/* ── Main grid ── */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {/* col 7 — store status + pipeline breakdown */}
            <motion.section variants={container.item} className="space-y-4 lg:col-span-7">
              <Card hoverable className="p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
                    <Store className="h-4 w-4 text-brand-600" /> Store status
                    <span className="text-xs font-medium text-muted-foreground">({storeLabel})</span>
                  </h3>
                  <Link to="/stores" className="inline-flex items-center gap-1 text-xs font-bold text-brand-700 hover:underline dark:text-brand-300">
                    Manage stores <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-border/70 bg-success-soft/60 px-4 py-3">
                    <p className="text-xs font-semibold text-muted-foreground">Online</p>
                    <p className="text-[26px] font-extrabold tabular leading-tight text-success">{num(d?.storesOnline ?? null)}</p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3">
                    <p className="text-xs font-semibold text-muted-foreground">Total stores (all-time)</p>
                    <p className="text-[26px] font-extrabold tabular leading-tight">{num(d?.storesTotal ?? null)}</p>
                  </div>
                </div>
                <p className="mt-3 text-[11px] text-muted-foreground">Store counts are a live snapshot, not scoped to the selected period.</p>
              </Card>

              <Card hoverable className="p-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
                    <ClipboardList className="h-4 w-4 text-brand-600" /> Order pipeline ({rangeLabel.toLowerCase()})
                  </h3>
                  <Link to="/orders" className="inline-flex items-center gap-1 text-xs font-bold text-brand-700 hover:underline dark:text-brand-300">
                    All orders <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
                <div className="space-y-1">
                  {pipeline.map((row) => (
                    <AlertRow key={row.key} title={row.label} sub="orders in period" right={num(row.value)} danger={row.danger} />
                  ))}
                </div>
              </Card>
            </motion.section>

            {/* col 5 — customers snapshot + links */}
            <motion.section variants={container.item} className="space-y-4 lg:col-span-5">
              <Card hoverable className="p-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
                    <Users className="h-4 w-4 text-brand-600" /> Customers
                  </h3>
                  <Link to="/people" className="text-xs font-bold text-brand-700 hover:underline dark:text-brand-300">People</Link>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-border/70 bg-primary-softer px-4 py-3">
                    <p className="text-xs font-semibold text-muted-foreground">Registered (all-time)</p>
                    <p className="text-[26px] font-extrabold tabular leading-tight">{num(d?.customersTotal ?? null)}</p>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-success-soft/60 px-4 py-3">
                    <p className="text-xs font-semibold text-muted-foreground">Active</p>
                    <p className="text-[26px] font-extrabold tabular leading-tight text-success">{num(d?.customersActive ?? null)}</p>
                  </div>
                </div>
                <p className="mt-3 text-[11px] text-muted-foreground">All-time snapshot.</p>
              </Card>

              <Card hoverable className="p-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
                    <ClipboardList className="h-4 w-4 text-brand-600" /> Period
                  </h3>
                </div>
                <div className="space-y-1">
                  <PendingLink to="/payments?tab=refunds" label="Refunds processed in period" right={inr(d?.refundsProcessed ?? null)} />
                  <PendingLink to="/reports" label="Detailed reports" right="Open" />
                  <PendingLink to="/approvals" label="Approvals awaiting decision" right="Open" />
                  <PendingLink to="/support" label="Support tickets" right="Open" />
                </div>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Window: {d ? `${fmtDate(d.period.from)} – ${fmtDate(d.period.to)} (IST)` : '—'}
                </p>
              </Card>
            </motion.section>
          </div>
        </motion.div>
      )}
    </div>
  )
}

export default Dashboard
