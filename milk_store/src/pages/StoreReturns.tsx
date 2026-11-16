import { firstFailedQuery, InlineLoadError, PageLoadError } from '@/components/PageLoadError'
// §4 Returns & Quality Checks — failed-delivery orders awaiting return, recorded
// parcels grouped per order, and the inspection drawer with persistent drafts and
// per-return-row QC. Every quantity, batch expiry and outcome comes from the backend.
import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
  BadgeCheck, Check, CheckCircle2, ChevronRight, Eye, Info, PackageX, Search,
  Undo2,
} from 'lucide-react'
import { useDebouncedValue, useStagger } from '@dairydirect/shared/hooks/misc'
import {
  useActiveStoreId, useEligibleReturns, useRecordedReturns, useReturnOrderDetail,
  useReturnDraft, useStoreDashboard,
} from '@/api/storeQueries'
import { useReturnActions } from '@/api/storeMutations'
import { mapReturnReason } from '@/api/mapping'
import type { BackendEligibleReturnOrder } from '@/api/mapping'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Textarea } from '@dairydirect/shared/ui/base'
import { Dialog, DialogContent, Drawer, Tooltip } from '@dairydirect/shared/ui/overlays'
import { Field, Select } from '@dairydirect/shared/ui/form'
import { EmptyState, PageHeader, SearchInput, StatusPill, TabPills } from '@dairydirect/shared/ui/misc'
import { DataTable, Pagination, type Column } from '@dairydirect/shared/ui/DataTable'
import { KpiCard } from '@dairydirect/shared/ui/KpiCard'
import { ProductTile } from '@dairydirect/shared/assets/productIcons'
import { cn, fmtDate, fmtDateTime, fmtINR } from '@dairydirect/shared/lib/utils'
import type { QualityDecision, ReturnParcel, ReturnReason } from '@dairydirect/shared/types'

const PAGE_SIZE = 6

const REASON_LABEL: Record<ReturnReason, string> = {
  customer_unavailable: 'Customer unavailable',
  wrong_address: 'Wrong address',
  delivery_refused: 'Delivery refused',
  rider_could_not_deliver: 'Rider could not deliver',
  other: 'Other',
}
const REASON_TONE: Record<ReturnReason, 'blue' | 'amber' | 'red' | 'violet' | 'neutral'> = {
  customer_unavailable: 'blue',
  wrong_address: 'amber',
  delivery_refused: 'red',
  rider_could_not_deliver: 'violet',
  other: 'neutral',
}
const REASON_OPTIONS = [
  { value: 'all', label: 'All Reasons' },
  ...(Object.keys(REASON_LABEL) as ReturnReason[]).map((r) => ({ value: r, label: REASON_LABEL[r] })),
]
const RETURN_STATUS_KEY: Record<ReturnParcel['status'], string> = {
  pending: 'pending',
  under_inspection: 'processing',
  processed: 'processed',
}
const DECISIONS: Array<{ d: QualityDecision; label: string; on: string }> = [
  { d: 'saleable', label: 'Saleable', on: 'border-success/40 bg-success-soft text-success' },
  { d: 'damaged', label: 'Damaged', on: 'border-destructive/40 bg-destructive-soft text-destructive' },
  { d: 'expired', label: 'Expired', on: 'border-violet-300/60 bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300' },
]

function Tip({ tip, children }: { tip?: string; children: React.ReactNode }) {
  if (!tip) return <>{children}</>
  return (
    <Tooltip content={tip}>
      <span className="inline-flex cursor-not-allowed">{children}</span>
    </Tooltip>
  )
}

function DecisionGroup({ value, disabled, expired, onDecide }: {
  value?: QualityDecision
  disabled: boolean
  expired: boolean
  onDecide: (d: QualityDecision) => void
}) {
  return (
    <div role="radiogroup" className="flex flex-wrap items-center gap-1.5">
      {DECISIONS.map(({ d, label, on }) => {
        const blocked = disabled || (d === 'saleable' && expired)
        const selected = value === d
        const btn = (
          <button
            key={d}
            role="radio"
            aria-checked={selected}
            disabled={blocked}
            onClick={() => onDecide(d)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors',
              selected ? on : 'border-border bg-card text-muted-foreground hover:border-brand-300',
              blocked && 'cursor-not-allowed opacity-40',
            )}
          >
            {selected && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
            {label}
          </button>
        )
        return d === 'saleable' && expired ? <Tip key={d} tip="Batch expired — approval will be rejected">{btn}</Tip> : btn
      })}
    </div>
  )
}

/* ── Record Return dialog: choose an eligible failed-delivery order ── */
function RecordReturnDialog({ open, onOpenChange, orders, storeId }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  orders: BackendEligibleReturnOrder[]
  storeId: string | null
}) {
  const returns = useReturnActions()
  const [orderId, setOrderId] = useState('')
  const [reason, setReason] = useState('')
  const detailQ = useReturnOrderDetail(storeId, orderId || null)
  const detail = detailQ.data ?? null

  useEffect(() => {
    if (open) { setOrderId(''); setReason('') }
  }, [open])

  useEffect(() => {
    if (!detail) return
    setReason(REASON_LABEL[mapReturnReason(detail.failureReason)])
  }, [detail?.orderId])

  const items = detail?.items ?? []
  const valid = !!orderId && !detailQ.isError && !detailQ.isLoading && reason.trim().length > 0 && items.length > 0

  const submit = async () => {
    if (!valid) return
    // Close only on success so a failed submission keeps the entered data.
    const done = await returns.record(
      orderId,
      reason.trim(),
      items.map((item) => ({ variantId: item.variantId, quantity: item.quantity, expiresAt: item.expiresAt })),
    )
    if (done !== null) onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Record Return"
        description="Log a parcel returned from a failed delivery — it will land in the inspection queue."
        wide
      >
        <div className="space-y-4">
          <Field label="Failed delivery order" required>
            <Select
              value={orderId}
              onValueChange={setOrderId}
              placeholder="Pick the failed-delivery order…"
              options={orders.map((o) => ({
                value: o.orderId,
                label: `${o.orderNumber} · ${o.customerName} · ${o.failedAt ? fmtDate(o.failedAt) : '—'}`,
              }))}
            />
          </Field>

          <Field label="Return reason" required error={!reason.trim() && orderId ? 'Return reason is required' : undefined}>
            <Textarea
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value.slice(0, 300))}
              placeholder="Why did the parcel come back?"
              aria-label="Return reason"
            />
          </Field>

          <div className="rounded-xl border border-border/70">
            <div className="border-b border-border/70 bg-muted/40 px-4 py-2.5 text-[13px] font-bold">
              Returned items {items.length > 0 && <span className="font-medium text-muted-foreground">— exact fulfilled quantities are recorded</span>}
            </div>
            {detailQ.isError ? (
              <InlineLoadError query={detailQ} label="order items" />
            ) : detailQ.isLoading ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">Loading order items…</p>
            ) : items.length === 0 ? (
              <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                {orderId ? 'No fulfilled items were found for this order.' : 'Select an order to see its fulfilled items.'}
              </p>
            ) : (
              <div className="divide-y divide-border/60">
                {items.map((it) => (
                  <div key={it.variantId} className="flex items-center gap-3 px-4 py-2.5">
                    <ProductTile icon="milk" size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold">{it.variantName}</div>
                      <div className="text-[11px] text-muted-foreground">
                        Expiry {it.expiresAt ? fmtDate(it.expiresAt) : 'not tracked'}
                      </div>
                    </div>
                    <span className="text-[13px] font-bold tabular">Qty {it.quantity}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Tip tip={!orderId ? 'Pick an order first' : !reason.trim() ? 'Each return needs a reason' : undefined}>
              <Button disabled={!valid} onClick={() => void submit()}><Undo2 className="h-4 w-4" /> Record Return</Button>
            </Tip>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ── Inspection drawer: draft decisions + per-row QC ─────────── */
function InspectionDrawer({ storeId, orderId, onClose }: {
  storeId: string | null
  orderId: string
  onClose: () => void
}) {
  const returns = useReturnActions()
  const detailQ = useReturnOrderDetail(storeId, orderId)
  const draftQ = useReturnDraft(storeId, orderId)
  const [decisions, setDecisions] = useState<Record<string, QualityDecision>>({})
  const [note, setNote] = useState('')

  useEffect(() => {
    setDecisions({})
    setNote('')
  }, [orderId])

  useEffect(() => {
    if (!detailQ.data) return
    setDecisions((prev) => {
      const next = { ...prev }
      for (const row of detailQ.data.returns) {
        if (next[row.returnId]) continue
        if (row.status === 'APPROVED') next[row.returnId] = 'saleable'
        else if (row.status === 'REJECTED') next[row.returnId] = 'damaged'
      }
      for (const item of draftQ.data?.items ?? []) {
        const row = detailQ.data.returns.find((r) => r.variantId === item.variantId && r.status === 'QUARANTINED')
        if (row && !next[row.returnId]) next[row.returnId] = item.decision.toLowerCase() as QualityDecision
      }
      return next
    })
    setNote((prev) => prev || draftQ.data?.note || '')
  }, [detailQ.data, draftQ.data])

  const detail = detailQ.data
  const detailFailure = firstFailedQuery([detailQ, draftQ])
  const rows = detail?.returns ?? []
  const pending = rows.filter((row) => row.status === 'QUARANTINED')
  const allDecided = pending.length > 0 && pending.every((row) => !!decisions[row.returnId])
  const expiredByVariant = new Map((detail?.items ?? []).map((item) => [
    item.variantId,
    !!item.expiresAt && new Date(item.expiresAt).getTime() < Date.now(),
  ]))
  const expiresByVariant = new Map((detail?.items ?? []).map((item) => [item.variantId, item.expiresAt]))

  const saveDraft = () => {
    if (!detail) return
    void returns.saveDraft(
      storeId!,
      orderId,
      rows.map((row) => ({
        variantId: row.variantId,
        quantity: row.quantity,
        decision: (decisions[row.returnId] ?? 'saleable').toUpperCase() as 'SALEABLE' | 'DAMAGED' | 'EXPIRED',
        note: null,
      })),
      note.trim() || null,
    )
  }

  const complete = async () => {
    if (!allDecided) return
    const reason = note.trim() || 'Quality inspection'
    const result = await returns.completeInspection(pending.map((row) => ({
      returnId: row.returnId,
      decision: decisions[row.returnId]!,
      reason,
    })))
    if (result !== null) onClose()
  }

  return (
    <Drawer
      open
      onOpenChange={(v) => { if (!v) onClose() }}
      width="lg"
      title={
        <span className="flex flex-wrap items-center gap-2">
          Return Inspection {detail ? `– ${detail.orderNumber}` : ''}
          {detail && <StatusPill status={RETURN_STATUS_KEY[rows.every((r) => r.status !== 'QUARANTINED') ? 'processed' : 'under_inspection']} />}
        </span>
      }
      subtitle={detail ? `${detail.customerName} · ${detail.failureReason ? REASON_LABEL[mapReturnReason(detail.failureReason)] : 'Failed delivery'}` : 'Loading…'}
      footer={
        !detailFailure && !draftQ.isLoading && pending.length > 0 ? (
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={saveDraft} disabled={!detail}>Save as Draft</Button>
            <Tip tip={allDecided ? undefined : 'Each pending item needs a decision'}>
              <Button disabled={!allDecided} onClick={() => void complete()}>
                <Check className="h-4 w-4" /> Complete Processing
              </Button>
            </Tip>
          </div>
        ) : undefined
      }
    >
      {detailFailure ? (
        <InlineLoadError query={detailFailure} label="return inspection" />
      ) : detailQ.isLoading || draftQ.isLoading || !detail ? (
        <p className="py-10 text-center text-xs text-muted-foreground">Loading return details…</p>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-border/70 bg-muted/40 p-4 text-[13px]">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Order</div>
              <div className="mt-0.5 font-semibold text-brand-700 dark:text-brand-300">#{detail.orderNumber}</div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Customer</div>
              <div className="mt-0.5 font-semibold">{detail.customerName}</div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Failed On</div>
              <div className="mt-0.5">{detail.failedAt ? fmtDateTime(detail.failedAt) : '—'}</div>
            </div>
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Return Reason</div>
              <div className="mt-0.5"><Badge tone={REASON_TONE[mapReturnReason(detail.failureReason)]}>{REASON_LABEL[mapReturnReason(detail.failureReason)]}</Badge></div>
            </div>
          </div>

          <Card>
            <CardHeader><CardTitle>Returned Items ({rows.length})</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {rows.map((row) => {
                const expiry = expiresByVariant.get(row.variantId)
                const closed = row.status !== 'QUARANTINED'
                return (
                  <div key={row.returnId} className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 p-3">
                    <ProductTile icon="milk" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-semibold">{row.variantName}</div>
                      <div className="text-xs text-muted-foreground">
                        Qty {row.quantity} · Expiry {expiry ? fmtDate(expiry) : 'not tracked'}
                        {row.reason ? ` · ${row.reason}` : ''}
                      </div>
                    </div>
                    {closed ? (
                      <Badge tone={row.status === 'APPROVED' ? 'green' : 'red'}>
                        {row.status === 'APPROVED' ? 'Saleable' : 'Written off'}
                      </Badge>
                    ) : (
                      <DecisionGroup
                        value={decisions[row.returnId]}
                        disabled={false}
                        expired={expiredByVariant.get(row.variantId) ?? false}
                        onDecide={(d) => setDecisions((prev) => ({ ...prev, [row.returnId]: d }))}
                      />
                    )}
                  </div>
                )
              })}
              {rows.length === 0 && <p className="py-4 text-center text-xs text-muted-foreground">No return rows recorded for this order.</p>}
            </CardContent>
          </Card>

          {pending.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><BadgeCheck className="h-4 w-4 text-brand-600" /> Inspection Notes</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Saleable rows are approved and restocked; damaged or expired rows are rejected and written off. The note is used as the QC reason.
                </p>
                <Field label="Inspection Note (Optional)">
                  <Textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value.slice(0, 300))}
                    maxLength={300}
                    placeholder="Condition observations, pack state, customer remarks…"
                    aria-label="Inspection note"
                  />
                </Field>
              </CardContent>
            </Card>
          )}

          {pending.length === 0 && (
            <div className="rounded-xl border border-border/70 bg-muted/40 p-4 text-[13px]">
              <div className="font-bold">Processing Outcome</div>
              <p className="mt-1">
                {rows.some((r) => r.status === 'REJECTED') ? 'Damaged/expired items were written off; approved items returned to saleable stock.' : 'All returned items were approved and returned to saleable stock.'}
              </p>
            </div>
          )}
        </div>
      )}
    </Drawer>
  )
}

/* ── Page ──────────────────────────────────────────────────── */
export function StoreReturns() {
  const storeId = useActiveStoreId()
  const stagger = useStagger()

  const [tab, setTab] = useState('eligible')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search)
  const [reason, setReason] = useState('all')
  const [page, setPage] = useState(1)
  const [inspectionOrderId, setInspectionOrderId] = useState<string | null>(null)
  const [recordOpen, setRecordOpen] = useState(false)

  const dash = useStoreDashboard(storeId)
  const eligibleQ = useEligibleReturns(storeId)
  const recordedQ = useRecordedReturns(storeId, debouncedSearch)

  const eligible = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase()
    return (eligibleQ.data ?? []).filter((o) =>
      !q || o.orderNumber.toLowerCase().includes(q) || o.customerName.toLowerCase().includes(q))
  }, [eligibleQ.data, debouncedSearch])

  const recorded = useMemo(() => {
    let rows = recordedQ.data ?? []
    if (reason !== 'all') rows = rows.filter((r) => r.reason === reason)
    return rows
  }, [recordedQ.data, reason])

  const counts = {
    eligible: eligible.length,
    recorded: recorded.length,
    inspection: recorded.filter((r) => r.status !== 'processed').length,
    processed: recorded.filter((r) => r.status === 'processed').length,
  }

  const rows: ReturnParcel[] =
    tab === 'eligible' ? [] :
    tab === 'recorded' ? recorded :
    tab === 'inspection' ? recorded.filter((r) => r.status !== 'processed') :
    recorded.filter((r) => r.status === 'processed')

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const pageRows = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  useEffect(() => { setPage(1) }, [tab, debouncedSearch, reason])

  const recordedColumns: Column<ReturnParcel>[] = [
    { key: 'orderNumber', header: 'Order', render: (r) => <span className="font-semibold text-brand-700 dark:text-brand-300">#{r.orderNumber ?? r.orderId}</span> },
    { key: 'customer', header: 'Customer', render: (r) => r.customerName ?? '—' },
    { key: 'returnedAt', header: 'Returned On', render: (r) => <span className="whitespace-nowrap text-muted-foreground">{fmtDateTime(r.returnedAt)}</span> },
    { key: 'reason', header: 'Reason', render: (r) => <Badge tone={REASON_TONE[r.reason]}>{REASON_LABEL[r.reason]}</Badge> },
    { key: 'items', header: 'Items', render: (r) => <span className="tabular">{r.items.length}</span> },
    { key: 'status', header: 'Status', render: (r) => <StatusPill status={RETURN_STATUS_KEY[r.status]} /> },
    {
      key: 'action', header: 'Action',
      render: (r) => (
        <Button
          variant="outline" size="sm"
          onClick={(e) => { e.stopPropagation(); setInspectionOrderId(r.orderId) }}
          aria-label={`${r.status === 'processed' ? 'View' : 'Inspect'} return for ${r.orderNumber ?? r.orderId}`}
        >
          {r.status === 'processed' ? <>View <Eye className="h-3.5 w-3.5" /></> : <>Inspect <ChevronRight className="h-3.5 w-3.5" /></>}
        </Button>
      ),
    },
  ]

  const eligibleColumns: Column<BackendEligibleReturnOrder>[] = [
    { key: 'orderNumber', header: 'Order', render: (o) => <span className="font-semibold text-brand-700 dark:text-brand-300">#{o.orderNumber}</span> },
    { key: 'customer', header: 'Customer', render: (o) => o.customerName },
    { key: 'failedAt', header: 'Failed On', render: (o) => <span className="whitespace-nowrap text-muted-foreground">{o.failedAt ? fmtDateTime(o.failedAt) : '—'}</span> },
    { key: 'reason', header: 'Reason', render: (o) => <Badge tone={REASON_TONE[mapReturnReason(o.failureReason)]}>{REASON_LABEL[mapReturnReason(o.failureReason)]}</Badge> },
    { key: 'items', header: 'Items', render: (o) => <span className="tabular">{o.itemCount}</span> },
    { key: 'amount', header: 'Order Value', align: 'right', render: (o) => <span className="tabular">{fmtINR(Number(o.totalPaise) / 100)}</span> },
    {
      key: 'action', header: 'Action', align: 'right',
      render: (o) => (
        <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); setRecordOpen(true) }}>
          <Undo2 className="h-3.5 w-3.5" /> Record
        </Button>
      ),
    },
  ]

  const TAB_LABEL: Record<string, string> = {
    eligible: 'Awaiting Return',
    recorded: 'Recorded Returns',
    inspection: 'Under Inspection',
    processed: 'Processed',
  }

  const loadFailure = firstFailedQuery([eligibleQ, recordedQ, dash])
  if (loadFailure) return <PageLoadError title="Returns & Quality Checks" artwork="returns" query={loadFailure} />

  return (
    <motion.div variants={stagger.container} initial="hidden" animate="show" className="space-y-5">
      <PageHeader
        breadcrumb={['Returns & Quality Checks']}
        title="Returns &"
        titleAccent="Quality Checks"
        subtitle="Record returned parcels, inspect product quality and update stock status."
        artwork="returns"
        actions={
          <Button onClick={() => setRecordOpen(true)}><Undo2 className="h-4 w-4" /> Record Return</Button>
        }
      />

      <motion.section variants={stagger.item} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Pending Returns" value={dash.data?.pendingReturns ?? counts.eligible} icon={Undo2} tint="amber" />
        <KpiCard label="Under Inspection" value={dash.data?.underInspection ?? counts.inspection} icon={Search} tint="blue" />
        <KpiCard label="Processed Today" value={dash.data?.processedToday ?? 0} icon={CheckCircle2} tint="green" />
        <KpiCard label="In Quarantine" value={dash.data?.inQuarantine ?? counts.inspection} icon={PackageX} tint="red" />
      </motion.section>

      <motion.section variants={stagger.item} className="space-y-4">
        <TabPills
          id="returns-tabs"
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'eligible', label: 'Awaiting Return', count: counts.eligible },
            { value: 'recorded', label: 'Recorded', count: counts.recorded },
            { value: 'inspection', label: 'Under Inspection', count: counts.inspection },
            { value: 'processed', label: 'Processed', count: counts.processed },
          ]}
        />
        <Card hoverable>
          <CardHeader className="flex-wrap">
            <CardTitle>{TAB_LABEL[tab]}</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput value={search} onChange={setSearch} placeholder="Search by order or customer…" className="w-64" />
              {tab !== 'eligible' && <Select value={reason} onValueChange={setReason} options={REASON_OPTIONS} className="w-48" />}
            </div>
          </CardHeader>
          <CardContent>
            {tab === 'eligible' ? (
              <>
                <DataTable
                  columns={eligibleColumns}
                  rows={eligible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)}
                  keyId={(o) => o.orderId}
                  loading={eligibleQ.isLoading}
                  onRowClick={() => setRecordOpen(true)}
                  skeletonRows={6}
                  empty={<EmptyState icon={Undo2} title="No returns awaiting recording" body="Failed-delivery parcels appear here until a return is recorded." />}
                />
                <Pagination
                  page={page}
                  totalPages={Math.max(1, Math.ceil(eligible.length / PAGE_SIZE))}
                  onChange={setPage}
                  showing={`Showing ${eligible.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, eligible.length)} of ${eligible.length} orders`}
                />
              </>
            ) : (
              <>
                <DataTable
                  columns={recordedColumns}
                  rows={pageRows}
                  keyId={(r) => r.orderId}
                  loading={recordedQ.isLoading}
                  onRowClick={(r) => setInspectionOrderId(r.orderId)}
                  skeletonRows={6}
                  empty={
                    <EmptyState
                      icon={Undo2}
                      title="No returns here"
                      body={tab === 'recorded' ? 'Recorded parcels from failed deliveries will appear in this queue.' : 'Nothing matches this view yet.'}
                    />
                  }
                />
                <Pagination
                  page={page}
                  totalPages={totalPages}
                  onChange={setPage}
                  showing={`Showing ${rows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, rows.length)} of ${rows.length} returns`}
                />
              </>
            )}
          </CardContent>
        </Card>
      </motion.section>

      {inspectionOrderId && (
        <InspectionDrawer
          storeId={storeId}
          orderId={inspectionOrderId}
          onClose={() => setInspectionOrderId(null)}
        />
      )}

      <RecordReturnDialog open={recordOpen} onOpenChange={setRecordOpen} orders={eligible} storeId={storeId} />
    </motion.div>
  )
}
