// §8 Staff & Workload — staff table with workload bars, live picking workload tabs,
// task reassignment, overdue list and workload distribution. No account creation,
// store assignment or scheduling here (admin-only concerns, per spec).
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  AlertTriangle, ClipboardList, Eye, MoveHorizontal, Timer, UsersRound, PlayCircle,
} from 'lucide-react'
import { useStagger } from '@dairydirect/shared/hooks/misc'
import {
  useActiveStoreId, useEligibleAssignees, usePickingTasks, useStoreDashboard, useStoreStaff,
} from '@/api/storeQueries'
import { useStaffActions } from '@/api/storeMutations'
import { useStoreAuth } from '@/login/authStore'
import { DEMO_NOW } from '@dairydirect/shared/mock-db/seed'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Textarea } from '@dairydirect/shared/ui/base'
import { Field, Select } from '@dairydirect/shared/ui/form'
import { EmptyState, PageHeader, SearchInput, StatusPill, TabPills } from '@dairydirect/shared/ui/misc'
import { DataTable, Pagination, type Column } from '@dairydirect/shared/ui/DataTable'
import { KpiCard } from '@dairydirect/shared/ui/KpiCard'
import { InitialAvatar } from '@dairydirect/shared/assets/avatars'
import { PeopleScene } from '@dairydirect/shared/assets/scenes'
import { cn, fmtTime } from '@dairydirect/shared/lib/utils'
import type { LucideIcon } from 'lucide-react'
import type { PickingTask } from '@dairydirect/shared/types'

const PICKER_CAPACITY = 6
const PAGE_SIZE = 5
const REASONS = ['Workload balancing', 'Absence', 'Deadline risk', 'Other']
const REASON_OPTIONS = REASONS.map((r) => ({ value: r, label: r }))

// being_picked has no dedicated shared pill tone — 'picking' renders amber.
const TASK_STATUS_KEY: Record<PickingTask['status'], string> = {
  waiting_to_pick: 'pending',
  being_picked: 'picking',
  ready_to_pack: 'ready',
  ready_for_handover: 'out_for_delivery',
  completed: 'completed',
  cancelled: 'cancelled',
}

type TaskRow = { task: PickingTask; order: { customerName: string; itemCount: number } }

/* ── Decimal KPI (same look as KpiCard; KpiCard rounds to integers) ── */
function DecimalKpi({ label, value, suffix, icon, tint = 'green' }: {
  label: string
  value: number
  suffix?: string
  icon?: LucideIcon
  tint?: 'green' | 'amber' | 'blue' | 'red' | 'violet'
}) {
  const tints = {
    green: 'bg-brand-50 text-brand-700 ring-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:ring-brand-500/20',
    amber: 'bg-amber-50 text-amber-600 ring-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-500/20',
    blue: 'bg-sky-50 text-sky-600 ring-sky-100 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-500/20',
    red: 'bg-rose-50 text-rose-600 ring-rose-100 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-500/20',
    violet: 'bg-violet-50 text-violet-600 ring-violet-100 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-500/20',
  }
  const Icon = icon
  return (
    <motion.div
      variants={{ hidden: { opacity: 0, y: 16 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } } }}
      className="group relative overflow-hidden rounded-card border border-border/70 bg-card p-4 shadow-soft transition-all duration-300 hover:-translate-y-1 hover:shadow-lift sm:p-5"
    >
      <div className="flex items-start justify-between gap-2.5">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-muted-foreground">{label}</div>
          <div className="mt-1.5 text-[23px] font-extrabold leading-none tracking-tight tabular sm:text-[25px]">
            {value.toFixed(1)}{suffix}
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

const LEVEL_TONE = { High: 'red', Medium: 'amber', Low: 'green' } as const
const LEVEL_BAR = { High: 'bg-destructive', Medium: 'bg-warning', Low: 'bg-success' } as const

function WorkloadBar({ activeTasks, level }: { activeTasks: number; level: 'High' | 'Medium' | 'Low' }) {
  const pct = Math.min(100, Math.round((activeTasks / PICKER_CAPACITY) * 100))
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-20 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className={cn('h-full rounded-full transition-all', LEVEL_BAR[level])} style={{ width: `${pct}%` }} />
      </div>
      <Badge tone={LEVEL_TONE[level]}>{level}</Badge>
    </div>
  )
}

export function StoreStaffWorkload() {
  const storeId = useActiveStoreId()
  const stagger = useStagger()
  const navigate = useNavigate()
  const staffActions = useStaffActions()
  const user = useStoreAuth((s) => s.user)

  const [staffSearch, setStaffSearch] = useState('')
  const [workloadTab, setWorkloadTab] = useState('active')
  const [workloadPage, setWorkloadPage] = useState(1)
  const [reassignTaskId, setReassignTaskId] = useState('')
  const [reassignToId, setReassignToId] = useState('')
  const [reason, setReason] = useState('')
  const [notes, setNotes] = useState('')

  const staffQ = useStoreStaff(storeId)
  const dash = useStoreDashboard(storeId)
  const tasksQ = usePickingTasks(storeId, 'all')
  const staff = staffQ.data ?? []
  const allTasks = tasksQ.data ?? []

  const beingPicked = useMemo(() => allTasks.filter((r) => r.task.status === 'being_picked'), [allTasks])
  const overdueTasks = useMemo(
    () => allTasks
      .filter((r) => (r.task.status === 'waiting_to_pick' || r.task.status === 'being_picked') && new Date(r.task.deadline).getTime() < DEMO_NOW.getTime())
      .sort((a, b) => a.task.deadline.localeCompare(b.task.deadline)),
    [allTasks],
  )
  const overdueBeingPicked = overdueTasks.filter((r) => r.task.status === 'being_picked')
  const myTasks = useMemo(() => beingPicked.filter((r) => r.task.assigneeId === user?.id), [beingPicked, user?.id])
  const activePickers = staff.filter((s) => s.status === 'active' && s.activeTasks > 0).length

  const workloadRows = workloadTab === 'mine' ? myTasks : workloadTab === 'overdue' ? overdueBeingPicked : beingPicked
  const totalPages = Math.max(1, Math.ceil(workloadRows.length / PAGE_SIZE))
  const pageRows = workloadRows.slice((workloadPage - 1) * PAGE_SIZE, workloadPage * PAGE_SIZE)

  const selectedTask = beingPicked.find((r) => r.task.id === reassignTaskId)?.task ?? null
  const assigneesQ = useEligibleAssignees(storeId, selectedTask?.assigneeId ?? null)
  const assignees = assigneesQ.data ?? []
  const reassignTo = assignees.find((a) => a.id === reassignToId) ?? null
  const reassignValid = !!selectedTask && !!reassignTo && !!reason
  const composedReason = notes.trim() ? `${reason} — ${notes.trim()}` : reason

  const submitReassign = () => {
    if (!reassignValid) return
    staffActions.reassign(selectedTask!.id, reassignTo!.id, reassignTo!.name, composedReason) // toast from mutation
    setReassignTaskId(''); setReassignToId(''); setReason(''); setNotes('')
  }

  const staffRows = useMemo(() => {
    const q = staffSearch.trim().toLowerCase()
    return q ? staff.filter((s) => s.name.toLowerCase().includes(q)) : staff
  }, [staff, staffSearch])

  const staffColumns: Column<(typeof staff)[number]>[] = [
    {
      key: 'name', header: 'Staff Member',
      render: (s) => (
        <span className="flex items-center gap-2.5">
          <InitialAvatar name={s.name} size={30} />
          <span className="font-medium">{s.name}</span>
        </span>
      ),
    },
    { key: 'role', header: 'Role', render: () => <Badge tone="blue">Store manager</Badge> },
    { key: 'activeTasks', header: 'Active Tasks', align: 'center', render: (s) => <span className="font-bold tabular">{s.activeTasks}</span> },
    { key: 'status', header: 'Status', render: (s) => <StatusPill status={s.status} dot /> },
    { key: 'workload', header: 'Workload', render: (s) => <WorkloadBar activeTasks={s.activeTasks} level={s.level} /> },
  ]

  const workloadColumns: Column<TaskRow>[] = [
    { key: 'id', header: 'Task ID', render: (r) => <span className="font-semibold tabular">{r.task.id}</span> },
    { key: 'orderId', header: 'Order ID', render: (r) => <span className="tabular text-muted-foreground">{r.task.orderId}</span> },
    {
      key: 'assignee', header: 'Assignee',
      render: (r) => {
        const name = staff.find((s) => s.id === r.task.assigneeId)?.name
        return name
          ? <span className="flex items-center gap-2"><InitialAvatar name={name} size={24} /> {name}</span>
          : <span className="text-muted-foreground">Unassigned</span>
      },
    },
    { key: 'items', header: 'Items', align: 'center', render: (r) => <span className="tabular">{r.order.itemCount}</span> },
    {
      key: 'deadline', header: 'Deadline',
      render: (r) => {
        const overdue = new Date(r.task.deadline).getTime() < DEMO_NOW.getTime()
        return <span className={cn('whitespace-nowrap tabular font-semibold', overdue ? 'text-destructive' : 'text-muted-foreground')}>{fmtTime(r.task.deadline)}</span>
      },
    },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={TASK_STATUS_KEY[r.task.status]} /> },
    {
      key: 'action', header: 'Action',
      render: (r) => (
        <Button variant="ghost" size="iconSm" aria-label={`View task ${r.task.id}`} onClick={(e) => { e.stopPropagation(); navigate(`/orders-picking?focus=${r.task.id}`) }}>
          <Eye className="h-4 w-4" />
        </Button>
      ),
    },
  ]

  return (
    <motion.div variants={stagger.container} initial="hidden" animate="show" className="space-y-5">
      <PageHeader
        breadcrumb={['Staff & Workload']}
        title="Staff &"
        titleAccent="Workload"
        subtitle="View your store staff, their current picking workload and reassign tasks when needed."
        illustration={<PeopleScene />}
      />

      {/* ── KPI row ── */}
      <motion.section variants={stagger.item} className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Total Staff (This Store)" value={staff.length} icon={UsersRound} tint="green" />
        <KpiCard label="Active Pickers" value={activePickers} icon={PlayCircle} tint="blue" />
        <KpiCard label="Active Picking Tasks" value={beingPicked.length} icon={ClipboardList} tint="amber" />
        <KpiCard label="Overdue Tasks" value={overdueTasks.length} icon={AlertTriangle} tint="red" />
        <DecimalKpi label="Avg. Tasks per Staff" value={dash.data?.avgTasksPerActivePicker ?? 0} icon={UsersRound} tint="violet" />
        <DecimalKpi label="Avg. Picking Time" value={dash.data?.avgPickingTimeMin ?? 0} suffix=" min" icon={Timer} tint="green" />
      </motion.section>

      <motion.section variants={stagger.item} className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* ── Store staff ── */}
        <Card hoverable className="lg:col-span-5">
          <CardHeader className="flex-col items-stretch gap-3 xl:flex-row xl:items-center">
            <CardTitle>Store Staff ({staff.length})</CardTitle>
            <SearchInput value={staffSearch} onChange={setStaffSearch} placeholder="Search staff by name…" className="w-full xl:w-56" />
          </CardHeader>
          <CardContent>
            <DataTable
              columns={staffColumns}
              rows={staffRows}
              keyId={(s) => s.id}
              loading={staffQ.isLoading}
              skeletonRows={6}
              empty={<EmptyState icon={UsersRound} title="No staff found" body="Team members assigned to this store will appear here." />}
            />
          </CardContent>
        </Card>

        {/* ── Current picking workload ── */}
        <Card hoverable className="lg:col-span-4">
          <CardHeader><CardTitle>Current Picking Workload</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <TabPills
              id="workload-tabs"
              value={workloadTab}
              onChange={(v) => { setWorkloadTab(v); setWorkloadPage(1) }}
              tabs={[
                { value: 'active', label: 'Active Tasks', count: beingPicked.length },
                { value: 'mine', label: 'My Team Tasks', count: myTasks.length },
                { value: 'overdue', label: 'Overdue Only', count: overdueBeingPicked.length },
              ]}
            />
            <DataTable
              columns={workloadColumns}
              rows={pageRows}
              keyId={(r) => r.task.id}
              loading={tasksQ.isLoading}
              skeletonRows={5}
              empty={<EmptyState icon={ClipboardList} title="No tasks in this view" body="Being-picked tasks appear here with live deadlines." />}
            />
            <Pagination page={workloadPage} totalPages={totalPages} onChange={setWorkloadPage} />
          </CardContent>
        </Card>

        {/* ── Overdue tasks ── */}
        <Card hoverable className="border-destructive/25 bg-destructive-soft/30 lg:col-span-3">
          <CardHeader><CardTitle className="flex items-center gap-2 text-destructive"><AlertTriangle className="h-4 w-4" /> Overdue Tasks ({overdueTasks.length})</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {tasksQ.isLoading ? (
              Array.from({ length: 3 }).map((_, i) => <div key={i} className="skeleton h-14 rounded-xl" />)
            ) : overdueTasks.length === 0 ? (
              <p className="rounded-xl bg-card px-3 py-4 text-center text-xs text-muted-foreground">Nothing overdue — the queue is healthy.</p>
            ) : (
              overdueTasks.slice(0, 5).map((r) => {
                const mins = Math.max(1, Math.floor((DEMO_NOW.getTime() - new Date(r.task.deadline).getTime()) / 60000))
                return (
                  <div key={r.task.id} className="rounded-xl border border-destructive/25 bg-card p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13.5px] font-bold tabular">{r.task.id}</span>
                      <Badge tone="red">Overdue by {mins} min</Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{r.task.orderId} · {r.order.itemCount} items</div>
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>
      </motion.section>

      <motion.section variants={stagger.item} className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* ── Reassign picking task ── */}
        <Card hoverable className="lg:col-span-5">
          <CardHeader><CardTitle className="flex items-center gap-2"><MoveHorizontal className="h-4 w-4 text-brand-600" /> Reassign Picking Task</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <Field label="Task to Reassign" required>
              <Select
                value={reassignTaskId}
                onValueChange={(v) => { setReassignTaskId(v); setReassignToId('') }}
                placeholder="Tasks being picked right now…"
                options={beingPicked.map((r) => ({ value: r.task.id, label: `${r.task.id} (${r.task.orderId})` }))}
              />
            </Field>
            <Field
              label="Reassign To"
              required
              error={reassignTaskId && assignees.length === 0 ? 'No eligible assignee — other active staff are at capacity or inactive' : undefined}
            >
              <Select
                value={reassignToId}
                onValueChange={setReassignToId}
                placeholder={reassignTaskId ? 'Active staff, excluding current assignee…' : 'Pick a task first'}
                disabled={!reassignTaskId}
                options={assignees.map((a) => ({ value: a.id, label: `${a.name} (${a.activeTasks} active)` }))}
              />
            </Field>
            <Field label="Reason" required error={!reason && reassignTaskId ? 'Pick a reason' : undefined}>
              <Select value={reason} onValueChange={setReason} options={REASON_OPTIONS} placeholder="Why reassign?" />
            </Field>
            <Field label="Notes (optional)">
              <Textarea
                value={notes}
                maxLength={200}
                onChange={(e) => setNotes(e.target.value.slice(0, 200))}
                placeholder="Context for the new assignee…"
                aria-label="Reassignment notes"
              />
            </Field>
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => { setReassignTaskId(''); setReassignToId(''); setReason(''); setNotes('') }}>Cancel</Button>
              <Button disabled={!reassignValid} onClick={submitReassign}>
                <MoveHorizontal className="h-4 w-4" /> Reassign Task
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Workload distribution ── */}
        <Card hoverable className="lg:col-span-7">
          <CardHeader><CardTitle>Workload Distribution</CardTitle></CardHeader>
          <CardContent className="space-y-3.5">
            {staffQ.isLoading
              ? Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-6 rounded-full" />)
              : staff.map((s) => {
                  const pct = Math.min(100, Math.round((s.activeTasks / PICKER_CAPACITY) * 100))
                  return (
                    <div key={s.id} className="flex items-center gap-3">
                      <span className="w-32 shrink-0 truncate text-[13px] font-semibold" title={s.name}>{s.name}</span>
                      <div className="h-3 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                        <div
                          className={cn('h-full rounded-full transition-all duration-500', s.activeTasks >= 4 ? 'bg-destructive' : s.activeTasks >= 2 ? 'bg-warning' : 'bg-success')}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-28 shrink-0 text-right text-xs tabular text-muted-foreground">{s.activeTasks} tasks ({pct}%)</span>
                    </div>
                  )
                })}
            <p className="pt-1 text-[11px] text-muted-foreground">Bars show concurrent tasks vs a capacity of {PICKER_CAPACITY}: red ≥ 4, amber 2–3, green ≤ 1. Inactive staff carry no active tasks.</p>
          </CardContent>
        </Card>
      </motion.section>
    </motion.div>
  )
}
