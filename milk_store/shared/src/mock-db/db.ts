import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { buildSeedData, DEMO_NOW } from './seed'
import type {
  DB, Store, Zone, LegalEntity, Product, Variant, VariantAvailability, WorkforceAccount,
  Rider, Order, Refund, WalletLedgerEntry, Payout, Coupon, PushCampaign, AdminNotification,
  Approval, ExportJob, TicketMessage, SystemSettings, ErasureRequest, LegalHold,
  InvoiceFailure, BackgroundJob, StockLevel, PickingTask, RiderApplication, ReturnParcel, CodDeposit, StockReceipt,
  StockCount, StockAdjustment, StoreStatusChange, StoreNotification, StoreNotificationPrefs,
} from '../types'

// Journal-based persistence: the dataset is rebuilt from the deterministic seed on
// every load, then persisted mutations (journal ops) are replayed on top.
export type JournalOp =
  | { t: 'store.add'; store: Store }
  | { t: 'store.update'; id: string; patch: Partial<Store> }
  | { t: 'store.delete'; id: string }
  | { t: 'zone.add'; zone: Zone }
  | { t: 'zone.update'; id: string; patch: Partial<Zone> }
  | { t: 'zone.delete'; id: string }
  | { t: 'entity.add'; entity: LegalEntity }
  | { t: 'entity.update'; id: string; patch: Partial<LegalEntity> }
  | { t: 'entity.delete'; id: string }
  | { t: 'product.add'; product: Product; variants: Variant[] }
  | { t: 'product.update'; id: string; patch: Partial<Product> }
  | { t: 'product.delete'; id: string }
  | { t: 'variant.update'; id: string; patch: Partial<Variant> }
  | { t: 'variant.add'; variant: Variant }
  | { t: 'storeVariant.update'; variantId: string; storeId: string; patch: Partial<VariantAvailability> }
  | { t: 'stock.update'; storeId: string; variantId: string; patch: Partial<StockLevel> }
  | { t: 'order.hold'; id: string; reason: string; at: string }
  | { t: 'order.release'; id: string; at: string }
  | { t: 'order.cancel'; id: string; reason: string; at: string }
  | { t: 'order.correction'; id: string; kind: string; reason: string; by: string; at: string }
  | { t: 'order.reassign'; id: string; riderId: string; at: string }
  | { t: 'order.resolveAddress'; id: string; at: string }
  | { t: 'order.resetCode'; id: string; at: string }
  | { t: 'customer.block'; id: string; reason: string }
  | { t: 'customer.unblock'; id: string }
  | { t: 'workforce.add'; member: WorkforceAccount }
  | { t: 'workforce.update'; id: string; patch: Partial<WorkforceAccount> }
  | { t: 'rider.update'; id: string; patch: Partial<Rider> }
  | { t: 'refund.request'; orderId: string; amount: number; reason: string; source: Refund['source']; at: string; refundId: string }
  | { t: 'refund.status'; id: string; status: Refund['status']; at: string }
  | { t: 'refund.evidence'; id: string; reference: string; fileName: string }
  | { t: 'wallet.adjust'; entry: WalletLedgerEntry }
  | { t: 'reconciliation.status'; id: string; status: 'open' | 'investigating' | 'resolved'; note?: string }
  | { t: 'invoice.retry'; id: string; at: string }
  | { t: 'payout.approve'; id: string; at: string }
  | { t: 'payout.hold'; id: string; reason: string }
  | { t: 'payout.settle'; id: string; reference: string; fileName?: string; at: string }
  | { t: 'coupon.add'; coupon: Coupon }
  | { t: 'coupon.update'; id: string; patch: Partial<Coupon> }
  | { t: 'campaign.add'; campaign: PushCampaign }
  | { t: 'notif.read'; id?: string }
  | { t: 'subscription.retryRun'; id: string; at: string }
  | { t: 'subscription.config'; patch: Partial<SystemSettings['subscription']> }
  | { t: 'ticket.reply'; id: string; message: TicketMessage }
  | { t: 'ticket.status'; id: string; status: 'open' | 'pending' | 'resolved' | 'closed'; at: string }
  | { t: 'rating.moderate'; id: string; status: 'approved' | 'removed'; reason?: string }
  | { t: 'approval.decide'; id: string; status: 'completed' | 'rejected'; decidedBy: string; at: string; apply?: { variantId?: string; newPrice?: number; publish?: boolean; workforceId?: string; newRole?: string } }
  | { t: 'fraud.status'; id: string; status: 'open' | 'cleared' | 'confirmed' }
  | { t: 'erasure.update'; id: string; patch: Partial<ErasureRequest> }
  | { t: 'hold.add'; hold: LegalHold }
  | { t: 'hold.release'; id: string; at: string }
  | { t: 'export.add'; job: ExportJob }
  | { t: 'export.complete'; id: string; rowCount: number; fileName: string }
  | { t: 'export.fail'; id: string; error: string }
  | { t: 'job.retry'; id: string; at: string }
  | { t: 'flags'; features: SystemSettings['features'] }
  | { t: 'rules'; rules: SystemSettings['rules'] }
  | { t: 'approval.add'; approval: Approval }
  | { t: 'notification'; entry: AdminNotification }
  // ── Store manager portal ops ──
  | { t: 'picking.claim'; taskId: string; assigneeId: string; at: string }
  | { t: 'picking.pick'; taskId: string; lineId: string; qtyPicked: number; batchId: string }
  | { t: 'picking.substitute'; taskId: string; lineId: string; substitutionVariantId: string }
  | { t: 'picking.unavailable'; taskId: string; lineId: string; reason: string }
  | { t: 'picking.complete'; taskId: string; at: string }
  | { t: 'packing.save'; taskId: string; bags: number; coldChain: boolean; packedBy: string; notes?: string; riderId: string; riderName: string; code: string; at: string }
  | { t: 'handover.verify'; taskId: string; code: string; attempts: number; at: string }
  | { t: 'picking.release'; taskId: string }
  | { t: 'returns.record'; parcel: ReturnParcel }
  | { t: 'returns.decide'; parcelId: string; itemBatchId: string; decision: 'saleable' | 'damaged' | 'expired' }
  | { t: 'returns.complete'; parcelId: string; stockAction: 'quarantine' | 'write_off'; note?: string; at: string }
  | { t: 'returns.draft'; parcelId: string }
  | { t: 'riderDoc.decide'; appId: string; docType: string; status: 'approved' | 'rejected'; reason?: string; at: string }
  | { t: 'cod.record'; deposit: CodDeposit }
  | { t: 'receipt.add'; receipt: StockReceipt }
  | { t: 'bin.set'; storeId: string; variantId: string; binLocation: string }
  | { t: 'count.start'; count: StockCount }
  | { t: 'count.update'; id: string; lineBatchId: string; counted: number }
  | { t: 'count.complete'; id: string; at: string }
  | { t: 'adjustment.create'; adjustment: StockAdjustment; approval?: Approval }
  | { t: 'status.change'; change: StoreStatusChange }
  | { t: 'staff.reassign'; taskId: string; toAssigneeId: string; reason: string; by: string }
  | { t: 'storeNotif.read'; id?: string }
  | { t: 'prefs.set'; workforceId: string; prefs: StoreNotificationPrefs }
  | { t: 'feed.newOrder'; order: Order; task: PickingTask }

function applyOp(db: DB, op: JournalOp): void {
  switch (op.t) {
    case 'store.add': db.stores = [op.store, ...db.stores]; break
    case 'store.update': db.stores = db.stores.map((s) => (s.id === op.id ? { ...s, ...op.patch } : s)); break
    case 'store.delete':
      db.stores = db.stores.filter((s) => s.id !== op.id)
      db.zones = db.zones.filter((z) => z.storeId !== op.id)
      break
    case 'zone.add': db.zones = [...db.zones, op.zone]; break
    case 'zone.update': db.zones = db.zones.map((z) => (z.id === op.id ? { ...z, ...op.patch } : z)); break
    case 'zone.delete': db.zones = db.zones.filter((z) => z.id !== op.id); break
    case 'entity.add': db.legalEntities = [...db.legalEntities, op.entity]; break
    case 'entity.update': db.legalEntities = db.legalEntities.map((e) => (e.id === op.id ? { ...e, ...op.patch } : e)); break
    case 'entity.delete': db.legalEntities = db.legalEntities.filter((e) => e.id !== op.id); break
    case 'product.add': db.products = [op.product, ...db.products]; db.variants = [...db.variants, ...op.variants]; break
    case 'product.update': db.products = db.products.map((p) => (p.id === op.id ? { ...p, ...op.patch } : p)); break
    case 'product.delete':
      db.products = db.products.filter((p) => p.id !== op.id)
      db.variants = db.variants.filter((v) => v.productId !== op.id)
      break
    case 'variant.update': db.variants = db.variants.map((v) => (v.id === op.id ? { ...v, ...op.patch } : v)); break
    case 'variant.add': db.variants = [...db.variants, op.variant]; break
    case 'storeVariant.update':
      db.storeVariants = db.storeVariants.map((sv) => (sv.variantId === op.variantId && sv.storeId === op.storeId ? { ...sv, ...op.patch } : sv))
      break
    case 'stock.update':
      db.stockLevels = db.stockLevels.map((s) => (s.storeId === op.storeId && s.variantId === op.variantId ? { ...s, ...op.patch } : s))
      break
    case 'order.hold':
      db.orders = db.orders.map((o) => (o.id === op.id ? { ...o, status: 'on_hold', holdReason: op.reason, timeline: { ...o.timeline, held: op.at }, requiresAttention: true, attentionReason: 'on_hold' } : o))
      break
    case 'order.release':
      db.orders = db.orders.map((o) => (o.id === op.id ? { ...o, status: 'confirmed', holdReason: undefined, timeline: { ...o.timeline, released: op.at } } : o))
      break
    case 'order.cancel':
      db.orders = db.orders.map((o) => (o.id === op.id ? { ...o, status: 'cancelled', cancelReason: op.reason, timeline: { ...o.timeline, cancelled: op.at } } : o))
      break
    case 'order.correction':
      db.orders = db.orders.map((o) => (o.id === op.id ? { ...o, correctionRequests: [{ id: `cr-${Date.now()}`, kind: op.kind, reason: op.reason, requestedBy: op.by, status: 'requested', at: op.at }, ...o.correctionRequests] } : o))
      break
    case 'order.reassign':
      db.orders = db.orders.map((o) => (o.id === op.id ? { ...o, riderId: op.riderId } : o))
      break
    case 'order.resolveAddress':
      db.orders = db.orders.map((o) => (o.id === op.id ? { ...o, wrongAddressResolvedAt: op.at } : o))
      break
    case 'order.resetCode':
      db.orders = db.orders.map((o) => (o.id === op.id ? { ...o, deliveryCodeLocked: false, deliveryCode: String(Math.floor(1000 + Math.random() * 9000)) } : o))
      break
    case 'customer.block': db.customers = db.customers.map((c) => (c.id === op.id ? { ...c, status: 'blocked', blockedReason: op.reason } : c)); break
    case 'customer.unblock': db.customers = db.customers.map((c) => (c.id === op.id ? { ...c, status: 'active', blockedReason: undefined } : c)); break
    case 'workforce.add': db.workforce = [op.member, ...db.workforce]; break
    case 'workforce.update': db.workforce = db.workforce.map((w) => (w.id === op.id ? { ...w, ...op.patch } : w)); break
    case 'rider.update': db.riders = db.riders.map((r) => (r.id === op.id ? { ...r, ...op.patch } : r)); break
    case 'refund.request': {
      const order = db.orders.find((o) => o.id === op.orderId)
      db.refunds = [{ id: op.refundId, orderId: op.orderId, amount: op.amount, status: 'requested', reason: op.reason, source: op.source, createdAt: op.at }, ...db.refunds]
      break
    }
    case 'refund.status': db.refunds = db.refunds.map((r) => (r.id === op.id ? { ...r, status: op.status, paidAt: op.status === 'paid' ? op.at : r.paidAt } : r)); break
    case 'refund.evidence': db.refunds = db.refunds.map((r) => (r.id === op.id ? { ...r, evidence: { reference: op.reference, fileName: op.fileName } } : r)); break
    case 'wallet.adjust': {
      db.walletLedger = [op.entry, ...db.walletLedger]
      const balances = { ...db.meta.walletBalances }
      balances[op.entry.customerId] = (balances[op.entry.customerId] ?? 0) + op.entry.amount
      db.meta = { ...db.meta, walletBalances: balances }
      break
    }
    case 'reconciliation.status': db.reconciliationFindings = db.reconciliationFindings.map((f) => (f.id === op.id ? { ...f, status: op.status, note: op.note ?? f.note } : f)); break
    case 'invoice.retry': db.invoiceFailures = db.invoiceFailures.map((f) => (f.id === op.id ? { ...f, status: 'rendering' } : f)); break
    case 'payout.approve': db.payouts = db.payouts.map((p) => (p.id === op.id ? { ...p, status: 'approved', canApprove: false, approvedAt: op.at } : p)); break
    case 'payout.hold': db.payouts = db.payouts.map((p) => (p.id === op.id ? { ...p, status: 'on_hold', holdReason: op.reason } : p)); break
    case 'payout.settle': db.payouts = db.payouts.map((p) => (p.id === op.id ? { ...p, status: 'paid', paymentReference: op.reference, evidenceFileName: op.fileName, paidAt: op.at } : p)); break
    case 'coupon.add': db.coupons = [op.coupon, ...db.coupons]; break
    case 'coupon.update': db.coupons = db.coupons.map((c) => (c.id === op.id ? { ...c, ...op.patch } : c)); break
    case 'campaign.add': db.pushCampaigns = [op.campaign, ...db.pushCampaigns]; break
    case 'notif.read': db.adminNotifications = db.adminNotifications.map((n) => (!op.id || n.id === op.id ? { ...n, read: true } : n)); break
    case 'subscription.retryRun': {
      db.subscriptionRuns = db.subscriptionRuns.map((r) => (r.id === op.id
        ? { ...r, status: r.failures.every((f) => !f.retryable) ? r.status : 'completed', failures: r.failures.filter((f) => !f.retryable) }
        : r))
      break
    }
    case 'subscription.config': db.systemSettings = { ...db.systemSettings, subscription: { ...db.systemSettings.subscription, ...op.patch } }; break
    case 'ticket.reply': db.tickets = db.tickets.map((t) => (t.id === op.id ? { ...t, messages: [...t.messages, op.message], updatedAt: op.message.at, status: t.status === 'open' ? 'pending' : t.status } : t)); break
    case 'ticket.status': db.tickets = db.tickets.map((t) => (t.id === op.id ? { ...t, status: op.status, updatedAt: op.at } : t)); break
    case 'rating.moderate': db.ratings = db.ratings.map((r) => (r.id === op.id ? { ...r, moderationStatus: op.status, moderationReason: op.reason ?? r.moderationReason } : r)); break
    case 'approval.decide': {
      db.approvals = db.approvals.map((a) => (a.id === op.id ? { ...a, status: op.status, decidedAt: op.at, decidedBy: op.decidedBy } : a))
      if (op.apply?.variantId && op.apply.newPrice != null) {
        db.variants = db.variants.map((v) => (v.id === op.apply!.variantId ? { ...v, price: op.apply!.newPrice! } : v))
        const variant = db.variants.find((v) => v.id === op.apply!.variantId)
        if (variant) db.products = db.products.map((p) => (p.id === variant.productId ? { ...p, pendingApprovalId: undefined, pendingChangeLabel: undefined } : p))
      }
      if (op.apply?.publish != null && op.apply.variantId) {
        const variantId = op.apply.variantId
        const publish = op.apply.publish
        const variant = db.variants.find((v) => v.id === variantId)
        if (variant) db.products = db.products.map((p) => (p.id === variant.productId ? { ...p, publishState: publish ? 'published' : 'unpublished', pendingApprovalId: undefined, pendingChangeLabel: undefined } : p))
      }
      if (op.apply?.workforceId && op.apply.newRole) {
        db.workforce = db.workforce.map((w) => (w.id === op.apply!.workforceId ? { ...w, role: op.apply!.newRole as WorkforceAccount['role'], pendingRoleChangeApprovalId: undefined } : w))
      }
      break
    }
    case 'fraud.status': db.fraudFindings = db.fraudFindings.map((f) => (f.id === op.id ? { ...f, status: op.status } : f)); break
    case 'erasure.update': db.erasureRequests = db.erasureRequests.map((e) => (e.id === op.id ? { ...e, ...op.patch } : e)); break
    case 'hold.add': db.legalHolds = [op.hold, ...db.legalHolds]; break
    case 'hold.release': db.legalHolds = db.legalHolds.map((h) => (h.id === op.id ? { ...h, status: 'released', releasedAt: op.at } : h)); break
    case 'export.add': db.exportJobs = [op.job, ...db.exportJobs]; break
    case 'export.complete': db.exportJobs = db.exportJobs.map((j) => (j.id === op.id ? { ...j, status: 'complete', rowCount: op.rowCount, fileName: op.fileName, completedAt: new Date().toISOString() } : j)); break
    case 'export.fail': db.exportJobs = db.exportJobs.map((j) => (j.id === op.id ? { ...j, status: 'failed', error: op.error } : j)); break
    case 'job.retry': db.backgroundJobs = db.backgroundJobs.map((j) => (j.id === op.id ? { ...j, status: 'retrying', attempts: j.attempts + 1, lastRunAt: op.at } : j)); break
    case 'flags': db.systemSettings = { ...db.systemSettings, features: op.features }; break
    case 'rules': db.systemSettings = { ...db.systemSettings, rules: op.rules }; break
    case 'approval.add': db.approvals = [op.approval, ...db.approvals]; break
    case 'notification': db.adminNotifications = [op.entry, ...db.adminNotifications]; break
    default: applyStoreOp(db, op)
  }
}

interface DBState {
  db: DB
  journal: JournalOp[]
  version: number
  apply: (op: JournalOp) => void
  resetDemoData: () => void
}

function applyStoreOp(db: DB, op: Extract<JournalOp, { t: 'picking.claim' | 'picking.pick' | 'picking.substitute' | 'picking.unavailable' | 'picking.complete' | 'packing.save' | 'handover.verify' | 'picking.release' | 'returns.record' | 'returns.decide' | 'returns.complete' | 'returns.draft' | 'riderDoc.decide' | 'cod.record' | 'receipt.add' | 'bin.set' | 'count.start' | 'count.update' | 'count.complete' | 'adjustment.create' | 'status.change' | 'staff.reassign' | 'storeNotif.read' | 'prefs.set' | 'feed.newOrder' }>): void {
  switch (op.t) {
    case 'picking.claim':
      db.pickingTasks = db.pickingTasks.map((t) => (t.id === op.taskId ? { ...t, status: 'being_picked', assigneeId: op.assigneeId, claimedAt: op.at } : t))
      db.orders = db.orders.map((o) => (o.id === db.pickingTasks.find((x) => x.id === op.taskId)?.orderId ? { ...o, status: 'picking' } : o))
      break
    case 'picking.pick':
      db.pickingTasks = db.pickingTasks.map((t) => (t.id === op.taskId ? { ...t, lines: t.lines.map((l) => (l.id === op.lineId ? { ...l, qtyPicked: op.qtyPicked, batchId: op.batchId, resolved: true } : l)) } : t))
      break
    case 'picking.substitute':
      db.pickingTasks = db.pickingTasks.map((t) => (t.id === op.taskId ? { ...t, lines: t.lines.map((l) => (l.id === op.lineId ? { ...l, substitutionVariantId: op.substitutionVariantId, unavailableReason: undefined, resolved: true } : l)) } : t))
      break
    case 'picking.unavailable':
      db.pickingTasks = db.pickingTasks.map((t) => (t.id === op.taskId ? { ...t, lines: t.lines.map((l) => (l.id === op.lineId ? { ...l, unavailableReason: op.reason, qtyPicked: 0, resolved: true } : l)) } : t))
      break
    case 'picking.complete': {
      const task = db.pickingTasks.find((x) => x.id === op.taskId)
      db.pickingTasks = db.pickingTasks.map((t) => (t.id === op.taskId ? { ...t, status: 'ready_to_pack' } : t))
      if (task) db.orders = db.orders.map((o) => (o.id === task.orderId ? { ...o, status: 'ready' } : o))
      break
    }
    case 'packing.save': {
      const task = db.pickingTasks.find((x) => x.id === op.taskId)
      const rider = db.riders.find((r) => r.id === op.riderId)
      db.pickingTasks = db.pickingTasks.map((t) => (t.id === op.taskId ? {
        ...t, packing: { bags: op.bags, coldChain: op.coldChain, packedBy: op.packedBy, notes: op.notes },
        status: 'ready_for_handover',
        handover: { state: 'PENDING' as const, riderId: op.riderId, riderName: op.riderName, locked: false, deliveryStatus: null, code: t.handover?.code ?? String(Math.floor(1000 + Math.random() * 9000)), attempts: 0 },
      } : t))
      if (task) {
        db.orders = db.orders.map((o) => (o.id === task.orderId ? { ...o, status: 'out_for_delivery', riderId: rider?.id ?? null } : o))
        db.riders = db.riders.map((r) => (r.id === op.riderId ? { ...r, status: 'on_delivery' as Rider['status'] } : r))
      }
      break
    }
    case 'handover.verify': {
      const task = db.pickingTasks.find((x) => x.id === op.taskId)
      const ok = task?.handover?.code === op.code
      if (ok && task) {
        db.pickingTasks = db.pickingTasks.map((t) => (t.id === op.taskId ? { ...t, status: 'completed', handover: { ...t.handover!, verifiedAt: op.at, attempts: op.attempts }, completedAt: op.at } : t))
        if (task) db.orders = db.orders.map((o) => (o.id === task.orderId ? { ...o, status: 'delivered', timeline: { ...o.timeline, delivered: op.at } } : o))
        db.riders = db.riders.map((r) => (r.id === task.handover!.riderId ? { ...r, status: 'active' as Rider['status'], deliveriesPeriod: r.deliveriesPeriod + 1 } : r))
      } else {
        db.pickingTasks = db.pickingTasks.map((t) => (t.id === op.taskId ? { ...t, handover: { ...t.handover!, attempts: op.attempts } } : t))
      }
      break
    }
    case 'picking.release':
      db.pickingTasks = db.pickingTasks.map((t) => (t.id === op.taskId ? { ...t, status: 'waiting_to_pick', assigneeId: null, claimedAt: undefined } : t))
      break
    case 'returns.record':
      db.returns = [op.parcel, ...db.returns]
      break
    case 'returns.decide':
      db.returns = db.returns.map((r) => (r.id === op.parcelId ? { ...r, status: 'under_inspection', items: r.items.map((it) => (it.batchId === op.itemBatchId ? { ...it, decision: op.decision } : it)) } : r))
      break
    case 'returns.complete':
      db.returns = db.returns.map((r) => (r.id === op.parcelId ? { ...r, status: 'processed', stockAction: op.stockAction, note: op.note, processedAt: op.at } : r))
      break
    case 'returns.draft':
      db.returns = db.returns.map((r) => (r.id === op.parcelId ? { ...r, draft: true } : r))
      break
    case 'riderDoc.decide': {
      db.riderApplications = db.riderApplications.map((a) => {
        if (a.id !== op.appId) return a
        const documents = a.documents.map((d) => (d.type === op.docType ? { ...d, status: op.status, decidedAt: op.at, reason: op.reason } : d))
        const anyRejected = documents.some((d) => d.status === 'rejected')
        const allApproved = documents.every((d) => d.status === 'approved')
        const status: RiderApplication['status'] = anyRejected ? 'rejected' : allApproved ? 'approved' : 'under_review'
        return { ...a, documents, status }
      })
      const app = db.riderApplications.find((a) => a.id === op.appId)
      if (app && app.status === 'approved') {
        db.riders = [{
          id: `rd-app-${app.id}`, name: app.riderName, phone: app.phone, avatar: Math.floor(Math.random() * 12),
          storeId: app.storeId, status: 'active', appliedOn: app.appliedAt.slice(0, 10), vehicle: app.vehicle.type,
          documents: [{ type: 'license', status: 'verified' }, { type: 'id_proof', status: 'verified' }, { type: 'bank_details', status: 'verified' }],
          reviewedByStoreManager: true, deliveriesPeriod: 0, rating: 4.5,
        }, ...db.riders]
      }
      break
    }
    case 'cod.record':
      db.codDeposits = [op.deposit, ...db.codDeposits]
      break
    case 'receipt.add':
      db.stockReceipts = [op.receipt, ...db.stockReceipts]
      db.inventoryBatches = [{ id: op.receipt.batchNo, storeId: op.receipt.storeId, variantId: op.receipt.variantId, qty: op.receipt.qty, expiryDate: op.receipt.expiryDate, binLocation: op.receipt.binLocation }, ...db.inventoryBatches]
      db.stockLevels = db.stockLevels.map((s) => (s.storeId === op.receipt.storeId && s.variantId === op.receipt.variantId ? { ...s, qty: s.qty + op.receipt.qty } : s))
      db.movements = [{ id: `MV${Date.now()}`, storeId: op.receipt.storeId, variantId: op.receipt.variantId, type: 'receipt', qtyDelta: op.receipt.qty, reason: 'Stock receipt', actor: op.receipt.by, at: op.receipt.at, flagged: false }, ...db.movements]
      break
    case 'bin.set':
      db.inventoryBatches = db.inventoryBatches.map((b) => (b.storeId === op.storeId && b.variantId === op.variantId ? { ...b, binLocation: op.binLocation } : b))
      break
    case 'count.start':
      db.stockCounts = [op.count, ...db.stockCounts]
      break
    case 'count.update':
      db.stockCounts = db.stockCounts.map((c) => (c.id === op.id ? { ...c, lines: c.lines.map((l) => (l.variantId === op.lineBatchId || l.name ? { ...l, counted: l.variantId === op.lineBatchId ? op.counted : l.counted } : l)) } : c))
      break
    case 'count.complete':
      db.stockCounts = db.stockCounts.map((c) => (c.id === op.id ? { ...c, status: 'completed' } : c))
      break
    case 'adjustment.create': {
      db.stockAdjustments = [op.adjustment, ...db.stockAdjustments]
      if (op.approval) db.approvals = [op.approval, ...db.approvals]
      if (op.approval?.status === 'completed' && op.adjustment.delta !== 0) {
        // approved adjustments actually move stock
        const batches = db.inventoryBatches.filter((b) => b.storeId === op.adjustment.storeId && b.variantId === op.adjustment.variantId)
        let remaining = Math.abs(op.adjustment.delta)
        for (const b of batches) {
          if (remaining <= 0) break
          const take = Math.min(b.qty, remaining)
          b.qty = Math.max(0, b.qty - take)
          remaining -= take
        }
      }
      break
    }
    case 'status.change': {
      db.storeStatusChanges = [op.change, ...db.storeStatusChanges]
      db.stores = db.stores.map((s) => (s.id === op.change.storeId ? { ...s, status: op.change.status } : s))
      break
    }
    case 'staff.reassign':
      db.pickingTasks = db.pickingTasks.map((t) => (t.id === op.taskId ? { ...t, assigneeId: op.toAssigneeId } : t))
      break
    case 'storeNotif.read':
      db.storeNotifications = db.storeNotifications.map((n) => (!op.id || n.id === op.id ? { ...n, read: true } : n))
      break
    case 'prefs.set':
      db.storeNotificationPrefs = [
        { workforceId: op.workforceId, prefs: op.prefs },
        ...db.storeNotificationPrefs.filter((p) => p.workforceId !== op.workforceId),
      ]
      break
    case 'feed.newOrder': {
      db.orders = [op.order, ...db.orders]
      db.pickingTasks = [op.task, ...db.pickingTasks]
      db.storeNotifications = [{ id: `sn-${Date.now()}`, storeId: op.task.storeId, title: 'New order in picking queue', body: `${op.order.id} added — waiting to pick`, kind: 'operational', requiresAction: false, read: false, at: op.order.placedAt, link: '/orders-picking' }, ...db.storeNotifications]
      break
    }
  }
}

export const useDB = create<DBState>()(
  persist(
    (set, get) => ({
      db: buildSeedData(),
      journal: [],
      version: 0,
      apply: (op) => {
        const { db, journal } = get()
        const next = { ...db }
        applyOp(next, op)
        const nextJournal = op.t === 'notif.read' ? journal : [...journal, op].slice(-250)
        set({ db: next, journal: nextJournal, version: get().version + 1 })
      },
      resetDemoData: () => set({ db: buildSeedData(), journal: [], version: get().version + 1 }),
    }),
    {
      name: 'dd_mock_db_journal_v1',
      partialize: (s) => ({ journal: s.journal }),
      onRehydrateStorage: () => (state) => {
        if (!state) return
        const fresh = buildSeedData()
        for (const op of state.journal ?? []) applyOp(fresh, op)
        state.db = fresh
        state.version = (state.version ?? 0) + 1
      },
    },
  ),
)

export const demoNow = () => new Date(useDB.getState().db.demoNow)
export { DEMO_NOW }
