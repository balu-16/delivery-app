import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  CalendarClock, RefreshCcw, Save, ChevronLeft, ChevronRight, Info, Plus, Trash2, CheckCircle2, AlertTriangle,
} from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import { useSubscriptionPlans, useSubscriptionSlots, useSubscriptionHolidays, useSubscriptionRuns, useStoreOptions, useVariants } from '@/hooks/queries'
import { useSubscriptionAdminActions } from '@/hooks/mutations'
import { useFeature } from '@/hooks/flags'
import { PageHeader, StatusPill, EmptyState } from '@/components/shared/misc'
import { Select, Field } from '@/components/ui/form'
import { Button, Card, Badge, Input, Switch, Label } from '@/components/ui/base'
import { Dialog, DialogContent, Tooltip } from '@/components/ui/overlays'
import { DataTable } from '@/components/shared/DataTable'
import { KpiCard } from '@/components/shared/KpiCard'
import type { DeliverySlot, SubscriptionRun } from '@/types'
import { fmtDate } from '@/lib/utils'

function CursorBar({ onPrev, onNext, hasPrev, hasNext, loading, label }: {
  onPrev: () => void; onNext: () => void; hasPrev: boolean; hasNext: boolean; loading: boolean; label: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={!hasPrev || loading} onClick={onPrev}><ChevronLeft className="h-3.5 w-3.5" /> Prev</Button>
        <Button size="sm" variant="outline" disabled={!hasNext || loading} onClick={onNext}>Next <ChevronRight className="h-3.5 w-3.5" /></Button>
      </div>
    </div>
  )
}

/* ── Slot dialog ───────────────────────────────────────────── */
function SlotDialog({ open, onOpenChange, slot, storeId, onSave, serverError }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  slot: DeliverySlot | null
  storeId: string
  onSave: (input: { id?: string; storeId: string; name: string; startTime: string; endTime: string; active: boolean }) => void
  serverError: string | null
}) {
  const [name, setName] = useState('')
  const [start, setStart] = useState('06:00')
  const [end, setEnd] = useState('09:00')
  const [active, setActive] = useState(true)
  useEffect(() => {
    if (open) {
      setName(slot?.name ?? '')
      setStart(slot?.startTime ?? '06:00')
      setEnd(slot?.endTime ?? '09:00')
      setActive(slot?.active ?? true)
    }
  }, [open, slot])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={slot ? `Edit slot ${slot.name}` : 'Add delivery slot'} description="Slots are per store — timing rules are validated by the server">
        <div className="space-y-3">
          <Field label="Name" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Morning 6–9" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start (HH:MM)" required><Input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
            <Field label="End (HH:MM)" required><Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div><Label className="mb-0">Active</Label><p className="text-xs text-muted-foreground">Customers can pick this slot</p></div>
            <Switch checked={active} onCheckedChange={setActive} />
          </div>
          {serverError && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{serverError}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" disabled={!name.trim()} onClick={() => { onSave({ id: slot?.id, storeId, name: name.trim(), startTime: start, endTime: end, active }); onOpenChange(false) }}>
              <Save className="h-4 w-4" /> Save slot
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function Subscriptions() {
  const container = useStagger()
  const actions = useSubscriptionAdminActions()
  const enabled = useFeature('subscriptions')
  const [serverError, setServerError] = useState<string | null>(null)

  const storesQ = useStoreOptions()
  const stores = storesQ.data ?? []
  const variantsQ = useVariants(200)
  const variants = variantsQ.data ?? []

  const [storeId, setStoreId] = useState('')
  useEffect(() => { if (!storeId && stores.length > 0) setStoreId(stores[0]!.id) }, [stores, storeId])

  const plansQ = useSubscriptionPlans()
  const slotsQ = useSubscriptionSlots(storeId || null)
  const holidaysQ = useSubscriptionHolidays(storeId || null)
  const runsQ = useSubscriptionRuns(storeId || undefined)

  const plans = plansQ.data ?? []
  const slots = slotsQ.data?.items ?? []
  const holidays = holidaysQ.data?.items ?? []
  const runs: SubscriptionRun[] = runsQ.data?.items ?? []

  const planByVariant = new Map(plans.map((p: { variantId: string; active: boolean }) => [p.variantId, p]))
  const planCount = plans.filter((p) => p.active).length
  const failedRuns = runs.filter((r) => r.status === 'failed').length
  const partialRuns = runs.filter((r) => r.status === 'partial').length

  interface PlanRow { variant: { id: string; name: string; sku: string }; plan: { active: boolean } | null }
  const planRows: PlanRow[] = variants.map((v) => ({ variant: { id: v.id, name: v.name, sku: v.sku }, plan: planByVariant.get(v.id) ?? null }))

  const [slotDialog, setSlotDialog] = useState<{ open: boolean; slot: DeliverySlot | null }>({ open: false, slot: null })
  const [holidayDate, setHolidayDate] = useState('')

  if (!enabled) {
    return (
      <div className="space-y-5">
        <PageHeader
          title="Subscriptions"
          titleAccent="& runs"
          subtitle="Recurring delivery plans, slots, holidays and generation runs."
          artwork="subscriptions"
          breadcrumb={['Subscriptions']}
        />
        <Card className="flex items-start gap-3 border-amber-200 bg-warning-soft p-6 dark:border-amber-500/30">
          <Info className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-warning" />
          <div>
            <p className="text-[15px] font-bold text-amber-800 dark:text-amber-200">Subscriptions are switched off</p>
            <p className="mt-1 text-[13px] text-amber-800/80 dark:text-amber-200/80">Enable the subscriptions flag in Settings › feature flags to use this section.</p>
          </div>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Subscriptions"
        titleAccent="& runs"
        subtitle="Recurring delivery plans, slots, holidays and generation runs."
        artwork="subscriptions"
        breadcrumb={['Subscriptions']}
        actions={(
          <div className="w-48">
            <Select value={storeId} onValueChange={setStoreId} options={stores.map((s) => ({ value: s.id, label: s.name }))} placeholder="Pick store" />
          </div>
        )}
      />

      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-5">
        <motion.section variants={container.item} className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <KpiCard label="Active plans" value={planCount} icon={CheckCircle2} tint="green" format="num" />
          <KpiCard label="Slots at store" value={slots.length} icon={CalendarClock} tint="blue" format="num" />
          <KpiCard label="Failed runs (page)" value={failedRuns} icon={AlertTriangle} tint="red" format="num" highlight={failedRuns > 0} />
          <KpiCard label="Partial runs (page)" value={partialRuns} icon={RefreshCcw} tint="amber" format="num" />
        </motion.section>

        {/* ── PLANS ── */}
        <motion.section variants={container.item}>
          <Card className="overflow-hidden">
            <div className="px-5 pt-5 pb-3">
              <h3 className="text-[15px] font-bold tracking-tight">Subscribable variants</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Toggle which catalog variants customers can subscribe to</p>
            </div>
            <DataTable
              keyId={(r: PlanRow) => r.variant.id}
              rows={planRows}
              loading={plansQ.isLoading}
              empty={<EmptyState icon={CheckCircle2} title="No catalog variants" body="Create catalog variants first." />}
              columns={[
                {
                  key: 'variant', header: 'Variant',
                  render: (r: PlanRow) => (
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{r.variant.name}</p>
                      <p className="truncate font-mono text-[11px] text-muted-foreground">{r.variant.sku}</p>
                    </div>
                  ),
                },
                { key: 'state', header: 'Plan state', render: (r: PlanRow) => r.plan ? <StatusPill status={r.plan.active ? 'active' : 'inactive'} dot /> : <Badge tone="neutral">not configured</Badge> },
                {
                  key: 'actions', header: '', align: 'right' as const,
                  render: (r: PlanRow) => (
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        variant={r.plan?.active ? 'outline' : 'primary'}
                        onClick={() => actions.savePlan(r.variant.id, !(r.plan?.active ?? false)).mutate(undefined, { onError: (e) => setServerError(e.message) })}
                      >
                        {r.plan?.active ? 'Disable plan' : 'Enable plan'}
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          </Card>
        </motion.section>

        {/* ── SLOTS + HOLIDAYS ── */}
        <motion.section variants={container.item} className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-5 pb-3">
              <div>
                <h3 className="text-[15px] font-bold tracking-tight">Delivery slots</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">Per store — timing validated server-side</p>
              </div>
              <Button size="sm" variant="primary" disabled={!storeId} onClick={() => setSlotDialog({ open: true, slot: null })}>
                <Plus className="h-3.5 w-3.5" /> Add slot
              </Button>
            </div>
            <div className="space-y-1.5 px-5 pb-5">
              {slots.length === 0 && <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No slots for this store yet</p>}
              {slots.map((s) => (
                <div key={s.id} className="flex items-center gap-3 rounded-xl border border-border/70 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold">{s.name}</p>
                    <p className="text-[11px] text-muted-foreground">{s.startTime} – {s.endTime}</p>
                  </div>
                  <StatusPill status={s.active ? 'active' : 'inactive'} />
                  <Button size="sm" variant="ghost" onClick={() => setSlotDialog({ open: true, slot: s })}>Edit</Button>
                </div>
              ))}
            </div>
          </Card>
          <Card className="overflow-hidden">
            <div className="px-5 pt-5 pb-3">
              <h3 className="text-[15px] font-bold tracking-tight">Holidays</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">No-generation days for the selected store</p>
            </div>
            <div className="space-y-1.5 px-5 pb-5">
              {holidays.length === 0 && <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No holidays configured</p>}
              {holidays.map((h) => (
                <div key={h.date} className="flex items-center gap-3 rounded-xl border border-border/70 px-3 py-2.5">
                  <Badge tone="violet">{fmtDate(h.date)}</Badge>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{h.reason ?? 'Closed for subscriptions'}</span>
                  <Button size="iconSm" variant="ghost" aria-label="Remove holiday" onClick={() => { if (storeId) actions.deleteHoliday(storeId, h.date).mutate(undefined, { onError: (e) => setServerError(e.message) }) }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
              <div className="mt-2 flex items-end gap-2">
                <div className="w-40"><Input type="date" value={holidayDate} onChange={(e) => setHolidayDate(e.target.value)} /></div>
                <Button size="sm" variant="outline" disabled={!holidayDate || !storeId} onClick={() => { actions.saveHoliday(storeId, holidayDate, 'Admin-added closed day').mutate(undefined, { onError: (e) => setServerError(e.message) }); setHolidayDate('') }}>
                  <Plus className="h-3.5 w-3.5" /> Add
                </Button>
              </div>
            </div>
          </Card>
        </motion.section>

        {/* ── RUNS ── */}
        <motion.section variants={container.item}>
          <Card className="overflow-hidden">
            <div className="px-5 pt-5 pb-3">
              <h3 className="text-[15px] font-bold tracking-tight">Generation runs</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Retries only re-run failed generations — status and errors come from the server</p>
            </div>
            <DataTable
              keyId={(r) => r.id}
              rows={runs}
              loading={runsQ.isLoading}
              empty={<EmptyState icon={CalendarClock} title="No runs recorded" body="Generation runs appear here once subscriptions generate." />}
              columns={[
                { key: 'id', header: 'Run', render: (r: SubscriptionRun) => <span className="font-mono text-[13px] font-bold">{r.id.slice(0, 8)}…</span> },
                { key: 'date', header: 'Run date', render: (r: SubscriptionRun) => <span className="text-[13px]">{r.runDate ? fmtDate(r.runDate) : '—'}</span> },
                { key: 'status', header: 'Status', render: (r: SubscriptionRun) => <StatusPill status={r.status} dot /> },
                { key: 'generated', header: 'Generated', render: (r: SubscriptionRun) => <span className="tabular">{r.generatedCount ?? '—'}</span> },
                { key: 'failed', header: 'Failed', render: (r: SubscriptionRun) => r.failedCount ? <Badge tone="red">{r.failedCount}</Badge> : <span className="text-muted-foreground">0</span> },
                { key: 'error', header: 'Last error', render: (r: SubscriptionRun) => <span className="block max-w-[220px] truncate text-[12.5px] text-muted-foreground">{r.lastError ?? '—'}</span> },
                {
                  key: 'actions', header: '', align: 'right' as const,
                  render: (r: SubscriptionRun) => (
                    <div className="flex justify-end">
                      <Tooltip content={r.failedCount ? 'Retry the failed generations of this run (idempotent)' : 'Nothing to retry'}>
                        <span>
                          <Button size="sm" variant="outline" disabled={!r.failedCount} onClick={() => actions.retryRun(r.id).mutate(undefined, { onError: (e) => setServerError(e.message) })}>
                            <RefreshCcw className="h-3.5 w-3.5" /> Retry
                          </Button>
                        </span>
                      </Tooltip>
                    </div>
                  ),
                },
              ]}
            />
            <CursorBar
              onPrev={() => {}}
              onNext={() => {}}
              hasPrev={false}
              hasNext={!!runsQ.data?.nextCursor}
              loading={runsQ.isLoading}
              label={runsQ.data?.nextCursor ? 'More runs available on the cursor feed' : 'End of runs feed'}
            />
          </Card>
        </motion.section>
      </motion.div>

      <SlotDialog
        open={slotDialog.open}
        onOpenChange={(v) => setSlotDialog((s) => ({ ...s, open: v }))}
        slot={slotDialog.slot}
        storeId={storeId}
        serverError={serverError}
        onSave={(input) => actions.saveSlot(input).mutate(undefined, {
          onError: (e) => setServerError(e.message),
          onSuccess: () => setServerError(null),
        })}
      />
    </div>
  )
}

export default Subscriptions

