import { firstFailedQuery, PageLoadError } from '@/components/PageLoadError'
// §1 Store Dashboard — greeting hero, KPI row, store status, picking overview,
// quick actions, attention list, status donut, staff workload, upcoming tasks.
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  AlertTriangle, ArrowRight, Banknote, CheckCircle2, ChevronRight, ClipboardList,
  Clock, Package, PackagePlus, Pause, Play, Repeat, ScanLine, ShoppingCart, UserCheck, UsersRound,
} from 'lucide-react'
import {
  CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { useStagger, useCountUp } from '@dairydirect/shared/hooks/misc'
import { useStoreAuth } from '@/login/authStore'
import { useActiveStoreId, useStoreDashboard } from '@/api/storeQueries'
import { useStoreStatusActions } from '@/api/storeMutations'
import { Button, Card, CardContent, CardHeader, CardTitle, Label, Skeleton } from '@dairydirect/shared/ui/base'
import { Dialog, DialogContent } from '@dairydirect/shared/ui/overlays'
import { Select } from '@dairydirect/shared/ui/form'
import { StatusPill, TabPills, EmptyState, PageArtwork } from '@dairydirect/shared/ui/misc'
import { KpiCard } from '@dairydirect/shared/ui/KpiCard'
import { DonutChart, ChartTooltip } from '@dairydirect/shared/ui/charts'
import { DataTable } from '@dairydirect/shared/ui/DataTable'
import { InitialAvatar } from '@dairydirect/shared/assets/avatars'
import { cn, fmtTime } from '@dairydirect/shared/lib/utils'
import type { StoreDashboardSummary } from '@/api/storeSelectors'
import type { LucideIcon } from 'lucide-react'

// A picker is considered at capacity at 6 concurrent tasks (drives the level bar).
const PICKER_CAPACITY = 6

const PAUSE_REASONS = ['Stock receipt delayed', 'Staff shortage', 'Maintenance', 'Other']

const QUICK_ACTIONS: Array<{ label: string; to: string; icon: LucideIcon }> = [
  { label: 'View Orders', to: '/orders-picking', icon: ShoppingCart },
  { label: 'Receive Stock', to: '/inventory?tab=receive', icon: PackagePlus },
  { label: 'Scan & Pick', to: '/orders-picking?focus=queue', icon: ScanLine },
  { label: 'Record Deposit', to: '/cod-deposits', icon: Banknote },
]

/* ── Decimal KPI (same look as KpiCard, keeps one decimal place) ── */
function DecimalKpi({ label, value, suffix, icon: Icon, tint = 'amber' }: {
  label: string
  value: number
  suffix?: string
  icon?: LucideIcon
  tint?: 'green' | 'amber' | 'blue' | 'red' | 'violet'
}) {
  const display = useCountUp(value)
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
      className="group relative overflow-hidden rounded-card border border-border/70 bg-card p-4 shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-lift sm:p-5"
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-muted-foreground">{label}</div>
          <div className="mt-1.5 text-[23px] font-extrabold leading-none tracking-tight tabular sm:text-[25px]">
            {display.toFixed(1)}{suffix}
          </div>
        </div>
        {Icon && (
          <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1', tints[tint])}>
            <Icon className="h-5 w-5" strokeWidth={2} />
          </div>
        )}
      </div>
    </motion.div>
  )
}

/* ── Attention row (icon tile + label + tinted count + chevron) ── */
function AttentionRow({ to, label, count, icon: Icon, tone }: {
  to: string
  label: string
  count: number
  icon: LucideIcon
  tone: 'red' | 'amber' | 'blue'
}) {
  const tones = {
    red: { tile: 'bg-destructive-soft text-destructive', count: 'bg-destructive-soft text-destructive' },
    amber: { tile: 'bg-warning-soft text-amber-600 dark:text-warning', count: 'bg-warning-soft text-amber-600 dark:text-warning' },
    blue: { tile: 'bg-info-soft text-info', count: 'bg-info-soft text-info' },
  }
  return (
    <Link to={to} className="group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-primary-soft">
      <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg', tones[tone].tile)}>
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{label}</span>
      <span className={cn('rounded-full px-2.5 py-1 text-[11.5px] font-bold tabular', tones[tone].count)}>{count}</span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

/* ── Staff workload row ── */
function StaffRow({ name, activeTasks, status }: { name: string; activeTasks: number; status: 'active' | 'inactive' }) {
  const pct = Math.min(100, Math.round((activeTasks / PICKER_CAPACITY) * 100))
  return (
    <div className="flex items-center gap-3 py-2">
      <InitialAvatar name={name} size={34} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-semibold">{name}</span>
          <StatusPill status={status} className="px-2 py-0.5 text-[10px]" />
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[11px] font-medium text-muted-foreground tabular">{activeTasks} / {PICKER_CAPACITY} tasks</span>
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
            <div className={cn('h-full rounded-full transition-all duration-500', pct >= 80 ? 'bg-destructive' : pct >= 50 ? 'bg-warning' : 'bg-success')} style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[11px] font-bold tabular text-muted-foreground">{pct}%</span>
        </div>
      </div>
    </div>
  )
}

export function StoreDashboard() {
  const container = useStagger()
  const user = useStoreAuth((s) => s.user)
  const storeId = useActiveStoreId()
  const dashQ = useStoreDashboard(storeId)
  const d = dashQ.data
  const statusActions = useStoreStatusActions()

  // real-time greeting
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening'
  const firstName = (user?.name ?? 'Manager').split(' ')[0]

  // pause dialog state
  const [pauseOpen, setPauseOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [details, setDetails] = useState('')

  // upcoming tasks filter tab
  const [upcomingTab, setUpcomingTab] = useState('all')

  const donutSegments = useMemo(() => {
    if (!d) return []
    return [
      { key: 'waiting', label: 'Waiting to Pick', value: d.byStatus.waiting, color: '#2E7D1A' },
      { key: 'beingPicked', label: 'Being Picked', value: d.byStatus.beingPicked, color: '#7FCB62' },
      { key: 'readyToPack', label: 'Ready to Pack', value: d.byStatus.readyToPack, color: '#F5A623' },
      { key: 'readyHandover', label: 'Ready for Handover', value: d.byStatus.readyHandover, color: '#FBD38D' },
    ]
  }, [d])

  const upcomingRows = useMemo(() => {
    if (!d) return []
    if (upcomingTab === 'overdue') return d.upcoming.filter((u) => u.overdue)
    if (upcomingTab === 'dueSoon') return d.upcoming.filter((u) => !u.overdue)
    return d.upcoming
  }, [d, upcomingTab])

  const totalTasks = d ? d.byStatus.waiting + d.byStatus.beingPicked + d.byStatus.readyToPack + d.byStatus.readyHandover : 0
  const paused = d?.storeStatus === 'paused'

  const loadFailure = firstFailedQuery([dashQ])
  if (loadFailure) return <PageLoadError title="Store Dashboard" artwork="dashboard" query={loadFailure} />

  return (
    <>
      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-5">
        {/* ── Greeting hero (custom header: animated wave + bold store name) ── */}
        <div className="relative flex min-w-0 flex-1 flex-col gap-2 sm:min-h-[170px] sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="relative z-10 min-w-0 flex-1 pb-1"
          >
            <nav className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground" aria-label="Breadcrumb">
              <span>Home</span>
              <ChevronRight className="h-3 w-3 opacity-60" />
              <span className="text-foreground/80">Store Dashboard</span>
            </nav>
            <h1 className="text-[30px] font-extrabold leading-tight tracking-tight sm:text-display">
              Good {greeting}, <span className="text-gradient">{firstName}!</span>{' '}
              <motion.span
                aria-hidden
                className="inline-block origin-bottom-right"
                animate={{ rotate: [0, 18, -10, 18, 0] }}
                transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut', repeatDelay: 0.5 }}
              >
                👋
              </motion.span>
            </h1>
            <p className="mt-1.5 max-w-xl text-sm text-muted-foreground">
              Here&apos;s what needs your attention at <strong className="font-bold text-foreground">{d?.storeName ?? 'your store'}</strong> today.
            </p>
          </motion.div>
          <PageArtwork artwork="dashboard" />
        </div>

        {/* ── KPI row ── */}
        {d ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <KpiCard label="Open Picking Tasks" value={d.openPickingTasks} icon={ClipboardList} tint="green" highlight />
            <KpiCard label="Completed Today" value={d.completedToday} icon={CheckCircle2} tint="green" />
            <KpiCard label="Deadline Breaches" value={d.deadlineBreaches} icon={AlertTriangle} tint="red" />
            <DecimalKpi label="Avg. Picking Time" value={d.avgPickingTimeMin} suffix=" min" icon={Clock} tint="amber" />
            <KpiCard label="Substituted / Unavailable" value={d.substitutedRatePct} format="pct" icon={Repeat} tint="violet" />
            <KpiCard label="Pending Rider Apps" value={d.pendingRiderApps} icon={UserCheck} tint="blue" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[108px] rounded-card" />)}
          </div>
        )}

        {/* ── Store status · picking overview · quick actions ── */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <motion.div variants={container.item} className="lg:col-span-4">
            <Card hoverable className="h-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary-soft text-brand-700 dark:text-brand-300"><ShoppingCart className="h-4 w-4" /></span>
                  Store Status
                </CardTitle>
                {d && <StatusPill status={d.storeStatus} dot className="px-3 py-1.5 text-[12px]" />}
              </CardHeader>
              <CardContent className="flex h-[calc(100%-64px)] flex-col justify-between gap-4">
                <p className="text-[13px] text-muted-foreground">
                  {paused ? 'Store is paused.' : d?.storeStatus === 'offline' ? 'Store is offline.' : 'Store is currently accepting orders.'}
                  {d?.storeCode && <span className="ml-1 font-semibold text-foreground/70">({d.storeCode})</span>}
                </p>
                {d && paused && !d.storeCanResume ? (
                  <div className="space-y-2">
                    <Button variant="success" size="pill" className="w-full" disabled aria-label="Resume unavailable">
                      <Play className="h-4 w-4" /> Resume Store
                    </Button>
                    {d?.storeRestrictionReason === 'PAUSE_MANAGED_BY_ADMIN' && (
                      <p className="text-[11.5px] text-muted-foreground">This pause is managed by the admin or the system and cannot be resumed here.</p>
                    )}
                  </div>
                ) : paused ? (
                  <Button
                    variant="success"
                    size="pill"
                    className="w-full"
                    onClick={() => storeId && statusActions.resume(storeId)}
                    aria-label="Resume store"
                  >
                    <Play className="h-4 w-4" /> Resume Store
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="pill"
                    className="w-full"
                    disabled={d ? !d.storeCanPause : false}
                    onClick={() => { setReason(''); setDetails(''); setPauseOpen(true) }}
                    aria-label="Pause store"
                  >
                    <Pause className="h-4 w-4" /> Pause Store
                  </Button>
                )}
              </CardContent>
            </Card>
          </motion.div>

          <motion.div variants={container.item} className="lg:col-span-5">
            <Card hoverable className="h-full">
              <CardHeader>
                <CardTitle>Today&apos;s Picking Overview</CardTitle>
                <div className="flex items-center gap-4 text-[11px] font-semibold text-muted-foreground">
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#2E7D1A]" /> Completed</span>
                  <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#A3D977]" /> Open</span>
                </div>
              </CardHeader>
              <CardContent>
                {d ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={d.hourly} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                      <CartesianGrid strokeDasharray="4 8" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 10.5, fill: 'hsl(var(--muted-foreground))' }} dy={6} />
                      <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10.5, fill: 'hsl(var(--muted-foreground))' }} allowDecimals={false} width={40} />
                      <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#2E7D1A', strokeOpacity: 0.2 }} />
                      <Line type="monotone" dataKey="completed" name="Completed" stroke="#2E7D1A" strokeWidth={2.4} animationDuration={650}
                        dot={{ r: 3, strokeWidth: 2, stroke: '#fff', fill: '#2E7D1A' }} activeDot={{ r: 5, strokeWidth: 2, stroke: '#fff' }} />
                      <Line type="monotone" dataKey="open" name="Open" stroke="#A3D977" strokeWidth={2.4} animationDuration={650}
                        dot={{ r: 3, strokeWidth: 2, stroke: '#fff', fill: '#A3D977' }} activeDot={{ r: 5, strokeWidth: 2, stroke: '#fff' }} />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <Skeleton className="h-[200px] rounded-xl" />
                )}
              </CardContent>
            </Card>
          </motion.div>

          <motion.div variants={container.item} className="lg:col-span-3">
            <Card hoverable className="h-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span className="text-warning">⚡</span> Quick Actions
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-3">
                  {QUICK_ACTIONS.map((a) => (
                    <Link
                      key={a.label}
                      to={a.to}
                      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-border/70 bg-primary-soft/60 px-2 py-4 text-center text-[12.5px] font-bold text-brand-800 transition-all hover:-translate-y-0.5 hover:border-brand-300 hover:bg-primary-soft dark:text-brand-300"
                    >
                      <a.icon className="h-5 w-5 text-brand-700 dark:text-brand-300" />
                      {a.label}
                    </Link>
                  ))}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* ── Attention · donut · staff workload ── */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          <motion.div variants={container.item} className="lg:col-span-4">
            <Card hoverable className="h-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <span className="grid h-7 w-7 place-items-center rounded-lg bg-warning-soft text-amber-600 dark:text-warning"><BellIcon /></span>
                  Attention Needed
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {d ? (
                  <>
                    <AttentionRow to="/inventory?tab=low" label="Low Stock Items" count={d.lowStockCount} icon={Package} tone="red" />
                    <AttentionRow to="/inventory?tab=expiring" label="Expiring in ≤ 7 Days" count={d.expiringCount} icon={Clock} tone="amber" />
                    <AttentionRow to="/orders-picking" label="Picking Deadlines (At Risk)" count={d.dueSoonCount} icon={AlertTriangle} tone="amber" />
                    <AttentionRow to="/rider-applications?status=pending" label="Pending Rider Applications" count={d.pendingRiderApps} icon={UserCheck} tone="blue" />
                  </>
                ) : (
                  Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-11 rounded-xl" />)
                )}
              </CardContent>
            </Card>
          </motion.div>

          <motion.div variants={container.item} className="lg:col-span-4">
            <Card hoverable className="h-full">
              <CardHeader>
                <CardTitle>Picking Tasks by Status</CardTitle>
              </CardHeader>
              <CardContent>
                {d ? (
                  <DonutChart segments={donutSegments} centerLabel={`${totalTasks}`} centerSub="Tasks" height={200} size={150} />
                ) : (
                  <Skeleton className="h-[200px] rounded-xl" />
                )}
              </CardContent>
            </Card>
          </motion.div>

          <motion.div variants={container.item} className="lg:col-span-4">
            <Card hoverable className="h-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <UsersRound className="h-4 w-4 text-brand-600" /> Staff Workload (Active Picking)
                </CardTitle>
                <Link to="/staff-workload" className="flex items-center gap-1 text-[12px] font-bold text-brand-700 hover:underline dark:text-brand-300">
                  View All <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </CardHeader>
              <CardContent className="space-y-1">
                {d
                  ? d.staffWorkload.map((w) => <StaffRow key={w.id} name={w.name} activeTasks={w.activeTasks} status={w.status} />)
                  : Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)}
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* ── Upcoming & overdue picking tasks ── */}
        <motion.div variants={container.item}>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-brand-600" /> Upcoming &amp; Overdue Picking Tasks
              </CardTitle>
              <Link to="/orders-picking" className="flex items-center gap-1 text-[12px] font-bold text-brand-700 hover:underline dark:text-brand-300">
                View All Orders <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </CardHeader>
            <CardContent className="pt-0">
              <TabPills
                id="dash-upcoming"
                value={upcomingTab}
                onChange={setUpcomingTab}
                tabs={[
                  { value: 'all', label: 'All', count: d ? d.upcoming.length : 0 },
                  { value: 'overdue', label: 'Overdue', count: d?.overdueCount ?? 0 },
                  { value: 'dueSoon', label: 'Due Soon', count: d?.dueSoonCount ?? 0 },
                ]}
                className="mb-3 w-fit"
              />
              <DataTable<StoreDashboardSummary['upcoming'][number]>
                columns={[
                  { key: 'orderId', header: 'Order ID', render: (r) => <span className="font-bold">#{r.orderId}</span> },
                  { key: 'customerName', header: 'Customer' },
                  { key: 'itemCount', header: 'Items', render: (r) => <span className="tabular">{r.itemCount} items</span> },
                  {
                    key: 'dueBy', header: 'Due By',
                    render: (r) => (
                      <span className={cn('font-semibold tabular', r.overdue ? 'text-destructive' : 'text-amber-600 dark:text-warning')}>
                        {fmtTime(r.dueBy)} {r.overdue ? '(Overdue)' : '(Due Soon)'}
                      </span>
                    ),
                  },
                  { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
                  { key: 'assigneeName', header: 'Assigned To', render: (r) => r.assigneeName ?? '—' },
                  {
                    key: 'action', header: 'Action', align: 'right',
                    render: (r) => (
                      <Link to={`/orders-picking?focus=${r.taskId}`} onClick={(e) => e.stopPropagation()}>
                        <Button size="sm" variant="outline">View</Button>
                      </Link>
                    ),
                  },
                ]}
                rows={upcomingRows}
                keyId={(r) => r.taskId}
                loading={!d}
                skeletonRows={4}
                empty={<EmptyState icon={Clock} title="Nothing at risk" body="No overdue or due-soon picking tasks right now." />}
              />
            </CardContent>
          </Card>
        </motion.div>
      </motion.div>

      {/* ── Pause store dialog ── */}
      <Dialog open={pauseOpen} onOpenChange={setPauseOpen}>
        <DialogContent
          title="Pause Store"
          description="Customers can't place new orders while the store is paused. You can resume at any time."
        >
          <div className="space-y-4">
            <div>
              <Label required>Reason</Label>
              <Select
                value={reason}
                onValueChange={setReason}
                placeholder="Select a reason…"
                options={PAUSE_REASONS.map((r) => ({ value: r, label: r }))}
              />
            </div>
            <div>
              <Label>Details (optional)</Label>
              <textarea
                value={details}
                maxLength={200}
                onChange={(e) => setDetails(e.target.value)}
                placeholder="Add context for the admin team…"
                className="min-h-[72px] w-full rounded-xl border border-input bg-card px-3.5 py-2.5 text-sm shadow-innersoft transition-colors placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              />
              <p className="mt-1 text-right text-[11px] text-muted-foreground tabular">{details.length}/200</p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" size="md" onClick={() => setPauseOpen(false)}>Cancel</Button>
              <Button
                variant="primary"
                size="md"
                disabled={!reason}
                onClick={() => {
                  if (!storeId || !reason) return
                  statusActions.pause(storeId, details.trim() ? `${reason} — ${details.trim()}` : reason)
                  setPauseOpen(false)
                }}
              >
                <Pause className="h-4 w-4" /> Pause Store
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

/* Small bell glyph kept local to avoid another lucide import alias clash. */
function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}
