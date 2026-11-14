import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Boxes, AlertTriangle, CalendarClock, Flag, SearchX, ShieldAlert, ChevronLeft, ChevronRight, Save } from 'lucide-react'
import { useStagger, useDebouncedValue } from '@/hooks/misc'
import {
  useInventorySummary, useInventoryReport, useInventoryLedger, useShelfLife,
  useCategories, useStores,
} from '@/hooks/queries'
import { useInventoryActions } from '@/hooks/mutations'
import { PageHeader, TabPills, SearchInput, EmptyState } from '@/components/shared/misc'
import { Select, Field } from '@/components/ui/form'
import { Button, Card, Badge, Input, Textarea } from '@/components/ui/base'
import { Dialog, DialogContent } from '@/components/ui/overlays'
import { KpiCard } from '@/components/shared/KpiCard'
import { DataTable } from '@/components/shared/DataTable'
import type { InventorySummaryRow, LedgerRow, ShelfLifePolicy } from '@/types'
import { cn, fmtDateTime, fmtNum } from '@/lib/utils'

type MainTab = 'stock' | 'crossstore' | 'movements' | 'shelf'

function CursorPager({ onPrev, onNext, hasPrev, hasNext, loading, label }: {
  onPrev: () => void; onNext: () => void; hasPrev: boolean; hasNext: boolean; loading: boolean; label: string
}) {
  return (
    <div className="flex items-center justify-between border-t border-border/60 px-5 py-3.5 text-xs text-muted-foreground">
      <span>{label}</span>
      <div className="flex gap-1.5">
        <Button size="sm" variant="outline" disabled={!hasPrev || loading} onClick={onPrev}><ChevronLeft className="h-3.5 w-3.5" /> Prev</Button>
        <Button size="sm" variant="outline" disabled={!hasNext || loading} onClick={onNext}>Next <ChevronRight className="h-3.5 w-3.5" /></Button>
      </div>
    </div>
  )
}

function useCursorPager() {
  const [cursor, setCursor] = useState<string | null>(null)
  const [stack, setStack] = useState<Array<string | null>>([null])
  const next = (nc: string | null) => {
    if (!nc) return
    setStack((st) => [...st, nc]); setCursor(nc)
  }
  const prev = () => {
    setStack((st) => {
      if (st.length <= 1) return st
      const s = st.slice(0, -1)
      setCursor(s[s.length - 1] ?? null)
      return s
    })
  }
  const reset = () => { setCursor(null); setStack([null]) }
  return { cursor, hasPrev: stack.length > 1, next, prev, reset, depth: stack.length }
}

function ShelfLifeEditDialog({ open, onOpenChange, policy, categories, onSave }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  policy: ShelfLifePolicy | null
  categories: Array<{ id: string; name: string }>
  onSave: (categoryId: string, minSeconds: number, expectedVersion: string, reason: string) => void
}) {
  const [categoryId, setCategoryId] = useState(policy?.categoryId ?? categories[0]?.id ?? '')
  const [days, setDays] = useState(policy ? Math.round(policy.minSeconds / 86400) : 7)
  const [reason, setReason] = useState('')
  useEffect(() => {
    setCategoryId(policy?.categoryId ?? categories[0]?.id ?? '')
    setDays(policy ? Math.round(policy.minSeconds / 86400) : 7)
    setReason('')
  }, [open, policy, categories])

  const invalid = !categoryId || days < 0 || reason.trim().length < 3
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={policy ? 'Edit shelf-life policy' : 'Add shelf-life policy'} description="Minimum shelf life accepted at goods-in, per category">
        <div className="space-y-3">
          <Field label="Category" required>
            <Select value={categoryId} onValueChange={setCategoryId} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
          </Field>
          <Field label="Minimum shelf life (days)" required>
            <Input type="number" min={0} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </Field>
          <Field label="Reason" required hint="Stored with the policy change">
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Vendor guarantees fresher stock from March" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" disabled={invalid} onClick={() => { onSave(categoryId, days * 86400, policy?.version ?? '1', reason.trim()); onOpenChange(false) }}>
              <Save className="h-4 w-4" /> Save policy
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function Inventory() {
  const container = useStagger()

  const [tab, setTab] = useState<MainTab>('stock')
  const actions = useInventoryActions()
  const [editPolicy, setEditPolicy] = useState<ShelfLifePolicy | null>(null)
  const [policyDialogOpen, setPolicyDialogOpen] = useState(false)

  const storesQ = useStores()
  const stores = storesQ.data ?? []
  const categoriesQ = useCategories()
  const categories = categoriesQ.data ?? []

  // per-store report requires a storeId — default to the first store
  const [storeId, setStoreId] = useState<string | null>(null)
  useEffect(() => {
    if (!storeId && stores.length > 0) setStoreId(stores[0]!.id)
  }, [stores, storeId])

  // cross-store summary feed — full catalog (names for every variant)
  const [summarySearchRaw, setSummarySearchRaw] = useState('')
  const summarySearch = useDebouncedValue(summarySearchRaw, 250)
  const summaryQ = useInventorySummary(summarySearch || undefined)
  const summary = summaryQ.data?.items ?? []

  const storeName = (id: string) => stores.find((s) => s.id === id)?.name ?? id.slice(0, 8)

  // per-store stock report (quantities only — names joined from summary)
  const reportPager = useCursorPager()
  useEffect(() => { reportPager.reset() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [storeId])
  const reportQ = useInventoryReport(storeId, reportPager.cursor ?? undefined)
  const reportRows = reportQ.data?.items ?? []

  const ledgerPager = useCursorPager()
  useEffect(() => { ledgerPager.reset() /* eslint-disable-line react-hooks/exhaustive-deps */ }, [storeId])
  const [ledgerVariant, setLedgerVariant] = useState<string | null>(null)
  const ledgerQ = useInventoryLedger(storeId, ledgerVariant ?? undefined, ledgerPager.cursor ?? undefined)
  const ledgerRows = ledgerQ.data?.items ?? []

  const shelfQ = useShelfLife()
  const shelfRows = shelfQ.data ?? []

  // join names/sku onto report rows from the summary feed
  const summaryById = useMemo(() => {
    const m = new Map<string, InventorySummaryRow>()
    for (const r of summary) m.set(r.variantId, r)
    return m
  }, [summary])

  const lowCount = summary.reduce((a, r) => a + (r.lowStockStores > 0 ? 1 : 0), 0)
  const totalUnits = summary.reduce((a, r) => a + r.units, 0)

  const variantName = (variantId: string) => summaryById.get(variantId)?.name ?? variantId.slice(0, 8)
  const variantSku = (variantId: string) => summaryById.get(variantId)?.sku ?? '—'

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inventory"
        titleAccent="oversight"
        subtitle="Network-wide stock levels, the movement ledger and shelf life. Receiving, counting and quality handling live with the store managers."
        artwork="inventory"
        breadcrumb={['Inventory']}
      />

      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-5">
        {/* ── KPI row ── */}
        <motion.section variants={container.item} className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <KpiCard label="Units across network" value={totalUnits} icon={Boxes} tint="green" format="num" />
          <KpiCard label="Variants low somewhere" value={lowCount} icon={AlertTriangle} tint="amber" format="num" />
          <KpiCard label="Stores reporting" value={stores.length} icon={Boxes} tint="blue" format="num" />
          <KpiCard label="Shelf-life policies" value={shelfRows.length} icon={CalendarClock} tint="violet" format="num" />
        </motion.section>

        <motion.div variants={container.item}>
          <TabPills
            id="inventory-tabs"
            value={tab}
            onChange={(v) => setTab(v as MainTab)}
            tabs={[
              { value: 'stock', label: 'Store stock' },
              { value: 'crossstore', label: 'Cross-store' },
              { value: 'movements', label: 'Ledger' },
              { value: 'shelf', label: 'Shelf life' },
            ]}
          />
        </motion.div>

        {/* ── STORE STOCK (per-store report) ── */}
        {tab === 'stock' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="w-48">
                <Select value={storeId ?? ''} onValueChange={setStoreId} options={stores.map((s) => ({ value: s.id, label: s.name }))} placeholder="Pick store" />
              </div>
              <p className="text-xs text-muted-foreground">The stock report is per-store — pick a store to view its levels.</p>
            </div>
            {!storeId ? (
              <Card className="p-8"><EmptyState icon={SearchX} title="Pick a store" body="Choose a store to load its stock report." /></Card>
            ) : (
              <Card className="overflow-hidden">
                <DataTable
                  keyId={(r) => r.variantId}
                  rows={reportRows}
                  loading={reportQ.isLoading}
                  empty={<EmptyState icon={SearchX} title="No stock rows" body="This store has no recorded stock yet." />}
                  columns={[
                    {
                      key: 'product', header: 'Product',
                      render: (r: (typeof reportRows)[number]) => (
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{variantName(r.variantId)}</p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">{variantSku(r.variantId)}</p>
                        </div>
                      ),
                    },
                    { key: 'onHand', header: 'On hand', render: (r: (typeof reportRows)[number]) => <span className="font-bold tabular">{fmtNum(r.onHand)}</span> },
                    { key: 'reserved', header: 'Reserved', render: (r: (typeof reportRows)[number]) => <span className="tabular text-muted-foreground">{fmtNum(r.reserved)}</span> },
                    { key: 'available', header: 'Available', render: (r: (typeof reportRows)[number]) => <span className="font-bold tabular">{fmtNum(r.available)}</span> },
                    {
                      key: 'low', header: 'Status',
                      render: (r: (typeof reportRows)[number]) => (summaryById.get(r.variantId)?.lowStockStores ?? 0) > 0
                        ? <Badge tone="red">LOW somewhere</Badge>
                        : <Badge tone="green">OK</Badge>,
                    },
                  ]}
                />
                <CursorPager
                  onPrev={reportPager.prev}
                  onNext={() => reportPager.next(reportQ.data?.nextCursor ?? null)}
                  hasPrev={reportPager.hasPrev}
                  hasNext={!!reportQ.data?.nextCursor}
                  loading={reportQ.isLoading}
                  label={`Page ${reportPager.depth} · store stock feed`}
                />
              </Card>
            )}
          </motion.section>
        )}

        {/* ── CROSS-STORE SUMMARY ── */}
        {tab === 'crossstore' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <SearchInput value={summarySearchRaw} onChange={setSummarySearchRaw} placeholder="Search variant or SKU…" className="min-w-[220px] flex-1" />
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(r) => r.variantId}
                rows={summary}
                loading={summaryQ.isLoading}
                empty={<EmptyState icon={SearchX} title="No summary rows" body="Adjust the search to find variants." />}
                columns={[
                  {
                    key: 'variant', header: 'Variant',
                    render: (r: InventorySummaryRow) => (
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{r.name}</p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">{r.sku}</p>
                      </div>
                    ),
                  },
                  { key: 'units', header: 'Units', render: (r: InventorySummaryRow) => <span className="font-bold tabular">{fmtNum(r.units)}</span> },
                  { key: 'stores', header: 'Stores stocked', render: (r: InventorySummaryRow) => <span className="tabular">{fmtNum(r.availableStores)}</span> },
                  { key: 'low', header: 'Low-stock stores', render: (r: InventorySummaryRow) => r.lowStockStores > 0 ? <Badge tone="red">{r.lowStockStores}</Badge> : <Badge tone="green">0</Badge> },
                  { key: 'reserved', header: 'Reserved', render: (r: InventorySummaryRow) => <span className="tabular text-muted-foreground">{fmtNum(r.totalReserved)}</span> },
                ]}
              />
              <p className="px-1 pb-2 text-[11px] font-semibold text-muted-foreground">
                Full catalog — {fmtNum(summary.length)} variants network-wide
              </p>
            </Card>
          </motion.section>
        )}

        {/* ── MOVEMENTS LEDGER ── */}
        {tab === 'movements' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="w-48">
                <Select value={storeId ?? ''} onValueChange={setStoreId} options={stores.map((s) => ({ value: s.id, label: s.name }))} placeholder="Pick store" />
              </div>
              <div className="w-56">
                <Select
                  value={ledgerVariant ?? ''}
                  onValueChange={(v) => { setLedgerVariant(v || null); ledgerPager.reset() }}
                  options={[{ value: '', label: 'All variants' }, ...summary.map((r) => ({ value: r.variantId, label: `${r.name} · ${r.sku}` }))]}
                  placeholder="Filter variant"
                />
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-warning-soft px-4 py-3 dark:border-amber-500/30">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-warning" />
              <p className="text-[13px] font-medium leading-relaxed text-amber-800 dark:text-amber-200">
                The ledger is append-only — adjustments above the policy threshold appear in Approvals for a checker to approve.
              </p>
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(r: LedgerRow) => r.id}
                rows={ledgerRows}
                loading={ledgerQ.isLoading}
                empty={<EmptyState icon={SearchX} title="No movements" body="Adjust the filters to see the stock ledger." />}
                columns={[
                  { key: 'when', header: 'When', render: (r: LedgerRow) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(r.createdAt)}</span> },
                  { key: 'ref', header: 'Reference', render: (r: LedgerRow) => <span className="font-mono text-[12px]">{r.reference}</span> },
                  { key: 'product', header: 'Product', render: (r: LedgerRow) => <span className="block max-w-[220px] truncate font-medium">{variantName(r.variantId)}</span> },
                  { key: 'kind', header: 'Kind', render: (r: LedgerRow) => <Badge tone="blue">{r.kind.toLowerCase().replace(/_/g, ' ')}</Badge> },
                  {
                    key: 'qty', header: 'On-hand Δ',
                    render: (r: LedgerRow) => (
                      <span className={cn('font-bold tabular', r.onHandDelta >= 0 ? 'text-success' : 'text-destructive')}>
                        {r.onHandDelta >= 0 ? '+' : '−'}{fmtNum(Math.abs(r.onHandDelta))}
                      </span>
                    ),
                  },
                  {
                    key: 'reserved', header: 'Reserved Δ',
                    render: (r: LedgerRow) => (
                      <span className={cn('font-bold tabular', r.reservedDelta >= 0 ? 'text-success' : 'text-destructive')}>
                        {r.reservedDelta >= 0 ? '+' : '−'}{fmtNum(Math.abs(r.reservedDelta))}
                      </span>
                    ),
                  },
                  { key: 'actor', header: 'Actor', render: (r: LedgerRow) => <span className="text-[13px] text-muted-foreground">{r.actorId ? `${r.actorId.slice(0, 8)}…` : 'system'}</span> },
                ]}
              />
              <CursorPager
                onPrev={ledgerPager.prev}
                onNext={() => ledgerPager.next(ledgerQ.data?.nextCursor ?? null)}
                hasPrev={ledgerPager.hasPrev}
                hasNext={!!ledgerQ.data?.nextCursor}
                loading={ledgerQ.isLoading}
                label={`Page ${ledgerPager.depth} · ledger feed`}
              />
            </Card>
          </motion.section>
        )}

        {/* ── SHELF LIFE ── */}
        {tab === 'shelf' && (
          <motion.section variants={container.item} className="grid grid-cols-1 gap-4 xl:grid-cols-12">
            <Card className="overflow-hidden xl:col-span-7">
              <div className="flex items-center justify-between px-5 pt-5 pb-3">
                <div>
                  <h3 className="text-[15px] font-bold tracking-tight">Category shelf-life policies</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">Minimum shelf life accepted at goods-in, per category</p>
                </div>
                <Button size="sm" variant="primary" onClick={() => { setEditPolicy(null); setPolicyDialogOpen(true) }}>
                  <CalendarClock className="h-3.5 w-3.5" /> Set policy
                </Button>
              </div>
              <DataTable
                keyId={(r) => r.categoryId}
                rows={shelfRows}
                loading={shelfQ.isLoading}
                empty={<EmptyState icon={CalendarClock} title="No shelf-life policies" body="Set the first policy for a category." />}
                columns={[
                  { key: 'category', header: 'Category', render: (r: ShelfLifePolicy) => <span className="font-semibold">{categories.find((c) => c.id === r.categoryId)?.name ?? r.categoryId.slice(0, 8) + '…'}</span> },
                  { key: 'min', header: 'Min shelf life', render: (r: ShelfLifePolicy) => <span className="tabular">{Math.round(r.minSeconds / 86400)} days</span> },
                  { key: 'version', header: 'Version', render: (r: ShelfLifePolicy) => <span className="font-mono text-[11px] text-muted-foreground">v{r.version}</span> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (r: ShelfLifePolicy) => (
                      <div className="flex justify-end">
                        <Button size="sm" variant="ghost" onClick={() => { setEditPolicy(r); setPolicyDialogOpen(true) }}>
                          <Save className="h-3.5 w-3.5" /> Edit
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
            <Card className="p-5 xl:col-span-5">
              <h3 className="flex items-center gap-2 text-[15px] font-bold tracking-tight"><AlertTriangle className="h-4 w-4 text-amber-500" /> Adjustment approvals</h3>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                Store managers request stock adjustments; those above the configured threshold need a second approver
                (also holding a STORE_MANAGER assignment at the affected store). Pending adjustment approvals appear under
                <span className="font-semibold text-foreground"> Approvals</span> where the Approve action executes them.
              </p>
              <p className="mt-3 text-xs text-muted-foreground">Direct stock edits are intentionally not available to the admin — receiving and counting belong to stores.</p>
            </Card>
          </motion.section>
        )}
      </motion.div>

      <ShelfLifeEditDialog
        open={policyDialogOpen}
        onOpenChange={setPolicyDialogOpen}
        policy={editPolicy}
        categories={categories}
        onSave={(categoryId, minSeconds, expectedVersion, reason) => actions.setShelfLife(categoryId, minSeconds, expectedVersion, reason).mutate(undefined, { onError: () => {} })}
      />
    </div>
  )
}

export default Inventory
