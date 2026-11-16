// ── §8 Rider payouts & COD (REAL API) ────────────────────────────────────────
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Bike, CheckCircle2, FileUp, Info, MoreHorizontal, ChevronLeft, ChevronRight, Ban, IndianRupee,
} from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import { useFleet, usePayouts, usePayoutCorrections } from '@/hooks/queries'
import { usePayoutActions } from '@/hooks/mutations'
import { PageHeader, TabPills, StatusPill, EmptyState, SearchInput } from '@/components/shared/misc'
import { Select, Field } from '@/components/ui/form'
import { Button, Card, Badge, Input, Textarea } from '@/components/ui/base'
import {
  Dialog, DialogContent, Drawer, ConfirmDialog, DropdownItem, DropdownMenu,
  DropdownMenuContent, DropdownMenuTrigger, Tooltip,
} from '@/components/ui/overlays'
import { DataTable } from '@/components/shared/DataTable'
import { KpiCard } from '@/components/shared/KpiCard'
import type { Payout, PayoutCorrection } from '@/types'
import { cn, fmtDateTime, fmtINR } from '@/lib/utils'

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

/* ── Evidence upload (payout evidence target → PUT → mark paid) ── */
function EvidenceDialog({ open, onOpenChange, title, description, payout, mode, onSubmit }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description: string
  payout: Payout | null
  mode: 'paid' | 'correction'
  correction?: PayoutCorrection | null
  onSubmit: (paymentReference: string, file: File) => void
}) {
  const [reference, setReference] = useState('')
  const [file, setFile] = useState<File | null>(null)
  useEffect(() => { if (open) { setReference(''); setFile(null) } }, [open])
  const invalid = reference.trim().length < 1 || !file
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <div className="space-y-3">
          <Field label="Payment reference" required hint="Bank/UPI reference of the transfer actually made">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} className="font-mono" />
          </Field>
          <Field label="Evidence file" required hint="PDF/JPEG/PNG — uploaded to private evidence storage">
            <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="w-full rounded-xl border border-input bg-card px-3 py-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary-soft file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-brand-700" />
          </Field>
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-warning-soft px-4 py-3 dark:border-amber-500/30">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-warning" />
            <p className="text-xs font-medium leading-relaxed text-amber-800 dark:text-amber-200">
              Recording a settlement does not transfer money — the server records the evidence and settles the record.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" disabled={invalid} onClick={() => { if (reference && file) { onSubmit(reference.trim(), file); onOpenChange(false) } }}>
              <FileUp className="h-4 w-4" /> {mode === 'paid' ? 'Mark paid' : 'Settle correction'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ── Correction dialog ──────────────────────────────────────── */
function CorrectionDialog({ open, onOpenChange, payout, onSubmit }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  payout: Payout | null
  onSubmit: (deltaRupees: number, reason: string) => void
}) {
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')
  useEffect(() => { if (open) { setDelta(''); setReason('') } }, [open])
  const num = Number(delta)
  const invalid = !Number.isFinite(num) || num === 0 || reason.trim().length < 3
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Correction for payout ${payout?.id.slice(0, 8) ?? ''}…`} description="Positive: owed to rider; negative: receivable from rider (paise-safe, signed)">
        <div className="space-y-3">
          <Field label="Adjustment (₹, signed)" required hint="+50 credits the rider, −20 debits">
            <Input type="number" value={delta} onChange={(e) => setDelta(e.target.value)} />
          </Field>
          <Field label="Reason" required>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Missed COD collection added to offset" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" disabled={invalid} onClick={() => { onSubmit(num, reason.trim()); onOpenChange(false) }}>
              <IndianRupee className="h-4 w-4" /> Submit correction
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ── Payout detail drawer ───────────────────────────────────── */
function PayoutDrawer({ payout, onClose, onApprove, onCancel, onCorrection }: {
  payout: Payout
  onClose: () => void
  onApprove: (p: Payout) => void
  onCancel: (p: Payout) => void
  onCorrection: (p: Payout) => void
}) {
  const correctionsQ = usePayoutCorrections(payout.id)
  const corrections: PayoutCorrection[] = correctionsQ.data?.items ?? []
  return (
    <Drawer open onOpenChange={(v) => { if (!v) onClose() }} width="md" title={`Payout ${payout.id.slice(0, 8)}…`} subtitle={`${payout.riderName ?? payout.riderId.slice(0, 8)} · created ${fmtDateTime(payout.createdAt)}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={payout.status.replace(/_/g, '-')} dot />
          {payout.approvedAt && <Badge tone="blue">approved {fmtDateTime(payout.approvedAt)}</Badge>}
          {payout.paidAt && <Badge tone="green">paid {fmtDateTime(payout.paidAt)}</Badge>}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl border border-border/70 bg-muted/30 p-4 text-[13px]">
          <div className="flex gap-2"><dt className="font-semibold text-muted-foreground">Gross:</dt><dd className="font-bold tabular">{fmtINR(payout.gross)}</dd></div>
          <div className="flex gap-2"><dt className="font-semibold text-muted-foreground">COD offset:</dt><dd className="font-bold tabular">−{fmtINR(payout.cashOffset)}</dd></div>
          <div className="flex gap-2"><dt className="font-semibold text-muted-foreground">Net:</dt><dd className="font-extrabold tabular">{fmtINR(payout.net)}</dd></div>
          <div className="flex gap-2"><dt className="font-semibold text-muted-foreground">Rider:</dt><dd className="font-medium">{payout.riderName ?? payout.riderId.slice(0, 8) + '…'}</dd></div>
        </dl>
        <section>
          <h4 className="mb-2 text-[13px] font-bold uppercase tracking-wide text-muted-foreground">Corrections</h4>
          <div className="space-y-1.5">
            {corrections.length === 0 && <p className="rounded-xl border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">No corrections on this payout</p>}
            {corrections.map((c) => (
              <div key={c.id} className="flex items-center gap-3 rounded-xl border border-border/70 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold">{c.reason}</p>
                  <p className="text-[11px] text-muted-foreground">{fmtDateTime(c.createdAt)}{c.settledAt ? ` · settled ${fmtDateTime(c.settledAt)}` : ''}</p>
                </div>
                <span className={cn('shrink-0 font-bold tabular', c.delta >= 0 ? 'text-success' : 'text-destructive')}>
                  {c.delta >= 0 ? '+' : '−'}{fmtINR(Math.abs(c.delta))}
                </span>
                <StatusPill status={c.settledAt ? 'settled' : c.state.toLowerCase()} />
              </div>
            ))}
          </div>
        </section>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={() => onApprove(payout)}><CheckCircle2 className="h-3.5 w-3.5" /> Request approval & execute</Button>
          <Button size="sm" variant="outline" onClick={() => onCorrection(payout)}><IndianRupee className="h-3.5 w-3.5" /> Correction</Button>
          <Button size="sm" variant="outline" className="text-destructive" onClick={() => onCancel(payout)}><Ban className="h-3.5 w-3.5" /> Cancel payout</Button>
        </div>
      </div>
    </Drawer>
  )
}

export function Payouts() {
  const container = useStagger()
  const actions = usePayoutActions()
  const [tab, setTab] = useState('all')

  // rider names from the fleet roster (payout rows carry only ids)
  const fleetQ = useFleet()
  const riderNames: Record<string, string> = {}
  for (const r of fleetQ.data?.items ?? []) riderNames[r.riderId] = r.name

  const [cursor, setCursor] = useState<string | null>(null)
  const [stack, setStack] = useState<Array<string | null>>([null])
  const payoutsQ = usePayouts({ cursor: cursor ?? undefined, riderNames })
  const all: Payout[] = payoutsQ.data?.items ?? []
  const rows = tab === 'all' ? all : all.filter((p) => p.status === tab)

  const [detail, setDetail] = useState<Payout | null>(null)
  const [paidTarget, setPaidTarget] = useState<Payout | null>(null)
  const [correctionTarget, setCorrectionTarget] = useState<Payout | null>(null)
  const [cancelTarget, setCancelTarget] = useState<Payout | null>(null)
  const [settleCorrection, setSettleCorrection] = useState<{ correction: PayoutCorrection; payout: Payout } | null>(null)
  const [search, setSearch] = useState('')

  const filtered = rows.filter((p) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    const name = p.riderName ?? ''
    return p.id.toLowerCase().includes(q) || p.riderId.toLowerCase().includes(q) || name.toLowerCase().includes(q)
  })

  const pendingReview = all.filter((p) => p.status === 'draft' || p.status === 'pending_approval').length
  const paidCount = all.filter((p) => p.status === 'paid').length
  const netTotal = all.reduce((a, p) => a + p.net, 0)

  return (
    <div className="space-y-5">
      <PageHeader
        title="Rider payouts"
        titleAccent="& COD"
        subtitle="Weekly payout records with maker-checker approvals and evidence-backed settlement."
        artwork="payouts"
        breadcrumb={['Payouts']}
      />

      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-5">
        <motion.section variants={container.item} className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <KpiCard label="Awaiting review (page)" value={pendingReview} icon={Bike} tint="amber" format="num" />
          <KpiCard label="Paid (page)" value={paidCount} icon={CheckCircle2} tint="green" format="num" />
          <KpiCard label="Net value (page)" value={netTotal} icon={IndianRupee} tint="blue" format="inr" />
          <KpiCard label="Riders on roster" value={fleetQ.data?.items.length ?? 0} icon={Bike} tint="violet" format="num" />
        </motion.section>

        <motion.div variants={container.item}>
          <TabPills
            id="payout-tabs"
            value={tab}
            onChange={setTab}
            tabs={[
              { value: 'all', label: 'All' },
              { value: 'draft', label: 'Draft' },
              { value: 'pending_approval', label: 'Pending approval' },
              { value: 'approved', label: 'Approved' },
              { value: 'paid', label: 'Paid' },
              { value: 'cancelled', label: 'Cancelled' },
            ]}
          />
        </motion.div>

        <motion.section variants={container.item} className="space-y-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <SearchInput value={search} onChange={setSearch} placeholder="Search payout or rider…" className="min-w-[220px] flex-1" />
          </div>
          <Card className="overflow-hidden">
            <DataTable
              keyId={(p) => p.id}
              rows={filtered}
              loading={payoutsQ.isLoading}
              onRowClick={(p) => setDetail(p)}
              empty={<EmptyState icon={Bike} title="No payouts match" body="Payouts are drafted by the platform after each cycle." />}
              columns={[
                { key: 'id', header: 'Payout', render: (p: Payout) => <span className="font-mono text-[13px] font-bold">{p.id.slice(0, 8)}…</span> },
                {
                  key: 'rider', header: 'Rider',
                  render: (p: Payout) => <span className="text-[13px]">{p.riderName ?? <span className="text-muted-foreground">{p.riderId.slice(0, 8)}…</span>}</span>,
                },
                { key: 'gross', header: 'Gross', render: (p: Payout) => <span className="tabular">{fmtINR(p.gross)}</span> },
                { key: 'cod', header: 'COD offset', render: (p: Payout) => <span className="tabular text-muted-foreground">−{fmtINR(p.cashOffset)}</span> },
                { key: 'net', header: 'Net', render: (p: Payout) => <span className="font-bold tabular">{fmtINR(p.net)}</span> },
                { key: 'status', header: 'Status', render: (p: Payout) => <StatusPill status={p.status.replace(/_/g, '-')} dot /> },
                {
                  key: 'actions', header: '', align: 'right' as const,
                  render: (p: Payout) => (
                    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="iconSm" variant="ghost" aria-label={`Actions for payout`}><MoreHorizontal className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <Tooltip content={p.status === 'paid' ? 'Already paid' : 'Request approval then execute (maker-checker)'}>
                            <span className="block w-full">
                              <DropdownItem disabled={p.status === 'paid' || p.status === 'cancelled'} onSelect={() => actions.approve(p.id).mutate(undefined, { onError: () => {} })}>
                                <CheckCircle2 className="h-3.5 w-3.5" /> Approve
                              </DropdownItem>
                            </span>
                          </Tooltip>
                          <DropdownItem onSelect={() => setPaidTarget(p)}><FileUp className="h-3.5 w-3.5" /> Mark paid w/ evidence</DropdownItem>
                          <DropdownItem onSelect={() => setCorrectionTarget(p)}><IndianRupee className="h-3.5 w-3.5" /> Request correction</DropdownItem>
                          <DropdownItem danger onSelect={() => setCancelTarget(p)}><Ban className="h-3.5 w-3.5" /> Cancel</DropdownItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ),
                },
              ]}
            />
            <CursorBar
              onPrev={() => setStack((st) => { if (st.length <= 1) return st; const s = st.slice(0, -1); setCursor(s[s.length - 1] ?? null); return s })}
              onNext={() => {
                const nc = payoutsQ.data?.nextCursor ?? null
                if (!nc) return
                setStack((st) => [...st, nc]); setCursor(nc)
              }}
              hasPrev={stack.length > 1}
              hasNext={!!payoutsQ.data?.nextCursor}
              loading={payoutsQ.isLoading}
              label={`Page ${stack.length} · payouts feed`}
            />
          </Card>
          <p className="text-xs text-muted-foreground">Caption: recording a settlement does not transfer money — the server stores evidence and settles records.</p>
        </motion.section>
      </motion.div>

      {/* detail drawer */}
      {detail && (
        <PayoutDrawer
          payout={detail}
          onClose={() => setDetail(null)}
          onApprove={(p) => { actions.approve(p.id).mutate(undefined, { onError: () => {} }); setDetail(null) }}
          onCancel={(p) => { setCancelTarget(p); setDetail(null) }}
          onCorrection={(p) => { setCorrectionTarget(p); setDetail(null) }}
        />
      )}

      {/* evidence / paid dialog */}
      <EvidenceDialog
        open={!!paidTarget}
        onOpenChange={(v) => { if (!v) setPaidTarget(null) }}
        title={`Mark payout paid — ${paidTarget?.id.slice(0, 8) ?? ''}…`}
        description="Upload the transfer evidence; the server settles the payout record"
        payout={paidTarget}
        mode="paid"
        onSubmit={(reference, file) => { if (paidTarget) actions.markPaid(paidTarget.id, reference, file).mutate(undefined, { onError: () => {} }) }}
      />

      {/* correction dialog */}
      <CorrectionDialog
        open={!!correctionTarget}
        onOpenChange={(v) => { if (!v) setCorrectionTarget(null) }}
        payout={correctionTarget}
        onSubmit={(delta, reason) => { if (correctionTarget) actions.addCorrection(correctionTarget.id, delta, reason, '').mutate(undefined, { onError: () => {} }) }}
      />

      {/* settle correction dialog */}
      <EvidenceDialog
        open={!!settleCorrection}
        onOpenChange={(v) => { if (!v) setSettleCorrection(null) }}
        title="Settle correction"
        description="Upload the transfer evidence to settle this correction"
        payout={settleCorrection?.payout ?? null}
        correction={settleCorrection?.correction ?? null}
        mode="correction"
        onSubmit={(reference, file) => { if (settleCorrection) actions.settleCorrection(settleCorrection.correction.id, reference, file).mutate(undefined, { onError: () => {} }) }}
      />

      {/* cancel confirm */}
      <ConfirmDialog
        open={!!cancelTarget}
        onOpenChange={(v) => { if (!v) setCancelTarget(null) }}
        title={`Cancel payout ${cancelTarget?.id.slice(0, 8) ?? ''}…?`}
        description="Cancelled payouts are excluded from the next draft; earnings return to the pool."
        confirmLabel="Cancel payout"
        destructive
        onConfirm={() => { if (cancelTarget) actions.cancel(cancelTarget.id).mutate(undefined, { onError: () => {} }); setCancelTarget(null) }}
      />
    </div>
  )
}

export default Payouts
