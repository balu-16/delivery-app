import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  ArrowLeft, PauseCircle, PlayCircle, XCircle, Wrench, RefreshCcw, MapPinX,
  KeyRound, Receipt, Clock, Undo2, PackageSearch, FileDown,
  AlertTriangle, CheckCircle2,
} from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import { useOrderDetail, useOrderTimeline, useOrderPayments } from '@/hooks/queries'
import { useOrderActions } from '@/hooks/mutations'
import { orderActionEligibility, OrderActionDialogs, type OrderAction } from './Orders'
import { getOrderInvoice } from '@/api/orders'
import { ApiError } from '@/api/http'
import { PageHeader, StatusPill, EmptyState } from '@/components/shared/misc'
import { Field } from '@/components/ui/form'
import { Button, Card, Badge, Input, Textarea } from '@/components/ui/base'
import { Dialog, DialogContent, Tooltip } from '@/components/ui/overlays'
import { SectionCard, StatusTimeline } from '@/components/shared/domain'
import type { Order } from '@/types'
import { cn, fmtDateTime, fmtINR, fmtNum } from '@/lib/utils'

/* ── Local helpers ─────────────────────────────────────────── */
const PAYMENT_LABEL: Record<string, string> = { gateway: 'Prepaid', wallet: 'Wallet', cod: 'COD', zero_due: 'Zero due' }

/** Header action button with eligibility + reason tooltip. */
function ActionButton({ enabled, reason, label, icon: Icon, tone, onClick }: {
  enabled: boolean
  reason?: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  tone?: 'destructive'
  onClick: () => void
}) {
  return (
    <Tooltip content={enabled ? label : (reason ?? 'Not available for this order')}>
      <span>
        <Button size="sm" variant={tone ?? 'secondary'} disabled={!enabled} onClick={onClick}>
          <Icon className="h-3.5 w-3.5" /> {label}
        </Button>
      </span>
    </Tooltip>
  )
}

export function OrderDetail() {
  const container = useStagger()
  const { id } = useParams<{ id: string }>()
  const orderActions = useOrderActions()
  const detailQ = useOrderDetail(id ?? null)
  const timelineQ = useOrderTimeline(id ?? null)
  const paymentsQ = useOrderPayments(id ?? null)

  const data = detailQ.data
  const order = data ?? null

  const [dialog, setDialog] = useState<{ action: OrderAction; order: Order } | null>(null)
  const [refundOpen, setRefundOpen] = useState(false)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const [refundError, setRefundError] = useState('')
  const [invoice, setInvoice] = useState<{ state: 'loading' | 'error'; message?: string } | null>(null)

  if (detailQ.isLoading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="skeleton h-40 rounded-card" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="skeleton h-72 rounded-card lg:col-span-8" />
          <div className="skeleton h-72 rounded-card lg:col-span-4" />
        </div>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="space-y-5">
        <PageHeader title="Order" titleAccent="not found" subtitle="We could not find this order." breadcrumb={['Orders', id ?? '']} />
        <Card>
          <EmptyState icon={PackageSearch} title={`No order “${id}”`} body="It may have been removed or the link is stale." action={(
            <Link to="/orders"><Button variant="secondary" size="md"><ArrowLeft className="h-4 w-4" /> Back to orders</Button></Link>
          )} />
        </Card>
      </div>
    )
  }

  const el = orderActionEligibility(order)
  // refunds booked against this order come from the payments endpoint
  const refunds = paymentsQ.data?.refunds ?? []
  const alreadyRefunded = refunds.reduce((a, r) => a + (r.status !== 'failed' ? r.amount : 0), 0)
  const refundRemaining = Math.max(0, order.total - alreadyRefunded)
  const refundElig = {
    eligible: el.refund.enabled && refundRemaining > 0,
    reason: el.refund.reason ?? 'Nothing left to refund on this order',
  }

  const direct = (a: 'release' | 'resetCode') => {
    if (a === 'release') orderActions.release(order.id)
    if (a === 'resetCode') orderActions.resetCode(order.id, `Code lock reset from order view at ${new Date().toISOString()}`)
  }

  const submitRefund = () => {
    const amt = Number(refundAmount)
    if (!Number.isFinite(amt) || amt <= 0) { setRefundError('Enter a valid amount'); return }
    if (amt > refundRemaining) { setRefundError(`Amount cannot exceed the un-refunded balance (${fmtINR(refundRemaining)})`); return }
    if (refundReason.trim().length < 3) { setRefundError('Give a short reason for the refund'); return }
    orderActions.requestRefund(order.id, amt, refundReason.trim())
    setRefundOpen(false)
  }

  const openInvoice = async () => {
    setInvoice({ state: 'loading' })
    try {
      const info = await getOrderInvoice(order.id)
      window.open(info.url, '_blank', 'noopener,noreferrer')
      setInvoice(null)
    } catch (err) {
      const message = err instanceof ApiError
        ? (err.code === 'INVOICE_NOT_FOUND' ? 'No invoice exists yet for this order.' : err.code === 'INVOICE_NOT_RENDERED' ? 'The invoice is still being rendered — try again shortly.' : err.message)
        : 'Could not fetch the invoice link.'
      setInvoice({ state: 'error', message })
    }
  }

  const timelineSteps = (timelineQ.data ?? []).map((t) => ({
    label: `${t.state.toLowerCase().replace(/_/g, ' ')} — ${t.action}`,
    at: t.at,
    note: t.reason ?? undefined,
  }))

  const deliveryFee = order.fees.filter((f) => f.kind === 'DELIVERY').reduce((a, f) => a + f.amount, 0)
  const otherFees = order.fees.filter((f) => f.kind !== 'DELIVERY').reduce((a, f) => a + f.amount, 0)

  return (
    <div className="space-y-5">
      <PageHeader
        title={`Order ${order.orderNumber}`}
        subtitle={`Placed ${fmtDateTime(order.placedAt)} · store ${order.storeId.slice(0, 8)}…`}
        artwork="orders"
        breadcrumb={['Orders', order.orderNumber]}
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton enabled={el.hold.enabled} reason={el.hold.reason} label="Put on hold" icon={PauseCircle} onClick={() => setDialog({ action: 'hold', order })} />
            <ActionButton enabled={el.release.enabled} reason={el.release.reason} label="Release hold" icon={PlayCircle} onClick={() => direct('release')} />
            <ActionButton enabled={el.cancel.enabled} reason={el.cancel.reason} label="Cancel order" icon={XCircle} tone="destructive" onClick={() => setDialog({ action: 'cancel', order })} />
            <ActionButton enabled={el.reassign.enabled} reason={el.reassign.reason} label="Reassign rider" icon={RefreshCcw} onClick={() => setDialog({ action: 'reassign', order })} />
            <ActionButton enabled={el.resolveAddress.enabled} reason={el.resolveAddress.reason} label="Resolve wrong-address" icon={MapPinX} onClick={() => setDialog({ action: 'resolveAddress', order })} />
            <ActionButton enabled={el.resetCode.enabled} reason={el.resetCode.reason} label="Reset code lock" icon={KeyRound} onClick={() => setDialog({ action: 'resetCode', order })} />
            <ActionButton enabled={el.repair.enabled} reason={el.repair.reason} label="Request repair" icon={Wrench} onClick={() => setDialog({ action: 'repair', order })} />
            <Button size="sm" variant="outline" onClick={() => void openInvoice()}>
              <FileDown className="h-3.5 w-3.5" /> {invoice?.state === 'loading' ? 'Fetching…' : 'Invoice'}
            </Button>
          </div>
        )}
      />

      <Link to="/orders" className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand-700 hover:underline dark:text-brand-300">
        <ArrowLeft className="h-3.5 w-3.5" /> Back to all orders
      </Link>

      {invoice?.state === 'error' && (
        <Card className="border-destructive/40 bg-destructive-soft/60 p-4 text-[13px] font-semibold text-destructive">{invoice.message}</Card>
      )}

      {/* header status card */}
      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-4">
        <motion.section variants={container.item}>
          <Card className="flex flex-wrap items-center gap-3 p-5">
            <StatusPill status={order.status} dot />
            <Badge tone={order.paymentMethod === 'cod' ? 'amber' : 'blue'}>{PAYMENT_LABEL[order.paymentMethod ?? ''] ?? '—'}</Badge>
            <Badge tone="neutral">{order.paymentStatus.replace(/_/g, ' ')}</Badge>
            {order.onHold && (
              <Badge tone="amber"><AlertTriangle className="h-3 w-3" /> On hold{order.hold.reason ? ` — ${order.hold.reason}` : ''}</Badge>
            )}
            {order.cancelReason && <Badge tone="red">Cancelled: {order.cancelReason}</Badge>}
            <span className="ml-auto text-[13px] font-medium text-muted-foreground"><Clock className="mr-1 inline h-3.5 w-3.5" />{fmtDateTime(order.placedAt)}</span>
          </Card>
        </motion.section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* ── col-8 ── */}
          <div className="space-y-4 lg:col-span-8">
            {/* items */}
            <motion.section variants={container.item}>
              <SectionCard title="Items" subtitle={`${order.items.length} line item${order.items.length === 1 ? '' : 's'}`}>
                <div className="overflow-hidden rounded-xl border border-border/70">
                  <table className="w-full text-left text-[13px]">
                    <thead>
                      <tr className="bg-muted/40 text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
                        <th className="px-3 py-2">Item</th>
                        <th className="px-3 py-2 text-right">Qty</th>
                        <th className="px-3 py-2 text-right">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {order.items.map((it) => (
                        <tr key={it.id} className="border-t border-border/60">
                          <td className="px-3 py-2 font-medium">{it.name}</td>
                          <td className="px-3 py-2 text-right tabular">×{fmtNum(it.qty)}</td>
                          <td className="px-3 py-2 text-right font-bold tabular">{fmtINR(it.unitPrice)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 space-y-1 text-[13px]">
                  <p className="flex justify-between text-muted-foreground"><span>Subtotal</span><span className="tabular">{fmtINR(order.subtotal)}</span></p>
                  <p className="flex justify-between text-muted-foreground"><span>Delivery fee</span><span className="tabular">{fmtINR(deliveryFee)}</span></p>
                  {otherFees > 0 && <p className="flex justify-between text-muted-foreground"><span>Other fees</span><span className="tabular">{fmtINR(otherFees)}</span></p>}
                  {order.discount > 0 && <p className="flex justify-between text-success"><span>Discount</span><span className="tabular">−{fmtINR(order.discount)}</span></p>}
                  <p className="flex justify-between text-muted-foreground"><span>Tax</span><span className="tabular">{fmtINR(order.taxTotal)}</span></p>
                  <p className="flex justify-between border-t border-border pt-1.5 text-[14px] font-extrabold"><span>Total</span><span className="tabular">{fmtINR(order.total)}</span></p>
                </div>
              </SectionCard>
            </motion.section>

            {/* timeline */}
            <motion.section variants={container.item}>
              <SectionCard title="Timeline" subtitle="Status history recorded by the platform">
                {timelineSteps.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No timeline entries yet</p>
                ) : (
                  <StatusTimeline steps={timelineSteps} />
                )}
              </SectionCard>
            </motion.section>
          </div>

          {/* ── col-4 ── */}
          <div className="space-y-4 lg:col-span-4">
            {/* customer */}
            <motion.section variants={container.item}>
              <SectionCard title="Customer">
                <p className="text-[13px] text-muted-foreground">Customer id</p>
                <p className="font-mono text-[12.5px] font-bold">{order.userId}</p>
                <p className="mt-2 text-xs text-muted-foreground">Contact details stay in the customer app; the admin portal shows identifiers only.</p>
              </SectionCard>
            </motion.section>

            {/* delivery */}
            <motion.section variants={container.item}>
              <SectionCard title="Delivery">
                <p className="text-[13px] text-muted-foreground">Rider assignment is managed by dispatch. Reassignment is available while the order is packed or out for delivery.</p>
                <div className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-border/70 bg-muted/30 px-3 py-2.5">
                  <div>
                    <p className="text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">Delivery code</p>
                    <p className="text-[13px] font-semibold text-muted-foreground">Never displayed in the admin portal</p>
                  </div>
                  <Tooltip content={el.resetCode.enabled ? 'Unlock the code so the rider can retry handover' : el.resetCode.reason ?? 'Code reset not available'}>
                    <span>
                      <Button size="sm" variant="outline" disabled={!el.resetCode.enabled} onClick={() => direct('resetCode')}>Reset lock</Button>
                    </span>
                  </Tooltip>
                </div>
              </SectionCard>
            </motion.section>

            {/* payment attempts */}
            <motion.section variants={container.item}>
              <SectionCard title="Payment attempts" subtitle="Gateway + wallet funding records">
                {(paymentsQ.data?.attempts ?? []).length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No payment attempts recorded</p>
                ) : (
                  <div className="space-y-1.5">
                    {(paymentsQ.data?.attempts ?? []).map((a) => (
                      <div key={a.attemptId} className="rounded-xl border border-border/70 px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="text-[12.5px] font-bold">{a.kind.toLowerCase().replace(/_/g, ' ')}</span>
                          <span className="text-[13px] font-bold tabular">{fmtINR(a.amount)}</span>
                          <span className="ml-auto"><StatusPill status={a.status} /></span>
                        </div>
                        <p className={cn('mt-1 text-[11px]', a.status === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
                          {a.gatewayPaymentId ? `gateway ref ${a.gatewayPaymentId.slice(0, 12)}…` : 'no gateway ref'}
                        </p>
                        <p className="text-[11px] text-muted-foreground">{fmtDateTime(a.createdAt)}</p>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </motion.section>

            {/* refunds */}
            <motion.section variants={container.item}>
              <SectionCard
                title="Refunds"
                subtitle={`${fmtINR(alreadyRefunded)} refunded · ${fmtINR(refundRemaining)} remaining`}
                action={(
                  <Tooltip content={refundElig.eligible ? 'File a refund against this order' : (refundElig.reason ?? 'Refund not eligible')}>
                    <span>
                      <Button size="sm" variant="primary" disabled={!refundElig.eligible} onClick={() => { setRefundAmount(String(refundRemaining)); setRefundError(''); setRefundOpen(true) }}>
                        <Undo2 className="h-3.5 w-3.5" /> Request refund
                      </Button>
                    </span>
                  </Tooltip>
                )}
              >
                {refunds.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No refunds on this order</p>
                ) : (
                  <div className="space-y-1.5">
                    {refunds.map((r) => (
                      <div key={r.refundId} className="rounded-xl border border-border/70 px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <StatusPill status={r.status} />
                          <span className="text-[13.5px] font-extrabold tabular">{fmtINR(r.amount)}</span>
                          <span className="ml-auto text-[11px] text-muted-foreground">via {r.destination.toLowerCase().replace(/_/g, ' ')}</span>
                        </div>
                        <p className="mt-1 text-[11.5px] text-muted-foreground">{r.reason ?? 'No reason recorded'} · ref {r.refundReference.slice(0, 12)}…</p>
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </motion.section>

            {/* approvals */}
            <motion.section variants={container.item}>
              <SectionCard title="Approvals" subtitle="Refund & repair requests go through maker-checker">
                <p className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                  When a refund or repair request needs a second admin, it appears under Approvals until executed.
                </p>
              </SectionCard>
            </motion.section>
          </div>
        </div>
      </motion.div>

      {/* shared action dialogs (hold/cancel/reassign/resolveAddress/resetCode/refund/repair) */}
      <OrderActionDialogs open={dialog} onClose={() => setDialog(null)} />

      {/* refund dialog */}
      <Dialog open={refundOpen} onOpenChange={setRefundOpen}>
        <DialogContent title={`Request refund for ${order.orderNumber}`} description={`Up to ${fmtINR(refundRemaining)} (un-refunded balance)`}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); submitRefund() }}>
            <Field label="Amount (₹)" required error={refundError}>
              <Input type="number" value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} max={refundRemaining} />
            </Field>
            <Field label="Reason" required hint="Logged on the refund and visible to support">
              <Textarea value={refundReason} onChange={(e) => setRefundReason(e.target.value)} placeholder="e.g. Missing item reported via ticket" />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" size="md" onClick={() => setRefundOpen(false)}>Cancel</Button>
              <Button type="submit" variant="primary" size="md"><Receipt className="h-4 w-4" /> Request refund</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* repair requests flow through the shared OrderActionDialogs above */}
    </div>
  )
}

export default OrderDetail
