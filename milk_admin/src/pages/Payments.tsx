// ── §7 Payments, refunds & wallets (REAL API) ────────────────────────────────
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  RefreshCcw, SearchX, ChevronLeft, ChevronRight, Wallet, RotateCcw, Receipt,
  FileWarning, Scale, Check, AlertTriangle,
} from 'lucide-react'
import { useStagger, useDebouncedValue } from '@/hooks/misc'
import { usePaymentAttempts, useRefundList, useWalletLedger, useReconciliation, useInvoiceFailures, useStoreOptions } from '@/hooks/queries'
import { usePaymentActions } from '@/hooks/mutations'
import { rangeToFromTo } from '@/api/mapping'
import { PageHeader, TabPills, SearchInput, StatusPill, EmptyState } from '@/components/shared/misc'
import { Select, Field } from '@/components/ui/form'
import { Button, Card, Badge, Input, Textarea } from '@/components/ui/base'
import { Dialog, DialogContent, Tooltip } from '@/components/ui/overlays'
import { DataTable } from '@/components/shared/DataTable'
import { KpiCard } from '@/components/shared/KpiCard'
import type { PaymentAttempt, RangeKey, RefundRow, ReconciliationFinding, WalletLedgerRow } from '@/types'
import { cn, fmtDateTime, fmtINR } from '@/lib/utils'

type MainTab = 'attempts' | 'refunds' | 'wallet' | 'reconciliation' | 'invoices'

const RECON_DECISIONS = [
  { value: 'ACKNOWLEDGED', label: 'Acknowledge' },
  { value: 'DISMISSED', label: 'Dismiss' },
  { value: 'ESCALATED', label: 'Escalate' },
  { value: 'RESOLVED', label: 'Resolve' },
] as const

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

function ReviewDialog({ open, onOpenChange, title, description, decisions, onDecide }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description: string
  decisions: readonly Readonly<{ value: string; label: string }>[]
  onDecide: (decision: string, reason: string) => void
}) {
  const [decision, setDecision] = useState(decisions[0]?.value ?? '')
  const [reason, setReason] = useState('')
  useEffect(() => { if (open) { setDecision(decisions[0]?.value ?? ''); setReason('') } }, [open, decisions])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <div className="space-y-3">
          <Field label="Decision" required>
            <Select value={decision} onValueChange={setDecision} options={decisions.map((d) => ({ value: d.value, label: d.label }))} />
          </Field>
          <Field label="Reason" required hint="Stored with the audit record">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Explain the review outcome…" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" disabled={reason.trim().length < 3} onClick={() => { onDecide(decision, reason.trim()); onOpenChange(false) }}>Submit review</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function WalletAdjustDialog({ open, onOpenChange, onSubmit }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onSubmit: (input: { userId: string; bucket: 'cash' | 'promo'; direction: 'CREDIT' | 'DEBIT'; amountRupees: number; reason: string }) => void
}) {
  const [userId, setUserId] = useState('')
  const [bucket, setBucket] = useState<'cash' | 'promo'>('cash')
  const [direction, setDirection] = useState<'CREDIT' | 'DEBIT'>('CREDIT')
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  useEffect(() => { if (open) { setUserId(''); setAmount(''); setReason(''); setBucket('cash'); setDirection('CREDIT') } }, [open])
  const invalid = userId.trim().length < 8 || !Number(amount) || Number(amount) <= 0 || reason.trim().length < 3
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Wallet adjustment" description="Maker-checker: another admin approves before money moves">
        <div className="space-y-3">
          <Field label="Customer user id (uuid)" required hint="Copy the id from People › Customers">
            <Input value={userId} onChange={(e) => setUserId(e.target.value)} className="font-mono" placeholder="user uuid" />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Bucket" required>
              <Select value={bucket} onValueChange={(v) => setBucket(v as 'cash' | 'promo')} options={[{ value: 'cash', label: 'Cash' }, { value: 'promo', label: 'Promo' }]} />
            </Field>
            <Field label="Direction" required>
              <Select value={direction} onValueChange={(v) => setDirection(v as 'CREDIT' | 'DEBIT')} options={[{ value: 'CREDIT', label: 'Credit' }, { value: 'DEBIT', label: 'Debit' }]} />
            </Field>
            <Field label="Amount (₹)" required>
              <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
          <Field label="Reason" required hint="Recorded on the ledger and audit log">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.eg. Goodwill credit for late delivery" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" disabled={invalid} onClick={() => { onSubmit({ userId: userId.trim(), bucket, direction, amountRupees: Number(amount), reason: reason.trim() }); onOpenChange(false) }}>
              <Wallet className="h-4 w-4" /> Submit for approval
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function Payments() {
  const container = useStagger()
  const actions = usePaymentActions()
  const [tab, setTab] = useState<MainTab>('attempts')
  const [range, setRange] = useState<RangeKey>('30d')
  const [reviewTarget, setReviewTarget] = useState<ReconciliationFinding | null>(null)
  const [adjustOpen, setAdjustOpen] = useState(false)

  const storesQ = useStoreOptions()
  const stores = storesQ.data ?? []
  const [storeId, setStoreId] = useState('all')
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search, 250)

  const { from, to } = rangeToFromTo(range)
  const filters = {
    storeId: storeId === 'all' ? undefined : storeId,
    search: debouncedSearch || undefined,
    from, to,
  }

  // per-tab cursor stacks
  const [attemptsCursor, setAttemptsCursor] = useState<string | null>(null)
  const [attemptsStack, setAttemptsStack] = useState<Array<string | null>>([null])
  const attemptsQ = usePaymentAttempts({ ...filters, cursor: attemptsCursor ?? undefined, limit: 10 })
  const attempts: PaymentAttempt[] = attemptsQ.data?.items ?? []

  const [refundsCursor, setRefundsCursor] = useState<string | null>(null)
  const [refundsStack, setRefundsStack] = useState<Array<string | null>>([null])
  const refundsQ = useRefundList({ ...filters, cursor: refundsCursor ?? undefined, limit: 10 })
  const refunds: RefundRow[] = refundsQ.data?.items ?? []

  const [walletCursor, setWalletCursor] = useState<string | null>(null)
  const [walletStack, setWalletStack] = useState<Array<string | null>>([null])
  const walletQ = useWalletLedger({ bucket: undefined, cursor: walletCursor ?? undefined, limit: 10 })
  const wallet: WalletLedgerRow[] = walletQ.data?.items ?? []

  const reconQ = useReconciliation()
  const recon: ReconciliationFinding[] = reconQ.data?.items ?? []

  const invoicesQ = useInvoiceFailures()
  const invoiceFailures = invoicesQ.data?.items ?? []

  useEffect(() => {
    setAttemptsCursor(null); setAttemptsStack([null])
    setRefundsCursor(null); setRefundsStack([null])
  }, [storeId, range, debouncedSearch])

  const captured = attempts.filter((a) => a.status === 'captured').length
  const failed = attempts.filter((a) => a.status === 'failed').length
  const pendingRefunds = refunds.filter((r) => r.status === 'pending').length
  const reconOpen = recon.filter((r) => r.status === 'open').length

  const pageNext = (data: { nextCursor: string | null } | undefined, setC: (c: string | null) => void, setStack: React.Dispatch<React.SetStateAction<Array<string | null>>>) => {
    const nc = data?.nextCursor ?? null
    if (!nc) return
    setStack((st) => [...st, nc]); setC(nc)
  }
  const pagePrev = (setC: (c: string | null) => void, setStack: React.Dispatch<React.SetStateAction<Array<string | null>>>) => {
    setStack((st) => {
      if (st.length <= 1) return st
      const s = st.slice(0, -1)
      setC(s[s.length - 1] ?? null)
      return s
    })
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Payments,"
        titleAccent="refunds & wallets"
        subtitle="Gateway attempts, refunds, wallet ledger and reconciliation — money moves only through server approvals."
        artwork="payments"
        breadcrumb={['Payments']}
        actions={(
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="w-44">
              <Select value={storeId} onValueChange={setStoreId} options={[{ value: 'all', label: 'All stores' }, ...stores.map((s) => ({ value: s.id, label: s.name }))]} />
            </div>
            <Select value={range} onValueChange={(v) => setRange(v as RangeKey)} options={[
              { value: 'today', label: 'Today' }, { value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' }, { value: '90d', label: 'Last 90 days' },
            ]} />
          </div>
        )}
      />

      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-5">
        <motion.section variants={container.item} className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <KpiCard label="Captured (page)" value={captured} icon={Check} tint="green" format="num" />
          <KpiCard label="Failed (page)" value={failed} icon={AlertTriangle} tint="red" format="num" />
          <KpiCard label="Refunds pending" value={pendingRefunds} icon={RotateCcw} tint="amber" format="num" />
          <KpiCard label="Reconciliation open" value={reconOpen} icon={Scale} tint="violet" format="num" highlight={reconOpen > 0} />
        </motion.section>

        <motion.div variants={container.item}>
          <TabPills
            id="payments-tabs"
            value={tab}
            onChange={(v) => setTab(v as MainTab)}
            tabs={[
              { value: 'attempts', label: 'Attempts' },
              { value: 'refunds', label: 'Refunds' },
              { value: 'wallet', label: 'Wallet ledger' },
              { value: 'reconciliation', label: 'Reconciliation', count: reconOpen },
              { value: 'invoices', label: 'Invoice failures', count: invoiceFailures.length },
            ]}
          />
        </motion.div>

        {/* ── ATTEMPTS ── */}
        {tab === 'attempts' && (
          <motion.section variants={container.item} className="space-y-3">
            <SearchInput value={search} onChange={setSearch} placeholder="Search by order or reference…" className="min-w-[220px]" />
            <Card className="overflow-hidden">
              <DataTable
                keyId={(a) => a.attemptId}
                rows={attempts}
                loading={attemptsQ.isLoading}
                empty={<EmptyState icon={SearchX} title="No attempts match" body="Adjust the filters or range." />}
                columns={[
                  { key: 'order', header: 'Order', render: (a: PaymentAttempt) => <Link to={`/orders/${a.orderId}`} className="font-mono text-[13px] font-bold text-brand-700 hover:underline dark:text-brand-300">{a.orderId.slice(0, 8)}…</Link> },
                  { key: 'kind', header: 'Kind', render: (a: PaymentAttempt) => <Badge tone="blue">{a.kind.toLowerCase().replace(/_/g, ' ')}</Badge> },
                  { key: 'amount', header: 'Amount', render: (a: PaymentAttempt) => <span className="font-bold tabular">{fmtINR(a.amount)}</span> },
                  { key: 'status', header: 'Status', render: (a: PaymentAttempt) => <StatusPill status={a.status} dot /> },
                  { key: 'ref', header: 'Gateway ref', render: (a: PaymentAttempt) => <span className="font-mono text-[11px] text-muted-foreground">{a.gatewayPaymentId ? `${a.gatewayPaymentId.slice(0, 14)}…` : '—'}</span> },
                  { key: 'at', header: 'When', render: (a: PaymentAttempt) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(a.createdAt)}</span> },
                ]}
              />
              <CursorBar
                onPrev={() => pagePrev(setAttemptsCursor, setAttemptsStack)}
                onNext={() => pageNext(attemptsQ.data, setAttemptsCursor, setAttemptsStack)}
                hasPrev={attemptsStack.length > 1}
                hasNext={!!attemptsQ.data?.nextCursor}
                loading={attemptsQ.isLoading}
                label={`Page ${attemptsStack.length} · attempts feed`}
              />
            </Card>
          </motion.section>
        )}

        {/* ── REFUNDS ── */}
        {tab === 'refunds' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-warning-soft px-4 py-3 dark:border-amber-500/30">
              <Scale className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-warning" />
              <p className="text-[13px] font-medium leading-relaxed text-amber-800 dark:text-amber-200">
                Refund requests are filed on the order (with an Idempotency-Key) and settled via approvals. Manual settlements record evidence only — the server moves the money.
              </p>
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(r) => r.refundId}
                rows={refunds}
                loading={refundsQ.isLoading}
                empty={<EmptyState icon={SearchX} title="No refunds match" body="Adjust the filters or range." />}
                columns={[
                  { key: 'order', header: 'Order', render: (r: RefundRow) => <Link to={`/orders/${r.orderId}`} className="font-mono text-[13px] font-bold text-brand-700 hover:underline dark:text-brand-300">{r.orderId.slice(0, 8)}…</Link> },
                  { key: 'amount', header: 'Amount', render: (r: RefundRow) => <span className="font-bold tabular">{fmtINR(r.amount)}</span> },
                  { key: 'status', header: 'Status', render: (r: RefundRow) => <StatusPill status={r.status} dot /> },
                  { key: 'destination', header: 'Destination', render: (r: RefundRow) => <Badge tone="blue">{r.destination.toLowerCase().replace(/_/g, ' ')}</Badge> },
                  { key: 'reason', header: 'Reason', render: (r: RefundRow) => <span className="block max-w-[220px] truncate text-[13px] text-muted-foreground">{r.reason ?? '—'}</span> },
                ]}
              />
              <CursorBar
                onPrev={() => pagePrev(setRefundsCursor, setRefundsStack)}
                onNext={() => pageNext(refundsQ.data, setRefundsCursor, setRefundsStack)}
                hasPrev={refundsStack.length > 1}
                hasNext={!!refundsQ.data?.nextCursor}
                loading={refundsQ.isLoading}
                label={`Page ${refundsStack.length} · refunds feed`}
              />
            </Card>
          </motion.section>
        )}

        {/* ── WALLET ── */}
        {tab === 'wallet' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <p className="text-xs text-muted-foreground">Combined cash + promo buckets · filter by user id on the server when needed</p>
              <Button variant="primary" size="md" onClick={() => setAdjustOpen(true)}><Wallet className="h-4 w-4" /> Wallet adjustment</Button>
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(r) => r.id}
                rows={wallet}
                loading={walletQ.isLoading}
                empty={<EmptyState icon={Wallet} title="No wallet entries" body="Wallet ledger rows will appear here." />}
                columns={[
                  { key: 'user', header: 'Customer', render: (r: WalletLedgerRow) => <span className="font-mono text-xs text-muted-foreground">{r.userId.slice(0, 8)}…</span> },
                  { key: 'bucket', header: 'Bucket', render: (r: WalletLedgerRow) => <Badge tone={r.bucket === 'cash' ? 'green' : 'violet'}>{r.bucket}</Badge> },
                  { key: 'reason', header: 'Reason', render: (r: WalletLedgerRow) => <span className="text-[13px]">{r.reason.toLowerCase().replace(/_/g, ' ')}</span> },
                  {
                    key: 'delta', header: 'Change',
                    render: (r: WalletLedgerRow) => (
                      <span className={cn('font-bold tabular', r.delta >= 0 ? 'text-success' : 'text-destructive')}>
                        {r.delta >= 0 ? '+' : '−'}{fmtINR(Math.abs(r.delta))}
                      </span>
                    ),
                  },
                  { key: 'balance', header: 'Balance after', render: (r: WalletLedgerRow) => <span className="tabular">{fmtINR(r.balanceAfter)}</span> },
                  { key: 'at', header: 'When', render: (r: WalletLedgerRow) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(r.createdAt)}</span> },
                ]}
              />
              <CursorBar
                onPrev={() => pagePrev(setWalletCursor, setWalletStack)}
                onNext={() => pageNext(walletQ.data, setWalletCursor, setWalletStack)}
                hasPrev={walletStack.length > 1}
                hasNext={!!walletQ.data?.nextCursor}
                loading={walletQ.isLoading}
                label={`Page ${walletStack.length} · wallet feed`}
              />
            </Card>
          </motion.section>
        )}

        {/* ── RECONCILIATION ── */}
        {tab === 'reconciliation' && (
          <motion.section variants={container.item} className="space-y-3">
            <Card className="overflow-hidden">
              <DataTable
                keyId={(r) => r.id}
                rows={recon}
                loading={reconQ.isLoading}
                empty={<EmptyState icon={Scale} title="No reconciliation findings" body="Open findings will appear here for review." />}
                columns={[
                  { key: 'kind', header: 'Kind', render: (r: ReconciliationFinding) => <Badge tone="amber">{r.kind.toLowerCase().replace(/_/g, ' ')}</Badge> },
                  { key: 'sev', header: 'Severity', render: (r: ReconciliationFinding) => <StatusPill status={r.severity} /> },
                  { key: 'ref', header: 'Reference', render: (r: ReconciliationFinding) => <span className="font-mono text-xs">{r.reference}</span> },
                  { key: 'status', header: 'Status', render: (r: ReconciliationFinding) => <StatusPill status={r.status} dot /> },
                  { key: 'at', header: 'When', render: (r: ReconciliationFinding) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(r.createdAt)}</span> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (r: ReconciliationFinding) => (
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => setReviewTarget(r)}><Scale className="h-3.5 w-3.5" /> Review</Button>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          </motion.section>
        )}

        {/* ── INVOICE FAILURES ── */}
        {tab === 'invoices' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-warning-soft px-4 py-3 dark:border-amber-500/30">
              <FileWarning className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-warning" />
              <p className="text-[13px] font-medium leading-relaxed text-amber-800 dark:text-amber-200">
                Retry is only accepted once the underlying cause is fixed — the server validates and may reject with its reason.
              </p>
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(r) => r.documentId}
                rows={invoiceFailures}
                loading={invoicesQ.isLoading}
                empty={<EmptyState icon={Receipt} title="No invoice render failures" body="All invoices are rendering cleanly." />}
                columns={[
                  { key: 'number', header: 'Invoice', render: (r) => <span className="font-mono text-[13px] font-bold">{r.number}</span> },
                  { key: 'attempts', header: 'Attempts', render: (r) => <span className="tabular">{r.attempts}</span> },
                  { key: 'at', header: 'Suspended at', render: (r) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(r.suspendedAt)}</span> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (r) => (
                      <div className="flex justify-end">
                        <Tooltip content="Request a render retry (idempotent)">
                          <span>
                            <Button size="sm" variant="primary" onClick={() => actions.retryInvoice(r.documentId, 'Manual retry from payments view').mutate(undefined, { onError: () => {} })}>
                              <RefreshCcw className="h-3.5 w-3.5" /> Retry render
                            </Button>
                          </span>
                        </Tooltip>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          </motion.section>
        )}
      </motion.div>

      {/* review dialog */}
      <ReviewDialog
        open={!!reviewTarget}
        onOpenChange={(v) => { if (!v) setReviewTarget(null) }}
        title={`Review finding ${reviewTarget?.reference ?? ''}`}
        description="Reviews are recorded with your reason in the audit log"
        decisions={RECON_DECISIONS}
        onDecide={(decision, reason) => {
          if (reviewTarget) actions.setReconciliationStatus(reviewTarget.id, decision as never, reason).mutate(undefined, { onError: () => {} })
        }}
      />

      {/* wallet adjustment dialog */}
      <WalletAdjustDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        onSubmit={(input) => actions.walletAdjust(input).mutate(undefined, { onError: () => {} })}
      />
    </div>
  )
}

export default Payments
