import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  MoreVertical, PauseCircle, PlayCircle, XCircle, RefreshCcw, Wrench,
  MapPinX, KeyRound, ShoppingCart, Loader, Truck, XCircle as XIcon,
  AlertTriangle, ListFilter, ChevronLeft, ChevronRight, Undo2, ReceiptText,
} from 'lucide-react'
import { useStagger, useDebouncedValue } from '@/hooks/misc'
import { useOrders, useStoreOptions, useFleet, useDashboard } from '@/hooks/queries'
import { useOrderActions } from '@/hooks/mutations'
import { rangeToFromTo } from '@/api/mapping'
import { PageHeader, TabPills, SearchInput, RangeToggle, StatusPill, EmptyState } from '@/components/shared/misc'
import { Select, Field } from '@/components/ui/form'
import { Button, Card, Badge, Textarea, Input } from '@/components/ui/base'
import {
  Drawer, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownItem,
  DropdownSeparator, Tooltip, Dialog, DialogContent,
} from '@/components/ui/overlays'
import { DataTable } from '@/components/shared/DataTable'
import { KpiCard } from '@/components/shared/KpiCard'
import { LazyMap } from '@/components/shared/map/LazyMap'
import type { Order, OrderStatus } from '@/types'
import { fmtDateTime, fmtINR } from '@/lib/utils'

/* ── Local helpers ─────────────────────────────────────────── */
const PAYMENT_LABEL: Record<string, string> = { gateway: 'Prepaid', wallet: 'Wallet', cod: 'COD', zero_due: 'Zero due' }
const STATUS_OPTIONS: Array<{ value: OrderStatus | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'pending_payment', label: 'Pending payment' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'picking', label: 'Picking' },
  { value: 'packed', label: 'Packed' },
  { value: 'out_for_delivery', label: 'Out for delivery' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'expired', label: 'Expired' },
  { value: 'payment_failed', label: 'Payment failed' },
]

export type OrderAction = 'hold' | 'release' | 'cancel' | 'correction' | 'reassign' | 'resolveAddress' | 'resetCode' | 'refund' | 'repair'

/**
 * Action eligibility is derived from SERVER-PROVIDED fields on the order row
 * (status + hold state). Reasons are static where the server gives none.
 */
export function orderActionEligibility(order: Order) {
  const s = order.status
  const terminal = s === 'delivered' || s === 'cancelled' || s === 'expired' || s === 'returned_to_store'
  const inFlight = s === 'confirmed' || s === 'picking' || s === 'packed' || s === 'out_for_delivery' || s === 'pending_payment'
  return {
    hold: {
      enabled: inFlight && !order.onHold,
      reason: order.onHold ? 'Already on hold' : 'Only in-flight orders can be held',
    },
    release: {
      enabled: order.onHold,
      reason: 'Order is not on hold',
    },
    cancel: {
      enabled: inFlight || s === 'payment_failed',
      reason: 'Delivered, cancelled or expired orders cannot be cancelled',
    },
    reassign: {
      enabled: s === 'packed' || s === 'out_for_delivery',
      reason: 'Rider can be reassigned only before delivery',
    },
    resolveAddress: {
      enabled: s === 'confirmed' || s === 'picking' || s === 'packed',
      reason: 'Address fixes apply before dispatch',
    },
    resetCode: {
      enabled: s === 'out_for_delivery' || s === 'packed',
      reason: 'Code locks apply during handover',
    },
    refund: {
      enabled: s === 'delivered' || (s === 'cancelled' && order.paymentMethod !== 'cod'),
      reason: s === 'delivered' ? undefined : 'Cancelled COD orders have no captured payment to refund',
    },
    repair: {
      enabled: s === 'cancelled' || s === 'expired',
      reason: 'Force-state requests apply to cancelled/expired orders only',
    },
  }
}

/* ── Order actions dropdown (eligibility + reason tooltips) ── */
export function OrderActionsMenu({ order, onAction }: { order: Order; onAction: (a: OrderAction) => void }) {
  const el = orderActionEligibility(order)
  const item = (enabled: boolean, reason: string | undefined, label: React.ReactNode, action: OrderAction) => (
    <Tooltip content={enabled ? label : (reason ?? 'Not available for this order')} side="left">
      <span className="block w-full">
        <DropdownItem disabled={!enabled} onSelect={() => onAction(action)}>{label}</DropdownItem>
      </span>
    </Tooltip>
  )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <span onClick={(e) => e.stopPropagation()}>
          <Button size="iconSm" variant="ghost" aria-label={`Actions for order ${order.id}`}><MoreVertical className="h-4 w-4" /></Button>
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {item(el.hold.enabled, el.hold.reason, <><PauseCircle className="h-3.5 w-3.5" /> Put on hold</>, 'hold')}
        {item(el.release.enabled, el.release.reason, <><PlayCircle className="h-3.5 w-3.5" /> Release hold</>, 'release')}
        <DropdownSeparator />
        {item(el.cancel.enabled, el.cancel.reason, <><XCircle className="h-3.5 w-3.5" /> Cancel order</>, 'cancel')}
        <DropdownItem onSelect={() => onAction('correction')}><Wrench className="h-3.5 w-3.5" /> Request correction</DropdownItem>
        {item(el.reassign.enabled, el.reassign.reason, <><RefreshCcw className="h-3.5 w-3.5" /> Reassign rider</>, 'reassign')}
        {item(el.refund.enabled, el.refund.reason, <><Undo2 className="h-3.5 w-3.5" /> Request refund</>, 'refund')}
        {item(el.repair.enabled, el.repair.reason, <><Wrench className="h-3.5 w-3.5" /> Request repair (cancel/expire)</>, 'repair')}
        <DropdownSeparator />
        {item(el.resolveAddress.enabled, el.resolveAddress.reason, <><MapPinX className="h-3.5 w-3.5" /> Resolve wrong-address</>, 'resolveAddress')}
        {item(el.resetCode.enabled, el.resetCode.reason, <><KeyRound className="h-3.5 w-3.5" /> Reset code lock</>, 'resetCode')}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* ── Action dialogs ────────────────────────────────────────── */
function OrderActionDialogs({ open, onClose }: { open: { action: OrderAction; order: Order } | null; onClose: () => void }) {
  const actions = useOrderActions()
  const [reason, setReason] = useState('')
  const [kind, setKind] = useState('address')
  const [riderId, setRiderId] = useState('')
  const [amount, setAmount] = useState('')

  useEffect(() => {
    setReason('')
    setKind('address')
    setRiderId('')
    setAmount('')
  }, [open?.order.id, open?.action])

  if (!open) return null
  const { action, order } = open
  const reasonInvalid = reason.trim().length < 5
  const amountNum = Number(amount)
  const amountInvalid = !Number.isFinite(amountNum) || amountNum <= 0 || amountNum > order.total

  const close = () => onClose()

  if (action === 'release') return null
  if (action === 'resolveAddress') {
    return (
      <Dialog open onOpenChange={(v) => { if (!v) close() }}>
        <DialogContent title={`Resolve wrong-address for ${order.orderNumber}`} description="Confirms the corrected address with dispatch so delivery can resume.">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!reasonInvalid) { actions.resolveAddress(order.id, reason.trim()); close() } }}>
            <Field label="Resolution note" required error={reason && reasonInvalid ? 'Reason must be at least 5 characters' : undefined}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer re-confirmed the gate code" />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" size="md" onClick={close}>Cancel</Button>
              <Button type="submit" variant="primary" size="md" disabled={reasonInvalid}>Resolve</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    )
  }
  if (action === 'resetCode') {
    return (
      <Dialog open onOpenChange={(v) => { if (!v) close() }}>
        <DialogContent title={`Reset code lock for ${order.orderNumber}`} description="Unlocks delivery-code retries so the rider can complete handover. No code is displayed here.">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!reasonInvalid) { actions.resetCode(order.id, reason.trim()); close() } }}>
            <Field label="Reason" required error={reason && reasonInvalid ? 'Reason must be at least 5 characters' : undefined}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer reports repeated failed attempts" />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" size="md" onClick={close}>Cancel</Button>
              <Button type="submit" variant="primary" size="md" disabled={reasonInvalid}>Reset lock</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    )
  }
  if (action === 'refund') {
    return (
      <Dialog open onOpenChange={(v) => { if (!v) close() }}>
        <DialogContent title={`Request refund for ${order.orderNumber}`} description={`Up to ${fmtINR(order.total)} — sent for approval per policy`}>
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!amountInvalid && !reasonInvalid) { actions.requestRefund(order.id, amountNum, reason.trim()); close() } }}>
            <Field label="Amount (₹)" required error={amount && amountInvalid ? `Enter a valid amount up to ${fmtINR(order.total)}` : undefined}>
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} max={order.total} min={1} />
            </Field>
            <Field label="Reason" required error={reason && reasonInvalid ? 'Reason must be at least 5 characters' : undefined}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Missing item reported via ticket" />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" size="md" onClick={close}>Cancel</Button>
              <Button type="submit" variant="primary" size="md" disabled={amountInvalid || reasonInvalid}>Request refund</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    )
  }
  if (action === 'repair') {
    return (
      <Dialog open onOpenChange={(v) => { if (!v) close() }}>
        <DialogContent title={`Request repair for ${order.orderNumber}`} description="Repairs only move cancelled/expired orders (e.g. re-cancel after a webhook race) — maker-checker applies.">
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (!reasonInvalid) { actions.requestRepair(order.id, order.status === 'expired' ? 'EXPIRED' : 'CANCELLED', reason.trim()); close() } }}>
            <Field label="Reason" required error={reason && reasonInvalid ? 'Reason must be at least 5 characters' : undefined}>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Duplicate cancellation webhook reversed state" />
            </Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" size="md" onClick={close}>Cancel</Button>
              <Button type="submit" variant="primary" size="md" disabled={reasonInvalid}>Submit repair request</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) close() }}>
      <DialogContent
        title={
          action === 'hold' ? `Put ${order.orderNumber} on hold`
          : action === 'cancel' ? `Cancel ${order.orderNumber}`
          : action === 'correction' ? `Request correction for ${order.orderNumber}`
          : `Reassign rider for ${order.orderNumber}`
        }
        description={
          action === 'hold' ? 'Held orders pause picking and keep the delivery code locked.'
          : action === 'cancel' ? 'Cancelling is final — the customer is notified and refunds flow per policy.'
          : action === 'correction' ? 'The store is notified to correct the order before dispatch.'
          : 'Pick an eligible rider — the server revalidates on submit.'
        }
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (action === 'hold' && !reasonInvalid) { actions.hold(order.id, reason.trim()); close() }
            if (action === 'cancel' && !reasonInvalid) { actions.cancel(order.id, reason.trim()); close() }
            if (action === 'correction' && !reasonInvalid) { close() }
            if (action === 'reassign' && riderId && !reasonInvalid) { actions.reassign(order.id, riderId, reason.trim()); close() }
          }}
        >
          {action === 'correction' && (
            <Field label="What needs correcting?" required>
              <Select value={kind} onValueChange={setKind} options={[
                { value: 'address', label: 'Delivery address' },
                { value: 'items', label: 'Items / quantities' },
                { value: 'slot', label: 'Delivery slot' },
              ]} />
            </Field>
          )}

          {action === 'reassign' && (
            <RiderCandidatePicker orderId={order.id} value={riderId} onChange={setRiderId} />
          )}

          {action !== 'correction' && (
            <Field label="Reason" required error={reason && reasonInvalid ? 'Reason must be at least 5 characters' : undefined} hint="Stored on the order and shown to the ops team">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={action === 'cancel' ? 'e.g. Customer double-ordered' : 'e.g. Waiting for payment retry confirmation'} />
            </Field>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="md" onClick={close}>Cancel</Button>
            <Button
              type="submit"
              variant={action === 'cancel' ? 'destructive' : 'primary'}
              size="md"
              disabled={action === 'reassign' ? !riderId || reasonInvalid : reasonInvalid}
            >
              {action === 'hold' ? 'Put on hold' : action === 'cancel' ? 'Cancel order' : action === 'correction' ? 'Send request' : 'Reassign'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Rider picker fed by the server candidates endpoint (eligibility from server). */
function RiderCandidatePicker({ orderId, value, onChange }: { orderId: string; value: string; onChange: (v: string) => void }) {
  const [candidates, setCandidates] = useState<Array<{ riderId: string; name: string; eligible: boolean; reason: string | null }>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    import('@/api/orders').then(({ riderCandidates }) =>
      riderCandidates(orderId)
        .then((items) => { if (alive) setCandidates(items) })
        .catch((e) => { if (alive) setError(e instanceof Error ? e.message : 'Could not load rider candidates') })
        .finally(() => { if (alive) setLoading(false) }),
    )
    return () => { alive = false }
  }, [orderId])

  const eligible = candidates.filter((c) => c.eligible)
  if (loading) return <p className="rounded-xl border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">Loading eligible riders…</p>
  if (error) return <p className="rounded-xl bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{error}</p>
  return (
    <Field label="New rider" required hint={eligible.length === 0 ? 'No eligible riders right now' : undefined}>
      <Select value={value} onValueChange={onChange} placeholder="Pick rider…" options={candidates.map((c) => ({ value: c.riderId, label: c.eligible ? c.name : `${c.name} — ${c.reason ?? 'not eligible'}`, disabled: !c.eligible }))} />
    </Field>
  )
}

/* ── Row summary drawer ────────────────────────────────────── */
function OrderDrawer({ order, storeName, onClose }: { order: Order; storeName: string; onClose: () => void }) {
  const navigate = useNavigate()
  return (
    <Drawer open onOpenChange={(v) => { if (!v) onClose() }} width="md" title={`Order ${order.orderNumber}`} subtitle={fmtDateTime(order.placedAt)}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill status={order.status} dot />
          <Badge tone={order.paymentMethod === 'cod' ? 'amber' : 'blue'}>{PAYMENT_LABEL[order.paymentMethod ?? ''] ?? '—'}</Badge>
          {order.onHold && <Badge tone="amber"><AlertTriangle className="h-3 w-3" /> On hold</Badge>}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl border border-border/70 bg-muted/30 p-4 text-[13px]">
          <div className="flex gap-2"><dt className="font-semibold text-muted-foreground">Customer:</dt><dd className="min-w-0 flex-1 truncate font-medium">{shortId(order.userId)}</dd></div>
          <div className="flex gap-2"><dt className="font-semibold text-muted-foreground">Amount:</dt><dd className="font-bold">{fmtINR(order.total)}</dd></div>
          <div className="flex gap-2"><dt className="font-semibold text-muted-foreground">Store:</dt><dd className="min-w-0 flex-1 truncate font-medium">{storeName}</dd></div>
          <div className="flex gap-2"><dt className="font-semibold text-muted-foreground">Items:</dt><dd className="font-medium">{order.items.length}</dd></div>
          <div className="flex gap-2"><dt className="font-semibold text-muted-foreground">Payment:</dt><dd className="font-medium">{order.paymentStatus}</dd></div>
          <div className="flex gap-2"><dt className="font-semibold text-muted-foreground">Delivery code:</dt><dd className="font-medium text-muted-foreground">Shown to rider app</dd></div>
        </dl>
        <Button variant="primary" size="md" className="w-full" onClick={() => { onClose(); navigate(`/orders/${order.id}`) }}>
          <ReceiptText className="h-4 w-4" /> View full order
        </Button>
      </div>
    </Drawer>
  )
}

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

/* ── Live fleet map (REAL data — GET /v1/admin/delivery/fleet) ── */
function LiveFleetMap() {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const fleetQ = useFleet(visible)
  const storesQ = useStoreOptions()

  const riders = fleetQ.data?.items ?? []
  const stores = storesQ.data ?? []
  const stale = riders.filter((r) => !r.fresh).length

  const markers = riders
    .filter((r) => r.lastLocation && r.fresh)
    .map((r) => ({
      coords: [r.lastLocation!.lat, r.lastLocation!.lng] as [number, number],
      color: r.availability === 'AVAILABLE' ? '#2E7D1A' : r.availability === 'ON_DELIVERY' ? '#3B82F6' : '#9CA3AF',
      label: `${r.name} · ${r.availability.toLowerCase().replace('_', ' ')} · updated ${fmtDateTime(r.lastUpdateAt)}`,
    }))

  const center: [number, number] = markers[0]?.coords ?? (stores[0] ? [stores[0].lat, stores[0].lng] : [19.076, 72.8777])

  return (
    <Card className="overflow-hidden p-0">
      <div className="h-[480px] w-full">
        <LazyMap center={center} zoom={11} showZoom scrollWheelZoom markers={markers} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-brand-600" /> Available</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#3B82F6]" /> On delivery</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#9CA3AF]" /> Offline / stale (omitted)</span>
        <span>{riders.length} riders · {stale} stale · polls every 15s</span>
      </div>
    </Card>
  )
}

/* ── Page ──────────────────────────────────────────────────── */
const PAGE_SIZE = 12

export function Orders() {
  const container = useStagger()
  const [view, setView] = useState<'list' | 'map'>('list')

  const [storeId, setStoreId] = useState('all')
  const [status, setStatus] = useState<OrderStatus | 'all'>('all')
  const [range, setRange] = useState('7d')
  // cursor stack: NEXT pushes the next cursor, PREV pops
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null])

  const { from } = rangeToFromTo(range as 'today' | '7d' | '30d' | '90d')
  const ordersQ = useOrders({
    storeId: storeId === 'all' ? undefined : storeId,
    status: status === 'all' ? undefined : status,
    placedAfter: range === '90d' ? undefined : from,
    limit: PAGE_SIZE,
    cursor: cursor ?? undefined,
  })
  const dashQ = useDashboard(range as 'today' | '7d' | '30d' | '90d', storeId)
  const storeOptions = useStoreOptions()

  const rows = ordersQ.data?.items ?? []
  const nextCursor = ordersQ.data?.nextCursor ?? null

  // reset cursor stack when filters change
  useEffect(() => {
    setCursor(null)
    setCursorStack([null])
  }, [storeId, status, range])

  const goNext = () => {
    if (!nextCursor) return
    setCursorStack((st) => [...st, nextCursor])
    setCursor(nextCursor)
  }
  const goPrev = () => {
    setCursorStack((st) => {
      if (st.length <= 1) return st
      const next = st.slice(0, -1)
      setCursor(next[next.length - 1] ?? null)
      return next
    })
  }

  const [dialog, setDialog] = useState<{ action: OrderAction; order: Order } | null>(null)
  const [drawerRow, setDrawerRow] = useState<string | null>(null)
  const rowActions = useOrderActions()

  const drawerRowData = rows.find((r) => r.id === drawerRow)

  const dash = dashQ.data
  const dashOrders = dash?.orders
  const inProgress = (dashOrders?.confirmed ?? 0) + (dashOrders?.picking ?? 0) + (dashOrders?.packed ?? 0)

  const storeName = (id: string) => storeOptions.data?.find((s) => s.id === id)?.name ?? '—'

  const statusTabs = useMemo(() => STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label })), [])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Orders &"
        titleAccent="delivery"
        subtitle="Every order across the network with full dispatch controls and a live fleet view."
        artwork="orders"
        breadcrumb={['Orders']}
        actions={(
          <TabPills
            id="orders-view"
            value={view}
            onChange={(v) => setView(v as 'list' | 'map')}
            tabs={[{ value: 'list', label: 'Order list' }, { value: 'map', label: 'Live map' }]}
          />
        )}
      />

      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-4">
        {view === 'list' ? (
          <>
            {/* KPI row */}
            <motion.section variants={container.item} className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
              <KpiCard label="Placed" value={dashOrders?.placed ?? 0} icon={ShoppingCart} tint="violet" />
              <KpiCard label="In progress" value={inProgress} icon={Loader} tint="blue" />
              <KpiCard label="Out for delivery" value={dashOrders?.outForDelivery ?? 0} icon={Truck} tint="green" />
              <KpiCard label="Cancelled / expired" value={(dashOrders?.cancelled ?? 0) + (dashOrders?.expired ?? 0)} icon={XIcon} tint="red" />
              <KpiCard label="On hold" value={dashOrders?.onHold ?? 0} icon={AlertTriangle} tint="amber" highlight={(dashOrders?.onHold ?? 0) > 0} />
            </motion.section>

            {/* toolbar */}
            <motion.section variants={container.item} className="flex flex-wrap items-center gap-2.5">
              <div className="w-44">
                <Select value={storeId} onValueChange={setStoreId} options={[{ value: 'all', label: 'All stores' }, ...(storeOptions.data ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
              </div>
              <RangeToggle value={range} onChange={setRange} options={['today', '7d', '30d', '90d']} id="orders-range" />
            </motion.section>

            <motion.section variants={container.item}>
              <TabPills id="orders-status" value={status} onChange={(v) => setStatus(v as OrderStatus | 'all')} tabs={statusTabs} className="pb-1" />
            </motion.section>

            {/* table */}
            <motion.section variants={container.item}>
              <Card className="overflow-hidden">
                <DataTable
                  keyId={(r) => r.id}
                  rows={rows}
                  loading={ordersQ.isLoading}
                  onRowClick={(r) => setDrawerRow(r.id)}
                  empty={<EmptyState icon={ListFilter} title="No orders match" body="Adjust the store, status or date range." />}
                  columns={[
                    {
                      key: 'id', header: 'Order',
                      render: (r) => (
                        <span onClick={(e) => e.stopPropagation()}>
                          <Link to={`/orders/${r.id}`} className="font-mono text-[13px] font-bold text-brand-700 hover:underline dark:text-brand-300">#{r.orderNumber}</Link>
                        </span>
                      ),
                    },
                    { key: 'customer', header: 'Customer', render: (r) => <span className="text-[13px] text-muted-foreground">{shortId(r.userId)}</span> },
                    { key: 'store', header: 'Store', render: (r) => <span className="text-[13px]">{storeName(r.storeId)}</span> },
                    { key: 'amount', header: 'Amount', render: (r) => <span className="font-bold tabular">{fmtINR(r.total)}</span> },
                    {
                      key: 'payment', header: 'Payment',
                      render: (r) => <Badge tone={r.paymentMethod === 'cod' ? 'amber' : 'blue'}>{PAYMENT_LABEL[r.paymentMethod ?? ''] ?? '—'}</Badge>,
                    },
                    { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} dot /> },
                    {
                      key: 'hold', header: 'Attention',
                      render: (r) => r.onHold
                        ? <Badge tone="amber"><AlertTriangle className="h-3 w-3" /> On hold</Badge>
                        : r.status === 'payment_failed'
                          ? <Badge tone="red"><AlertTriangle className="h-3 w-3" /> Payment failed</Badge>
                          : <span className="text-muted-foreground">—</span>,
                    },
                    {
                      key: 'actions', header: '', align: 'right' as const,
                      render: (r) => (
                        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                          <OrderActionsMenu
                            order={r}
                            onAction={(a) => {
                              if (a === 'release') rowActions.release(r.id)
                              else setDialog({ action: a, order: r })
                            }}
                          />
                        </div>
                      ),
                    },
                  ]}
                />
                {/* cursor pagination — NEXT/PREV only, no fake total */}
                <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
                  <span className="text-xs text-muted-foreground">Showing page {cursorStack.length} of the cursor feed{rows.length ? ` · ${rows.length} rows` : ''}</span>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" disabled={cursorStack.length <= 1 || ordersQ.isLoading} onClick={goPrev}>
                      <ChevronLeft className="h-3.5 w-3.5" /> Prev
                    </Button>
                    <Button size="sm" variant="outline" disabled={!nextCursor || ordersQ.isLoading} onClick={goNext}>
                      Next <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </Card>
            </motion.section>
          </>
        ) : (
          <motion.section variants={container.item}>
            <LiveFleetMap />
          </motion.section>
        )}
      </motion.div>

      {/* row drawer + action dialogs */}
      {drawerRowData && (
        <OrderDrawer order={drawerRowData} storeName={storeName(drawerRowData.storeId)} onClose={() => setDrawerRow(null)} />
      )}
      <OrderActionDialogs open={dialog} onClose={() => setDialog(null)} />
    </div>
  )
}

export default Orders

// re-exported for the detail page's shared action dialog wiring
export { OrderActionDialogs }
