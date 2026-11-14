// ── §13 Approvals & compliance (REAL API: approvals, fraud, erasure, holds) ──
import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  ScrollText, ShieldAlert, Trash2, Lock, Unlock, RefreshCcw, ShieldCheck, Info,
  CheckCircle2, XCircle,
} from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import {
  useApprovals, useFraudSignals, useErasureRequests, useLegalHolds, useUsers,
} from '@/hooks/queries'
import { useApprovalActions, useOrderActions, usePayoutActions, usePaymentActions, usePeopleActions, useProductActions } from '@/hooks/mutations'
import { PageHeader, TabPills, StatusPill, EmptyState } from '@/components/shared/misc'
import { Field } from '@/components/ui/form'
import { Button, Card, Badge, Input, Textarea } from '@/components/ui/base'
import { Dialog, DialogContent, Tooltip } from '@/components/ui/overlays'
import { ApprovalCard } from '@/components/shared/domain'
import { DataTable } from '@/components/shared/DataTable'
import type { Approval, ErasureRequest, FraudSignal, LegalHold } from '@/types'
import { fmtDateTime } from '@/lib/utils'

type MainTab = 'approvals' | 'fraud' | 'erasure' | 'holds'

const DECISION_OPTIONS = [
  { value: 'ACKNOWLEDGED', label: 'Acknowledge' },
  { value: 'DISMISSED', label: 'Dismiss' },
  { value: 'ESCALATED', label: 'Escalate' },
  { value: 'RESOLVED', label: 'Resolve' },
] as const

/** Domain executors per approval action, driven by the server's `action` field. */
function approvalExecutorLabel(action: string): { label: string; hint: string } {
  const a = action.toLowerCase()
  if (a.includes('payout')) return { label: 'Execute payout approval', hint: 'Runs the payout approval through its domain endpoint' }
  if (a.includes('wallet')) return { label: 'Execute wallet adjustment', hint: 'Applies the wallet credit/debit exactly once' }
  if (a.includes('inventory') || a.includes('adjustment')) return { label: 'Execute inventory adjustment', hint: 'Approves the stock adjustment (checker rules apply)' }
  if (a.includes('refund')) return { label: 'Execute refund approval', hint: 'Commits the refund with an idempotency key' }
  if (a.includes('role')) return { label: 'Approve role change', hint: 'Grants or revokes the workforce role' }
  if (a.includes('erasure')) return { label: 'Approve erasure', hint: 'Starts the erasure workflow' }
  if (a.includes('order')) return { label: 'Execute order approval', hint: 'Runs the order approval (refund/repair)' }
  if (a.includes('catalog') || a.includes('price') || a.includes('import')) return { label: 'Approve catalog change', hint: 'Applies the pending catalog change' }
  if (a.includes('ticket')) return { label: 'Execute ticket refund', hint: 'Executes the ticket refund approval' }
  return { label: 'Reject / resolve via review', hint: 'This action type is handled via review decisions' }
}

function ReasonDialog({ open, onOpenChange, title, description, confirmLabel, destructive, onConfirm }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  description: string
  confirmLabel: string
  destructive?: boolean
  onConfirm: (reason: string) => void
}) {
  const [reason, setReason] = useState('')
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <div className="space-y-3">
          <Field label="Reason" required hint="Stored on the audit record">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Explain the decision…" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant={destructive ? 'destructive' : 'primary'} size="md" disabled={reason.trim().length < 3} onClick={() => { onConfirm(reason.trim()); setReason(''); onOpenChange(false) }}>
              {confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function Approvals() {
  const container = useStagger()
  const [tab, setTab] = useState<MainTab>('approvals')

  const approvalsQ = useApprovals()
  const fraudQ = useFraudSignals()
  const erasureQ = useErasureRequests()
  const holdsQ = useLegalHolds()
  const usersQ = useUsers({ limit: 200 })

  const approvals: Approval[] = approvalsQ.data?.items ?? []
  const pending = approvals.filter((a) => a.status === 'pending')
  const fraud: FraudSignal[] = fraudQ.data ?? []
  const erasure: ErasureRequest[] = erasureQ.data ?? []
  const holds: LegalHold[] = holdsQ.data ?? []
  const users = usersQ.data?.items ?? []
  const userName = (id: string | null) => (id ? users.find((u) => u.userId === id)?.name ?? `${id.slice(0, 8)}…` : '—')

  const approvalActions = useApprovalActions()
  const orderActions = useOrderActions()
  const payoutActions = usePayoutActions()
  const paymentActions = usePaymentActions()
  const peopleActions = usePeopleActions()
  const productActions = useProductActions()

  const [rejectTarget, setRejectTarget] = useState<Approval | null>(null)
  const [reviewTarget, setReviewTarget] = useState<FraudSignal | null>(null)
  const [holdDialog, setHoldDialog] = useState(false)
  const [holdUserId, setHoldUserId] = useState('')
  const [releaseTarget, setReleaseTarget] = useState<LegalHold | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  /** Execute a pending approval through its domain endpoint (server revalidates). */
  const execute = (a: Approval) => {
    const action = a.action.toLowerCase()
    try {
      if (action.includes('order') && (action.includes('refund') || action.includes('repair'))) {
        orderActions.approveOrderApproval(a.id).mutate(undefined, { onError: (e) => setMessage(e.message) })
      } else if (action.includes('payout')) {
        payoutActions.approve(a.id).mutate(undefined, { onError: (e) => setMessage(e.message) })
      } else if (action.includes('wallet')) {
        paymentActions.approveWalletAdjustment(a.id).mutate(undefined, { onError: (e) => setMessage(e.message) })
      } else if (action.includes('inventory') || action.includes('adjustment')) {
        void import('@/api/inventory').then(({ approveInventoryAdjustment }) =>
          approveInventoryAdjustment(crypto.randomUUID(), a.id),
        ).then(() => setMessage('Inventory adjustment approved'))
      } else if (action.includes('role')) {
        peopleActions.approveRoleChange(a.id).mutate(undefined, { onError: (e) => setMessage(e.message) })
      } else if (action.includes('erasure')) {
        approvalActions.approveErasure(a.id).mutate(undefined, { onError: (e) => setMessage(e.message) })
      } else if (action.includes('catalog')) {
        productActions.approveCatalogChange(a.id).mutate(undefined, { onError: (e) => setMessage(e.message) })
      } else {
        setMessage(`No direct executor for "${a.action}" — use the domain page for this change.`)
        return
      }
      setMessage(null)
    } catch {
      setMessage('The executor for this approval type is unavailable.')
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Approvals &"
        titleAccent="compliance"
        subtitle="Maker-checker queue, fraud signals, erasure requests and legal holds."
        artwork="approvals"
        breadcrumb={['Approvals']}
        actions={(
          <Button variant="primary" size="md" onClick={() => setHoldDialog(true)}>
            <Lock className="h-4 w-4" /> Place legal hold
          </Button>
        )}
      />

      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-4">
        <motion.div variants={container.item}>
          <TabPills
            id="approvals-tabs"
            value={tab}
            onChange={(v) => setTab(v as MainTab)}
            tabs={[
              { value: 'approvals', label: 'Approvals', count: pending.length },
              { value: 'fraud', label: 'Fraud signals', count: fraud.length },
              { value: 'erasure', label: 'Erasure requests', count: erasure.length },
              { value: 'holds', label: 'Legal holds', count: holds.filter((h) => !h.releasedAt).length },
            ]}
          />
        </motion.div>

        {/* ── APPROVALS ── */}
        {tab === 'approvals' && (
          <motion.section variants={container.item} className="space-y-3">
            {message && <Card className="border-destructive/40 bg-destructive-soft/60 p-4 text-[13px] font-semibold text-destructive">{message}</Card>}
            {approvalsQ.isLoading ? (
              <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-20 w-full rounded-card" />)}</div>
            ) : approvals.length === 0 ? (
              <Card className="p-8"><EmptyState icon={ScrollText} title="No approvals" body="Maker-checker requests will appear here." /></Card>
            ) : (
              <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                {approvals.map((a) => {
                  const meta = approvalExecutorLabel(a.action)
                  const pendingA = a.status === 'pending'
                  const isMaker = a.makerId && a.makerId.length > 0
                  return (
                    <ApprovalCard
                      key={a.id}
                      approval={{
                        id: a.id,
                        status: a.status,
                        canApprove: pendingA,
                        cannotApproveReason: pendingA ? undefined : `Already ${a.status}`,
                      }}
                      onDecide={(id, decision) => {
                        if (decision === 'completed') execute(approvals.find((x) => x.id === id) ?? a)
                        else setRejectTarget(approvals.find((x) => x.id === id) ?? a)
                      }}
                    >
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone="violet">{a.action}</Badge>
                          <StatusPill status={a.status} dot />
                          <span className="ml-auto text-[11px] text-muted-foreground">expires {fmtDateTime(a.expiresAt)}</span>
                        </div>
                        <p className="text-[13px] font-semibold">{meta.label}</p>
                        <p className="text-[12px] text-muted-foreground">{meta.hint}</p>
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
                          <div>Maker: <span className="font-mono">{userName(a.makerId)}</span></div>
                          <div>Checker: <span className="font-mono">{a.checkerId ? userName(a.checkerId) : '—'}</span></div>
                          <div>Required role: <span className="font-semibold text-foreground/80">{a.requiredRole.toLowerCase()}</span></div>
                          <div>Requested: {fmtDateTime(a.createdAt)}</div>
                        </dl>
                        {pendingA && (
                          <div className="flex justify-end gap-2 pt-1">
                            <Tooltip content="Reject with a reason (audit-logged)">
                              <span>
                                <Button size="sm" variant="outline" className="text-destructive" onClick={() => setRejectTarget(a)}>
                                  <XCircle className="h-3.5 w-3.5" /> Reject
                                </Button>
                              </span>
                            </Tooltip>
                            <Tooltip content={meta.hint}>
                              <span>
                                <Button size="sm" variant="primary" onClick={() => execute(a)}>
                                  <CheckCircle2 className="h-3.5 w-3.5" /> {meta.label}
                                </Button>
                              </span>
                            </Tooltip>
                          </div>
                        )}
                      </div>
                    </ApprovalCard>
                  )
                })}
              </div>
            )}
            {pending.length === 0 && !approvalsQ.isLoading && approvals.length > 0 && (
              <p className="text-center text-xs text-muted-foreground">All caught up — no pending approvals.</p>
            )}
          </motion.section>
        )}

        {/* ── FRAUD ── */}
        {tab === 'fraud' && (
          <motion.section variants={container.item} className="space-y-3">
            <Card className="overflow-hidden">
              <DataTable
                keyId={(f) => f.id}
                rows={fraud}
                loading={fraudQ.isLoading}
                empty={<EmptyState icon={ShieldAlert} title="No fraud signals" body="Signals land here for review." />}
                columns={[
                  { key: 'kind', header: 'Signal', render: (f: FraudSignal) => <span className="font-semibold">{f.kind.toLowerCase().replace(/_/g, ' ')}</span> },
                  { key: 'severity', header: 'Severity', render: (f: FraudSignal) => <StatusPill status={f.severity} /> },
                  { key: 'status', header: 'Status', render: (f: FraudSignal) => <StatusPill status={f.status} dot /> },
                  { key: 'at', header: 'When', render: (f: FraudSignal) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(f.createdAt)}</span> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (f: FraudSignal) => (
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => setReviewTarget(f)}>
                          <ShieldCheck className="h-3.5 w-3.5" /> Review
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          </motion.section>
        )}

        {/* ── ERASURE ── */}
        {tab === 'erasure' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-warning-soft px-4 py-3 dark:border-amber-500/30">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-warning" />
              <p className="text-[13px] font-medium leading-relaxed text-amber-800 dark:text-amber-200">
                Erasure runs only when the server reports no blockers (legal holds, finance retention). Retrying re-queues a failed workflow.
              </p>
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(e) => e.id}
                rows={erasure}
                loading={erasureQ.isLoading}
                empty={<EmptyState icon={Trash2} title="No erasure requests" body="GDPR erasure requests will appear here." />}
                columns={[
                  { key: 'user', header: 'Customer', render: (e: ErasureRequest) => <span className="font-semibold">{userName(e.userId)}</span> },
                  { key: 'status', header: 'Status', render: (e: ErasureRequest) => <StatusPill status={e.status} dot /> },
                  {
                    key: 'blockers', header: 'Blockers',
                    render: (e: ErasureRequest) => e.blockers.length === 0
                      ? <Badge tone="green">none</Badge>
                      : <div className="flex flex-wrap gap-1">{e.blockers.map((b) => <Badge key={b} tone="amber">{b}</Badge>)}</div>,
                  },
                  { key: 'updated', header: 'Updated', render: (e: ErasureRequest) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(e.updatedAt)}</span> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (e: ErasureRequest) => (
                      <div className="flex justify-end">
                        <Tooltip content={e.blockers.length > 0 ? 'Blocked until the blockers clear' : 'Re-run the erasure workflow'}>
                          <span>
                            <Button size="sm" variant="outline" disabled={e.blockers.length > 0} onClick={() => approvalActions.retryErasure(e.id).mutate(undefined, { onError: () => {} })}>
                              <RefreshCcw className="h-3.5 w-3.5" /> Retry
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

        {/* ── LEGAL HOLDS ── */}
        {tab === 'holds' && (
          <motion.section variants={container.item} className="space-y-3">
            <Card className="overflow-hidden">
              <DataTable
                keyId={(h) => h.id}
                rows={holds}
                loading={holdsQ.isLoading}
                empty={<EmptyState icon={Lock} title="No legal holds" body="Holds block erasure and data deletion for the subject." />}
                columns={[
                  { key: 'user', header: 'Subject', render: (h: LegalHold) => <span className="font-semibold">{userName(h.userId)}</span> },
                  { key: 'reason', header: 'Reason', render: (h: LegalHold) => <span className="block max-w-[280px] truncate text-[13px] text-muted-foreground">{h.reason}</span> },
                  { key: 'status', header: 'Status', render: (h: LegalHold) => <StatusPill status={h.releasedAt ? 'released' : 'active'} dot /> },
                  { key: 'placed', header: 'Placed', render: (h: LegalHold) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(h.createdAt)}</span> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (h: LegalHold) => (
                      <div className="flex justify-end">
                        {!h.releasedAt && (
                          <Button size="sm" variant="outline" onClick={() => setReleaseTarget(h)}>
                            <Unlock className="h-3.5 w-3.5" /> Release
                          </Button>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          </motion.section>
        )}
      </motion.div>

      {/* dialogs */}
      <ReasonDialog
        open={!!rejectTarget}
        onOpenChange={(v) => { if (!v) setRejectTarget(null) }}
        title={`Reject approval ${rejectTarget?.id.slice(0, 8) ?? ''}…`}
        description="The maker can re-request after fixing the issue"
        confirmLabel="Reject approval"
        destructive
        onConfirm={(reason) => { if (rejectTarget) approvalActions.reject(rejectTarget.id, reason).mutate(undefined, { onError: (e) => setMessage(e.message) }) }}
      />
      <ReasonDialog
        open={!!reviewTarget}
        onOpenChange={(v) => { if (!v) setReviewTarget(null) }}
        title={`Review fraud signal ${reviewTarget?.id.slice(0, 8) ?? ''}…`}
        description="Decisions are audit-logged"
        confirmLabel="Submit review"
        onConfirm={(reason) => {
          if (!reviewTarget) return
          approvalActions.setFraudStatus(reviewTarget.id, 'ACKNOWLEDGED', reason).mutate(undefined, { onError: () => {} })
        }}
      />
      <Dialog open={holdDialog} onOpenChange={setHoldDialog}>
        <DialogContent title="Place legal hold" description="Blocks erasure and deletion workflows for the user">
          <div className="space-y-3">
            <Field label="User id (uuid)" required hint="Copy from People">
              <Input value={holdUserId} onChange={(e) => setHoldUserId(e.target.value)} className="font-mono" />
            </Field>
            <Field label="Reason" required>
              <Textarea id="hold-reason" value={undefined} onChange={undefined} placeholder="Why the hold is needed…" />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" size="md" onClick={() => setHoldDialog(false)}>Cancel</Button>
              <Button
                variant="primary" size="md"
                disabled={holdUserId.trim().length < 8}
                onClick={() => {
                  const el = document.getElementById('hold-reason') as HTMLTextAreaElement | null
                  const reason = el?.value?.trim() ?? ''
                  if (reason.length < 3) return
                  approvalActions.placeHold(holdUserId.trim(), reason).mutate(undefined, { onError: (e) => setMessage(e.message), onSuccess: () => { setMessage(null); setHoldDialog(false); setHoldUserId('') } })
                }}
              >
                <Lock className="h-4 w-4" /> Place hold
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <ReasonDialog
        open={!!releaseTarget}
        onOpenChange={(v) => { if (!v) setReleaseTarget(null) }}
        title="Release legal hold"
        description="Erasure and deletion workflows can proceed again"
        confirmLabel="Release hold"
        onConfirm={(reason) => { if (releaseTarget) approvalActions.releaseHold(releaseTarget.id, reason).mutate(undefined, { onError: (e) => setMessage(e.message) }) }}
      />
    </div>
  )
}

export default Approvals
