import { firstFailedQuery, PageLoadError } from '@/components/PageLoadError'
// §2 Orders & Picking — the main picking screen: KPIs, queue tabs, task table and the
// right-hand Picking Workspace drawer (Pick Items → Pack Order → Handover).
import { Fragment, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  Bike, Boxes, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight,
  ClipboardList, Minus, Package, PackageCheck, PackageOpen, PackageX, Plus,
  ScanLine, ShoppingCart, User, XCircle,
} from 'lucide-react'
import { useStagger, useDebouncedValue } from '@dairydirect/shared/hooks/misc'
import { useStoreAuth } from '@/login/authStore'
import { useActiveStoreId, useStoreDashboard, usePickingTasks, usePickingTask } from '@/api/storeQueries'
import { usePickingActions } from '@/api/storeMutations'
import { Button, Card, Input, Label, Switch, Badge, Skeleton } from '@dairydirect/shared/ui/base'
import { Drawer, ConfirmDialog, Popover, PopoverTrigger, PopoverContent, Tooltip, TooltipProvider } from '@dairydirect/shared/ui/overlays'
import { Select } from '@dairydirect/shared/ui/form'
import { PageHeader, TabPills, SearchInput, StatusPill, EmptyState } from '@dairydirect/shared/ui/misc'
import { KpiCard } from '@dairydirect/shared/ui/KpiCard'
import { DataTable, Pagination, type Column } from '@dairydirect/shared/ui/DataTable'
import { ProductTile } from '@dairydirect/shared/assets/productIcons'
import { cn, fmtTime, fmtDate } from '@dairydirect/shared/lib/utils'
import { toast } from '@dairydirect/shared/lib/toast'
import type { PickingTask, PickLine, SubstituteCandidate } from '@dairydirect/shared/types'

type TaskRow = { task: PickingTask; order: { customerName: string; itemCount: number } }

const UNAVAILABLE_REASONS: Record<string, 'OUT_OF_STOCK' | 'DAMAGED' | 'EXPIRED' | 'NOT_FOUND'> = {
  'Damaged in cold storage': 'DAMAGED',
  'Not received today': 'OUT_OF_STOCK',
  'Expired — quarantined': 'EXPIRED',
  Other: 'NOT_FOUND',
}
const STEPS = ['Pick Items', 'Pack Order', 'Handover']

function DeadlineChip({ deadline, className }: { deadline: string; className?: string }) {
  const mins = Math.round((new Date(deadline).getTime() - Date.now()) / 60000)
  if (mins < 0) {
    return <span className={cn('inline-flex items-center rounded-full bg-destructive-soft px-2 py-0.5 text-[10px] font-bold text-destructive tabular', className)}>Overdue {-mins}m</span>
  }
  if (mins <= 30) {
    return <span className={cn('inline-flex items-center rounded-full bg-warning-soft px-2 py-0.5 text-[10px] font-bold text-amber-600 tabular dark:text-warning', className)}>{mins}m left</span>
  }
  return <span className={cn('inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold text-muted-foreground tabular', className)}>{Math.floor(mins / 60)}h {mins % 60}m left</span>
}

/* ── 3-step stepper ──────────────────────────────────────────────────────────── */
function Stepper({ step }: { step: 1 | 2 | 3 | 4 }) {
  // step 4 = completed → everything done
  return (
    <div className="flex flex-wrap items-center gap-y-2">
      {STEPS.map((label, i) => {
        const done = i + 1 < step
        const current = i + 1 === step
        return (
          <Fragment key={label}>
            {i > 0 && <span className={cn('mx-2 h-0.5 w-6 rounded sm:w-10', i < step - 1 ? 'bg-success' : 'bg-border')} aria-hidden />}
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'grid h-7 w-7 place-items-center rounded-full text-[12px] font-bold transition-colors',
                  done && 'bg-success text-white',
                  current && 'gradient-primary text-white shadow-pill ring-4 ring-primary-softer',
                  !done && !current && 'bg-muted text-muted-foreground',
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className={cn('text-[13px] font-bold', current ? 'text-foreground' : !done ? 'text-muted-foreground' : 'text-foreground/70')}>
                {label}
              </span>
            </div>
          </Fragment>
        )
      })}
    </div>
  )
}

/* ── Substitute picker (popover list; ineligible items disabled with reason) ── */
function SubstitutePicker({ line, onPick }: {
  line: PickLine
  onPick: (candidate: SubstituteCandidate) => void
}) {
  const [open, setOpen] = useState(false)
  const candidates = [...line.substitutionCandidates].sort((a, b) => a.name.localeCompare(b.name))
  const chosen = line.substitutionVariantId
    ? candidates.find((c) => c.variantId === line.substitutionVariantId)?.name ?? 'Substitute recorded'
    : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 border-brand-600/50 text-brand-700 dark:text-brand-300" aria-label={`Substitute ${line.name}`}>
          <Check className="h-3.5 w-3.5" /> Substitute{chosen ? `: ${chosen}` : ''}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-2">
        <p className="px-2 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          Eligible substitutes (same category · in stock · ±40% price)
        </p>
        <div className="scrollbar-thin max-h-64 space-y-0.5 overflow-y-auto">
          {candidates.length === 0 && <p className="px-2 py-3 text-[12px] text-muted-foreground">No eligible substitutes from the server.</p>}
          {candidates.map((c) => (
            <button
              key={c.variantId}
              onClick={() => { onPick(c); setOpen(false) }}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors hover:bg-primary-soft"
            >
              <span className="truncate">{c.name}</span>
              <span className="shrink-0 text-[11px] font-bold text-success">{c.available}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/* ── One pick line row ──────────────────────────────────────────────────────── */
function LineRow({ line, expanded, onToggle, onPick, onUnavailable, onSubstitute }: {
  line: PickLine
  expanded: boolean
  onToggle: () => void
  onPick: (qty: number) => void
  onUnavailable: (reason: string) => void
  onSubstitute: (candidate: SubstituteCandidate) => void
}) {
  const [reason, setReason] = useState('')
  const [reasonOpen, setReasonOpen] = useState(false)
  const subName = line.substitutionVariantId
    ? line.substitutionCandidates.find((c) => c.variantId === line.substitutionVariantId)?.name ?? 'Substitute recorded'
    : null

  const resolvedOk = line.resolved && !line.unavailableReason
  const qtyLabel = `${line.qtyPicked} / ${line.qtyOrdered}`

  return (
    <div className={cn('rounded-xl border px-3.5 py-3 transition-colors', line.resolved ? 'border-success/30 bg-success-soft/40' : 'border-border bg-card')}>
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-muted/70 ring-1 ring-border/60">
          <ProductTile icon={line.icon} size={26} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-bold">{line.name}</div>
          <div className="mt-0.5 text-[11.5px] text-muted-foreground">
            Batch: <span className="font-semibold">{line.batchId}</span> · Exp: {fmtDate(line.batchExpiry)}
          </div>
        </div>
        {line.resolved ? (
          <div className="flex items-center gap-2">
            <span className={cn(
              'rounded-full px-2.5 py-1 text-[12px] font-bold tabular',
              line.unavailableReason ? 'bg-destructive-soft text-destructive' : 'bg-success-soft text-success',
            )}>
              {qtyLabel}
            </span>
            {resolvedOk && <CheckCircle2 className="h-5 w-5 text-success" aria-label="Picked" />}
            {(line.unavailableReason || subName) && (
              <button onClick={onToggle} aria-label="Toggle line details" aria-expanded={expanded}
                className="grid h-7 w-7 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted">
                <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
              </button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <Button variant="secondary" size="iconSm" aria-label={`Decrease ${line.name}`} disabled={line.qtyPicked === 0}
              onClick={() => onPick(line.qtyPicked - 1)}>
              <Minus className="h-3.5 w-3.5" />
            </Button>
            <input
              value={line.qtyPicked}
              readOnly
              aria-label={`Picked quantity for ${line.name}`}
              className="h-8 w-10 rounded-lg border border-input bg-card text-center text-[13px] font-bold tabular"
            />
            <Button variant="secondary" size="iconSm" aria-label={`Increase ${line.name}`} disabled={line.qtyPicked >= line.qtyOrdered}
              onClick={() => onPick(Math.min(line.qtyOrdered, line.qtyPicked + 1))}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <button onClick={onToggle} aria-label="Toggle line actions" aria-expanded={expanded}
              className="ml-1 grid h-7 w-7 place-items-center rounded-lg text-muted-foreground transition hover:bg-muted">
              <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} />
            </button>
          </div>
        )}
      </div>

      {/* expanded: substitutes/unavailable info + actions for unresolved lines */}
      {expanded && (
        <div className="mt-3 space-y-2.5 border-t border-border/60 pt-3">
          {line.unavailableReason && (
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-destructive">
              <PackageX className="h-3.5 w-3.5" /> Not available — {line.unavailableReason}
            </p>
          )}
          {subName && (
            <p className="flex items-center gap-1.5 text-[12px] font-semibold text-success">
              <Check className="h-3.5 w-3.5" /> Substituted with {subName}
            </p>
          )}
          {!line.resolved && (
            <div className="flex flex-wrap items-center gap-2">
              {!reasonOpen ? (
                <Button variant="destructive" size="sm" onClick={() => setReasonOpen(true)} aria-label={`Mark ${line.name} not available`}>
                  <PackageX className="h-3.5 w-3.5" /> Not Available
                </Button>
              ) : (
                <>
                  <div className="w-56">
                    <Select
                      value={reason}
                      onValueChange={setReason}
                      placeholder="Reason (required)…"
                      options={Object.keys(UNAVAILABLE_REASONS).map((r) => ({ value: r, label: r }))}
                    />
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => { setReasonOpen(false); setReason('') }}>Cancel</Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={!reason}
                    onClick={() => { onUnavailable(reason); setReasonOpen(false); setReason('') }}
                  >
                    Confirm unavailable
                  </Button>
                </>
              )}
              <SubstitutePicker line={line} onPick={onSubstitute} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ── The Picking Workspace drawer body ──────────────────────────────────────── */
function PickingWorkspace({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const user = useStoreAuth((s) => s.user)
  const taskQ = usePickingTask(taskId)
  const task = taskQ.data ?? null
  const actions = usePickingActions()

  const [releaseOpen, setReleaseOpen] = useState(false)
  const [expandedLine, setExpandedLine] = useState<string | null>(null)
  const [scanOpen, setScanOpen] = useState(false)
  const [scanVal, setScanVal] = useState('')
  const [shakeKey, setShakeKey] = useState(0)
  const scanRef = useRef<HTMLInputElement>(null)

  // packing form (step 2)
  const [bags, setBags] = useState('1')
  const [coldChain, setColdChain] = useState(true)
  const [sealCode, setSealCode] = useState('')

  // handover (step 3)
  const [code, setCode] = useState('')
  const [celebrate, setCelebrate] = useState(false)

  useEffect(() => {
    if (task) {
      setBags(String(task.packing?.bags ?? 1))
      setColdChain(task.packing?.coldChain ?? true)
      setSealCode(task.packing?.sealCode ?? '')
      setExpandedLine(null); setScanOpen(false); setScanVal(''); setCode(''); setCelebrate(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, task?.status])

  useEffect(() => {
    if (task?.handover?.verifiedAt && !celebrate) {
      setCelebrate(true)
      toast.success('Handover verified — order handed to rider')
    }
  }, [task?.handover?.verifiedAt, celebrate])

  useEffect(() => { if (scanOpen) scanRef.current?.focus() }, [scanOpen])

  useEffect(() => {
    if (!task || task.assigneeId !== user?.id || task.status !== 'being_picked') return
    void actions.start(task.id)
    const timer = window.setInterval(() => { void actions.heartbeat(task.id) }, 45_000)
    return () => window.clearInterval(timer)
    // Heartbeat follows the open task, not a fresh actions object each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id, task?.status, task?.assigneeId, user?.id])

  if (!task) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-14 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }

  const lines = task.lines
  const resolvedCount = lines.filter((l) => l.resolved).length
  const unitsPicked = lines.reduce((a, l) => a + l.qtyPicked, 0)
  const allResolved = resolvedCount === lines.length
  const itemCount = lines.reduce((a, l) => a + l.qtyOrdered, 0)
  const step: 1 | 2 | 3 | 4 = task.status === 'completed' ? 4
    : task.status === 'ready_for_handover' ? 3
    : task.status === 'ready_to_pack' ? 2
    : 1
  const isOverdue = (task.status === 'waiting_to_pick' || task.status === 'being_picked') && new Date(task.deadline).getTime() < Date.now()
  const handoverRiderName = task.handover?.riderName ?? null
  const attempts = task.handover?.attempts ?? 0
  const verified = !!task.handover?.verifiedAt
  const locked = !verified && attempts >= 3

  const handleScanSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const q = scanVal.trim()
    if (!q) return
    const line = lines.find((l) => !l.resolved && (l.barcode === q || l.sku.toLowerCase() === q.toLowerCase()))
    if (line && line.barcode) {
      void actions.pickLine(task.id, line.id, line.barcode, line.qtyPicked + 1, line.batchId || undefined)
      setScanVal('')
    } else {
      setShakeKey((k) => k + 1)
      toast.error(line ? 'This line has no barcode to verify' : 'No matching product in this order')
    }
  }

  // ── Footer (progress + actions) per step, pinned to the drawer bottom ──
  const footer = (
    <div className="space-y-3">
      {step === 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-primary-softer px-4 py-3">
          <span className="flex items-center gap-2 text-[13px] font-bold">
            <PackageOpen className="h-4 w-4 text-brand-700 dark:text-brand-300" />
            Picked: <span className="tabular">{resolvedCount} of {lines.length}</span>&nbsp;lines
            <span className="font-medium text-muted-foreground">· {unitsPicked} units</span>
          </span>
          <span className="flex items-center gap-2 text-[12px] font-bold text-muted-foreground">
            Progress: <span className="tabular text-foreground">{lines.length ? Math.round((resolvedCount / lines.length) * 100) : 0}%</span>
            <ProgressMini value={lines.length ? (resolvedCount / lines.length) * 100 : 0} />
          </span>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {step === 1 ? (
          <Button variant="secondary" size="md" onClick={() => setReleaseOpen(true)} aria-label="Release task">
            Release Task
          </Button>
        ) : <span />}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="md" onClick={onClose}>Save &amp; Exit</Button>
          {step === 1 && (
            <Tooltip content={allResolved ? 'All lines resolved' : `${lines.length - resolvedCount} line${lines.length - resolvedCount === 1 ? '' : 's'} still unresolved`}>
              <span className="inline-flex">
                <Button size="md" disabled={!allResolved} onClick={() => actions.completePicking(task.id)}>
                  Continue to Pack →
                </Button>
              </span>
            </Tooltip>
          )}
          {step === 2 && (
            <Button
              size="md"
              disabled={!sealCode.trim() || !(Number(bags) >= 1)}
              onClick={() => actions.savePacking(task.orderId, Math.max(1, Number(bags) || 1), coldChain, sealCode.trim())}
            >
              Mark ready for handover
            </Button>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <>
      {/* customer + timing block */}
      <div className="rounded-xl border border-border/70 bg-muted/40 px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px]">
          <span className="flex items-center gap-1.5 font-semibold"><User className="h-4 w-4 text-muted-foreground" /> {task.customerName ?? '—'}</span>
          <span className="flex items-center gap-1.5 text-muted-foreground"><Package className="h-3.5 w-3.5" /> {itemCount} items</span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12.5px]">
          <span className="text-muted-foreground">Placed: <span className="font-semibold text-foreground">{fmtTime(task.createdAt)}</span></span>
          <span className={cn('flex items-center gap-1.5', isOverdue ? 'font-bold text-destructive' : 'text-muted-foreground')}>
            Deadline: <span className={isOverdue ? '' : 'font-semibold text-foreground'}>{fmtTime(task.deadline)}</span>
            {isOverdue && '(Overdue)'}
          </span>
          <DeadlineChip deadline={task.deadline} />
        </div>
      </div>

      {/* stepper */}
      <div className="mt-4 rounded-xl border border-border/70 px-4 py-3">
        <Stepper step={step} />
      </div>

      {/* waiting-to-pick claim banner */}
      {task.status === 'waiting_to_pick' && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3">
          <p className="text-[13px] font-semibold text-amber-700 dark:text-amber-300">This task is unclaimed — claim it to start picking.</p>
          <Button size="sm" onClick={() => { void actions.claim(task.id).then((claimed) => { if (claimed) void actions.start(task.id) }) }}>Claim Task</Button>
        </div>
      )}

      {task.status === 'completed' || celebrate ? (
        <motion.div
          initial={{ scale: 0.85, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: 'spring', stiffness: 240, damping: 16 }}
          className="mt-4 flex flex-col items-center gap-3 rounded-xl border border-success/30 bg-success-soft px-4 py-8 text-center"
        >
          <motion.span
            initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.1, type: 'spring', stiffness: 300, damping: 14 }}
            className="grid h-14 w-14 place-items-center rounded-full bg-success text-white shadow-pill"
          >
            <Check className="h-7 w-7" strokeWidth={3} />
          </motion.span>
          <p className="text-sm font-bold">Task completed — order handed over</p>
          <p className="text-xs text-muted-foreground">{task.orderNumber ?? task.orderId} · {task.customerName ?? ''} · {itemCount} items</p>
        </motion.div>
      ) : step === 1 ? (
        /* ── STEP 1: Pick Items ── */
        <div className="mt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-[15px] font-bold">Pick Items (<span className="tabular">{resolvedCount} / {lines.length}</span>)</h3>
            {!scanOpen ? (
              <Button variant="outline" size="sm" onClick={() => setScanOpen(true)} aria-label="Open scanner">
                <ScanLine className="h-4 w-4" /> Scan Product
              </Button>
            ) : (
              <motion.form
                key={shakeKey}
                onSubmit={handleScanSubmit}
                initial={{ x: 0 }}
                animate={shakeKey ? { x: [0, -9, 9, -6, 6, 0] } : { x: 0 }}
                transition={{ duration: 0.35 }}
                className="flex items-center gap-2"
              >
                <input
                  ref={scanRef}
                  value={scanVal}
                  onChange={(e) => setScanVal(e.target.value)}
                  placeholder="Scan SKU or barcode…"
                  aria-label="Scan product SKU or barcode"
                  className="h-9 w-48 rounded-xl border border-input bg-card px-3 text-[13px] shadow-innersoft focus:outline-none focus:ring-2 focus:ring-ring/60"
                />
                <Button type="submit" size="sm">Enter</Button>
                <Button type="button" variant="ghost" size="iconSm" aria-label="Close scanner" onClick={() => { setScanOpen(false); setScanVal('') }}>
                  ✕
                </Button>
              </motion.form>
            )}
          </div>
          <div className="mt-3 space-y-2.5">
            {lines.map((line) => (
              <LineRow
                key={line.id}
                line={line}
                expanded={expandedLine === line.id}
                onToggle={() => setExpandedLine(expandedLine === line.id ? null : line.id)}
                onPick={(qty) => {
                  if (qty < 1) return
                  if (!line.barcode) { toast.error('This line has no barcode to verify'); return }
                  void actions.pickLine(task.id, line.id, line.barcode, qty, line.batchId || undefined)
                }}
                onUnavailable={(r) => actions.markUnavailable(task.id, line.id, UNAVAILABLE_REASONS[r] ?? 'NOT_FOUND')}
                onSubstitute={(candidate) => actions.substitute(task.id, line.id, candidate.variantId, candidate.barcode || candidate.sku)}
              />
            ))}
          </div>
        </div>
      ) : step === 2 ? (
        /* ── STEP 2: Pack Order ── */
        <div className="mt-4 space-y-4">
          <div className="flex items-center gap-2 rounded-xl bg-info-soft px-4 py-3 text-[13px] font-semibold text-info">
            <PackageCheck className="h-4 w-4 shrink-0" />
            All {lines.length} lines resolved — pack the order. The rider presents their code at handover.
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label required>Bags / boxes</Label>
              <Input type="number" min={1} value={bags} onChange={(e) => setBags(e.target.value)} aria-label="Number of bags or boxes" />
            </div>
            <div>
              <Label>Cold-chain pack</Label>
              <div className="flex h-10 items-center gap-3">
                <Switch checked={coldChain} onCheckedChange={setColdChain} aria-label="Cold-chain pack" />
                <span className="text-[13px] text-muted-foreground">Insulated bag + ice pack</span>
              </div>
            </div>
            <div className="sm:col-span-2">
              <Label required>Seal code</Label>
              <Input value={sealCode} onChange={(e) => setSealCode(e.target.value.slice(0, 64))} aria-label="Seal code" placeholder="Bag seal" />
            </div>
          </div>
        </div>
      ) : (
        /* ── STEP 3: Handover ── */
        <div className="mt-4 space-y-4">
          {handoverRiderName && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-border/70 bg-muted/40 px-4 py-3 text-[13px]">
              <span className="flex items-center gap-1.5 font-semibold"><User className="h-4 w-4 text-muted-foreground" /> {handoverRiderName}</span>
              {task.handover?.deliveryStatus && <Badge tone="blue">{task.handover.deliveryStatus}</Badge>}
            </div>
          )}
          {locked ? (
            <div className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive-soft px-4 py-4 text-[13px] font-bold text-destructive">
              <XCircle className="h-5 w-5 shrink-0" /> Code locked — contact admin
            </div>
          ) : verified || !task.handover ? (
            <div className="rounded-xl border border-success/30 bg-success-soft px-4 py-3 text-[13px] font-semibold text-success">
              Handover verified at {task.handover?.verifiedAt ? fmtTime(task.handover.verifiedAt) : '—'}
            </div>
          ) : (
            <div className="rounded-xl border border-border/70 px-4 py-4">
              <Label required>Enter the rider&apos;s handover code</Label>
              <div className="flex items-center gap-2">
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value.slice(0, 20))}
                  placeholder="Code"
                  aria-label="Handover code"
                  className="max-w-[180px] text-center text-lg font-bold tracking-[0.3em]"
                />
                <Button
                  size="md"
                  disabled={!code.trim()}
                  onClick={() => actions.verifyHandover(task.orderId, code.trim())}
                >
                  Verify
                </Button>
              </div>
              <p className="mt-1.5 text-[11px] font-medium text-muted-foreground">
                {attempts} failed attempt{attempts === 1 ? '' : 's'} recorded. Ask the rider for the code issued by the server.
              </p>
            </div>
          )}
        </div>
      )}

      {/* footer: progress + actions pinned to the drawer bottom */}
      <div className="sticky bottom-0 -mx-5 mt-5 border-t border-border/70 bg-card px-5 py-3.5">
        {footer}
      </div>

      {/* release confirm */}
      <ConfirmDialog
        open={releaseOpen}
        onOpenChange={setReleaseOpen}
        title="Release this task?"
        description={`${task.id} goes back to the picking queue unassigned. Any picked lines are kept.`}
        confirmLabel="Release Task"
        destructive
        onConfirm={() => { actions.release(task.id); onClose() }}
      />
    </>
  )
}

/* tiny inline progress bar (keeps the drawer footer compact) */
function ProgressMini({ value }: { value: number }) {
  return (
    <span className="relative inline-block h-2 w-24 overflow-hidden rounded-full bg-muted align-middle">
      <span className="absolute inset-y-0 left-0 rounded-full gradient-primary transition-all duration-500" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </span>
  )
}

/* ── Page ────────────────────────────────────────────────────────────────────── */
export function StoreOrdersPicking() {
  const container = useStagger()
  const storeId = useActiveStoreId()
  const user = useStoreAuth((s) => s.user)
  const actions = usePickingActions()
  const [searchParams, setSearchParams] = useSearchParams()

  const dashQ = useStoreDashboard(storeId)
  const d = dashQ.data

  const [tab, setTab] = useState<'queue' | 'all' | 'mine'>('queue')
  const [statusFilter, setStatusFilter] = useState('all')
  const [search, setSearch] = useState('')
  const debSearch = useDebouncedValue(search, 250)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string[]>([])
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)

  // deep link ?focus=<taskId> opens the workspace; ?focus=queue selects the queue tab
  useEffect(() => {
    const focus = searchParams.get('focus')
    if (!focus) return
    if (focus === 'queue') setTab('queue')
    else {
      setTab('all')
      setOpenTaskId(focus)
    }
    const sp = new URLSearchParams(searchParams)
    sp.delete('focus')
    setSearchParams(sp, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tasksQ = usePickingTasks(storeId, tab, { status: statusFilter, search: debSearch })
  const mineQ = usePickingTasks(storeId, 'mine', { status: 'all', search: '' })
  const rows = tasksQ.data ?? []

  useEffect(() => { setPage(1) }, [tab, statusFilter, debSearch])

  const PAGE_SIZE = 8
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const totalTasks = d ? d.byStatus.waiting + d.byStatus.beingPicked + d.byStatus.readyToPack + d.byStatus.readyHandover : 0

  const assigneeLabel = (task: PickingTask) => {
    if (!task.assigneeId) return '—'
    if (task.assigneeId === user?.id) return 'You'
    return task.assigneeName ?? '—'
  }

  const columns: Column<TaskRow>[] = [
    { key: 'orderId', header: 'Order ID', render: (r) => <span className="font-bold">#{r.task.orderId}</span> },
    { key: 'customer', header: 'Customer', render: (r) => r.order.customerName },
    { key: 'items', header: 'Items', render: (r) => <span className="tabular">{r.order.itemCount} items</span> },
    { key: 'placedAt', header: 'Placed At', render: (r) => <span className="tabular text-muted-foreground">{fmtTime(r.task.createdAt)}</span> },
    {
      key: 'deadline', header: 'Deadline',
      render: (r) => {
        const overdue = (r.task.status === 'waiting_to_pick' || r.task.status === 'being_picked') && new Date(r.task.deadline).getTime() < Date.now()
        return (
          <div className="flex flex-col items-start gap-1">
            <span className={cn('font-semibold tabular', overdue && 'text-destructive')}>
              {fmtTime(r.task.deadline)}{overdue && ' (Overdue)'}
            </span>
            <DeadlineChip deadline={r.task.deadline} />
          </div>
        )
      },
    },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.task.status} /> },
    { key: 'assignee', header: 'Assignee', render: (r) => <span className={cn(r.task.assigneeId === user?.id && 'font-bold text-brand-700 dark:text-brand-300')}>{assigneeLabel(r.task)}</span> },
    {
      key: 'actions', header: 'Actions', align: 'right',
      render: (r) => {
        const t = r.task
        const mine = t.assigneeId === user?.id
        const open = () => setOpenTaskId(t.id)
        if (t.status === 'waiting_to_pick') {
          return (
            <div className="flex items-center justify-end gap-1.5">
              <Button size="sm" onClick={(e) => { e.stopPropagation(); void actions.claim(t.id).then((claimed) => { if (claimed) void actions.start(t.id) }) }}>Claim</Button>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          )
        }
        if (t.status === 'being_picked') {
          return (
            <div className="flex items-center justify-end gap-1.5">
              {mine ? <Button size="sm" onClick={(e) => { e.stopPropagation(); open() }}>Continue</Button>
                : <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); open() }}>View</Button>}
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          )
        }
        if (t.status === 'ready_to_pack') {
          return (
            <div className="flex items-center justify-end gap-1.5">
              <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); open() }}>Pack</Button>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          )
        }
        if (t.status === 'ready_for_handover') {
          return (
            <div className="flex items-center justify-end gap-1.5">
              <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); open() }}>Handover</Button>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          )
        }
        return (
          <div className="flex items-center justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); open() }}>View</Button>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </div>
        )
      },
    },
  ]

  const openTask = openTaskId ? rows.find((r) => r.task.id === openTaskId) : undefined

  const loadFailure = firstFailedQuery([tasksQ, mineQ, dashQ])
  if (loadFailure) return <PageLoadError title="Orders & Picking" artwork="ordersPicking" query={loadFailure} />

  return (
    <TooltipProvider>
      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-5">
        <PageHeader
          title="Orders &"
          titleAccent="Picking"
          subtitle="Manage store orders, pick items, pack and hand over to riders."
          artwork="ordersPicking"
          breadcrumb={['Orders & Picking']}
        />

        {/* KPI row */}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard label="Waiting to Pick" value={d?.byStatus.waiting ?? 0} icon={ShoppingCart} tint="green" highlight />
          <KpiCard label="Being Picked" value={d?.byStatus.beingPicked ?? 0} icon={Boxes} tint="blue" />
          <KpiCard label="Ready to Pack" value={d?.byStatus.readyToPack ?? 0} icon={PackageOpen} tint="amber" />
          <KpiCard label="Ready for Handover" value={d?.byStatus.readyHandover ?? 0} icon={Bike} tint="violet" />
        </div>

        {/* tabs + toolbar + table */}
        <motion.div variants={container.item}>
          <Card>
            <div className="border-b border-border/70 px-5 pb-1 pt-3">
              <TabPills
                id="picking-tabs"
                value={tab}
                onChange={(v) => setTab(v as 'queue' | 'all' | 'mine')}
                tabs={[
                  { value: 'queue', label: 'Picking Queue', count: d?.byStatus.waiting ?? 0 },
                  { value: 'all', label: 'All Orders', count: totalTasks },
                  { value: 'mine', label: 'My Tasks', count: mineQ.data?.length ?? 0 },
                ]}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3 px-5 py-3.5">
              <div className="w-40">
                <Select
                  value={statusFilter}
                  onValueChange={setStatusFilter}
                  options={[
                    { value: 'all', label: 'All Status' },
                    { value: 'waiting_to_pick', label: 'Waiting to Pick' },
                    { value: 'being_picked', label: 'Being Picked' },
                    { value: 'ready_to_pack', label: 'Ready to Pack' },
                    { value: 'ready_for_handover', label: 'Ready for Handover' },
                    { value: 'completed', label: 'Completed' },
                  ]}
                />
              </div>
              <div className="relative w-44">
                <CalendarDays className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Select
                  value="today"
                  onValueChange={() => { /* cosmetic — only today's tasks are listed */ }}
                  options={[{ value: 'today', label: 'All Time (Today)' }]}
                  className="pl-9"
                />
              </div>
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Search by Order ID or Customer…"
                className="min-w-[220px] flex-1"
              />
            </div>
            <DataTable<TaskRow>
              columns={columns}
              rows={pageRows}
              keyId={(r) => r.task.id}
              loading={tasksQ.isLoading}
              selectable
              selected={selected}
              onSelectedChange={setSelected}
              onRowClick={(r) => setOpenTaskId(r.task.id)}
              skeletonRows={8}
              empty={(
                <EmptyState
                  icon={ClipboardList}
                  title="No tasks in this view"
                  body="Try another tab, status or search — or wait for the next order to land."
                />
              )}
            />
            <Pagination
              page={page}
              totalPages={totalPages}
              onChange={setPage}
              showing={rows.length ? `Showing ${(page - 1) * PAGE_SIZE + 1} – ${Math.min(page * PAGE_SIZE, rows.length)} of ${rows.length} orders` : undefined}
            />
          </Card>
        </motion.div>
      </motion.div>

      {/* ── Picking Workspace drawer ── */}
      <Drawer
        open={!!openTaskId}
        onOpenChange={(v) => { if (!v) setOpenTaskId(null) }}
        width="lg"
        title={(
          <span className="flex items-center gap-2">
            <PackageOpen className="h-5 w-5 text-brand-600" />
            Picking Workspace
            {openTask && <Badge tone="green">{openTask.task.id}</Badge>}
          </span>
        )}
        subtitle={openTask ? `Order #${openTask.task.orderId} · ${openTask.order.customerName}` : 'Loading task…'}
      >
        {openTaskId && <PickingWorkspace taskId={openTaskId} onClose={() => setOpenTaskId(null)} />}
      </Drawer>
    </TooltipProvider>
  )
}
