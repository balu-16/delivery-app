// §3 Inventory — batch-level stock table, receive stock, low-stock/expiring views,
// persistent multi-line count sessions and versioned manual adjustments.
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, Boxes, ClipboardCheck, Download,
  Layers, MoreVertical, PackageCheck, PackagePlus, Plus, Repeat, Truck,
} from 'lucide-react'
import { useStagger, useDebouncedValue } from '@dairydirect/shared/hooks/misc'
import {
  useActiveStoreId, useStoreStock, useLowStock, useExpiringStock, useStoreAdjustments,
  useCountSessions, useBinLocations,
} from '@/api/storeQueries'
import { useStoreInventoryActions } from '@/api/storeMutations'
import type { StockRow } from '@/api/storeApi'
import { downloadCsv } from '@dairydirect/shared/services/exports'
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Skeleton, Badge } from '@dairydirect/shared/ui/base'
import { ConfirmDialog, Dialog, DialogContent, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownItem } from '@dairydirect/shared/ui/overlays'
import { Select, Field } from '@dairydirect/shared/ui/form'
import { PageHeader, TabPills, SearchInput, StatusPill, EmptyState } from '@dairydirect/shared/ui/misc'
import { KpiCard } from '@dairydirect/shared/ui/KpiCard'
import { DataTable, Pagination, type Column } from '@dairydirect/shared/ui/DataTable'
import { ProductTile } from '@dairydirect/shared/assets/productIcons'
import { InventoryScene } from '@dairydirect/shared/assets/scenes'
import { cn, fmtDate, fmtDateTime } from '@dairydirect/shared/lib/utils'
import { toast } from '@dairydirect/shared/lib/toast'
import type { ProductIcon, StockAdjustment } from '@dairydirect/shared/types'

const TABS = [
  { value: 'stock', label: 'Stock' },
  { value: 'receive', label: 'Receive stock' },
  { value: 'low', label: 'Low stock' },
  { value: 'expiring', label: 'Expiring' },
  { value: 'adjustments', label: 'Counts & adjustments' },
]
const TAB_VALUES = TABS.map((t) => t.value)

const ADJUSTMENT_REASONS = ['Damaged write-off', 'Expired write-off', 'Unexplained variance', 'Cycle correction', 'Found stock']
const MIN_REASON = 5

function iconFor(productName: string): ProductIcon {
  const n = productName.toLowerCase()
  if (n.includes('milk') && !n.includes('flavored')) return 'milk'
  if (n.includes('paneer')) return 'paneer'
  if (n.includes('ghee')) return 'ghee'
  if (n.includes('curd')) return 'curd'
  if (n.includes('butter')) return 'butter'
  if (n.includes('lassi')) return 'lassi'
  if (n.includes('chaas') || n.includes('buttermilk')) return 'buttermilk'
  if (n.includes('cream')) return 'cream'
  if (n.includes('cheese')) return 'cheese'
  if (n.includes('khoya')) return 'khoya'
  if (n.includes('tofu')) return 'paneer'
  return 'flavored_milk'
}

function daysLeft(expiryDate: string) {
  return Math.ceil((new Date(expiryDate).getTime() - Date.now()) / 86400000)
}

interface BatchOption { batchId: string; variantId: string; label: string; version: string }

/* ── Record adjustment dialog (shared by stock-row ⋮ and adjustments tab) ── */
function AdjustDialog({ open, onOpenChange, options, defaultBatchId, onConfirm }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  options: BatchOption[]
  defaultBatchId?: string
  onConfirm: (option: BatchOption, delta: number, reason: string) => void
}) {
  const [batchId, setBatchId] = useState(defaultBatchId ?? '')
  const [delta, setDelta] = useState('')
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (open) { setBatchId(defaultBatchId ?? ''); setDelta(''); setReason('') }
  }, [open, defaultBatchId])

  const option = options.find((o) => o.batchId === batchId) ?? null
  const numDelta = Number(delta)
  const needsApproval = Number.isFinite(numDelta) && Math.abs(numDelta) >= 20
  const valid = !!option && delta !== '' && Number.isFinite(numDelta) && numDelta !== 0 && reason.trim().length >= MIN_REASON

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Record adjustment"
        description="Correct stock for one batch. Signed delta: negative = write-off, positive = found stock."
      >
        <div className="space-y-4">
          <Field label="Batch" required>
            <Select value={batchId} onValueChange={setBatchId} placeholder="Select batch…" options={options.map((o) => ({ value: o.batchId, label: o.label }))} />
          </Field>
          <Field label="Delta (signed)" required hint="e.g. −4 for damaged units, +6 for found stock">
            <Input
              type="number"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="0"
              aria-label="Adjustment delta"
            />
          </Field>
          <Field label="Reason" required error={reason && reason.trim().length < MIN_REASON ? `Reason must be at least ${MIN_REASON} characters` : undefined}>
            <Select value={reason} onValueChange={setReason} placeholder="Select reason…" options={ADJUSTMENT_REASONS.map((r) => ({ value: r, label: r }))} />
          </Field>
          <p className={cn(
            'rounded-lg px-3 py-2 text-[11.5px] font-medium',
            needsApproval ? 'bg-warning-soft text-amber-700 dark:text-amber-300' : 'bg-muted text-muted-foreground',
          )}>
            Large (≥ 20 units) adjustments are sent to the admin for approval.
          </p>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              size="md"
              disabled={!valid}
              onClick={() => { if (option) onConfirm(option, numDelta, reason.trim()); onOpenChange(false) }}
            >
              <ClipboardCheck className="h-4 w-4" /> Record adjustment
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function StoreInventory() {
  const container = useStagger()
  const storeId = useActiveStoreId()
  const invActions = useStoreInventoryActions()
  const [searchParams, setSearchParams] = useSearchParams()

  // ── tab (deep-linkable via ?tab=) ──
  const [tab, setTabState] = useState(() => {
    const t = searchParams.get('tab')
    return t && TAB_VALUES.includes(t) ? t : 'stock'
  })
  useEffect(() => {
    const t = searchParams.get('tab')
    if (t && TAB_VALUES.includes(t)) setTabState((prev) => (prev === t ? prev : t))
  }, [searchParams])
  const setTab = (t: string) => {
    setTabState(t)
    const sp = new URLSearchParams(searchParams)
    if (t === 'stock') sp.delete('tab')
    else sp.set('tab', t)
    setSearchParams(sp, { replace: true })
  }

  // ── data ──
  const stockQ = useStoreStock(storeId)
  const lowQ = useLowStock(storeId)
  const expQ = useExpiringStock(storeId)
  const adjQ = useStoreAdjustments(storeId)
  const sessionsQ = useCountSessions(storeId)
  const binsQ = useBinLocations(storeId)
  const allStock = stockQ.data ?? []
  const lowRows = lowQ.data ?? []
  const expiringRows = expQ.data ?? []
  const adjustments = adjQ.data ?? []
  const sessions = sessionsQ.data ?? []
  const bins = binsQ.data ?? []

  const [search, setSearch] = useState('')
  const debSearch = useDebouncedValue(search, 250)
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<string[]>([])

  useEffect(() => { setPage(1) }, [tab, debSearch])

  // ── KPI inputs ──
  const pendingAdjCount = adjustments.filter((a) => a.approvalStatus === 'pending').length
  const variantCount = useMemo(() => new Set(allStock.map((r) => r.batch.variantId)).size, [allStock])

  // stock table rows (search is client-side over the store-scoped batch query)
  const stockRows = useMemo(() => {
    const q = debSearch.trim().toLowerCase()
    if (!q) return allStock
    return allStock.filter((r) =>
      r.variantName.toLowerCase().includes(q) ||
      r.sku.toLowerCase().includes(q) ||
      r.batchCode.toLowerCase().includes(q))
  }, [allStock, debSearch])

  // unique carried variants (receive form)
  const variantOptions = useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ value: string; label: string }> = []
    for (const r of allStock) {
      if (seen.has(r.batch.variantId)) continue
      seen.add(r.batch.variantId)
      out.push({ value: r.batch.variantId, label: r.variantName })
    }
    return out
  }, [allStock])

  const variantNameOf = (vid: string) => variantOptions.find((o) => o.value === vid)?.label ?? vid

  const batchOptions: BatchOption[] = useMemo(
    () => allStock.map((r) => ({
      batchId: r.batch.id,
      variantId: r.batch.variantId,
      version: r.version,
      label: `${r.variantName} · ${r.batchCode} · ${fmtDate(r.batch.expiryDate)}`,
    })),
    [allStock],
  )

  // ── set bin dialog ──
  const [binRow, setBinRow] = useState<StockRow | null>(null)
  const [binChoice, setBinChoice] = useState('')

  // ── adjustment dialog ──
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [adjustBatchId, setAdjustBatchId] = useState<string | undefined>(undefined)

  // ── receive form ──
  const [rcProduct, setRcProduct] = useState('')
  const [rcBatchNo, setRcBatchNo] = useState('')
  const [rcExpiry, setRcExpiry] = useState('')
  const [rcQty, setRcQty] = useState('')
  const [rcBin, setRcBin] = useState('')

  const receiveValid = !!rcProduct && rcBatchNo.trim().length > 0 && Number(rcQty) > 0

  // ── stock count session ──
  const activeCount = sessions.find((c) => c.status === 'open') ?? null
  const [countInputs, setCountInputs] = useState<Record<string, string>>({})
  useEffect(() => {
    if (activeCount) {
      const init: Record<string, string> = {}
      for (const l of activeCount.lines) init[l.batchId] = l.counted === null ? '' : String(l.counted)
      setCountInputs(init)
    } else {
      setCountInputs({})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCount?.id])

  const commitCountLine = async (lineId: string) => {
    if (!activeCount) return
    const line = activeCount.lines.find((l) => l.batchId === lineId)
    if (!line) return
    const raw = countInputs[lineId]?.trim() ?? ''
    const n = Number(raw)
    if (raw === '' || Number.isNaN(n) || n < 0) return
    if (line.counted === n) return
    await invActions.updateCountSession(activeCount.id, [{ batchId: line.batchId, counted: String(n), reason: line.reason }])
  }

  const startStockCount = () => {
    if (!storeId || !allStock.length || activeCount) return
    void invActions.createCountSession()
  }

  const completeStockCount = async () => {
    if (!activeCount) return
    const changed = activeCount.lines.filter((line) => {
      const raw = countInputs[line.batchId]?.trim() ?? ''
      const n = raw === '' ? null : Number(raw)
      return n !== null && !Number.isNaN(n) && n !== line.counted
    })
    if (changed.length) {
      await invActions.updateCountSession(activeCount.id, changed.map((line) => ({
        batchId: line.batchId,
        counted: countInputs[line.batchId]!.trim(),
        reason: line.reason,
      })))
    }
    await invActions.completeCountSession(activeCount.id)
  }

  const [cancelOpen, setCancelOpen] = useState(false)

  const submitAdjustment = (option: BatchOption, delta: number, reason: string) => {
    if (!storeId) return
    void invActions.createAdjustment(storeId, option.variantId, option.batchId, delta, option.version, reason)
  }

  const exportCsv = () => {
    void downloadCsv(
      allStock.map((r) => ({
        Product: r.variantName, SKU: r.sku, Batch: r.batchCode, Expiry: r.batch.expiryDate,
        Bin: r.batch.binLocation, 'Qty On Hand': r.onHand, Available: r.available, Status: r.status,
      })),
      `inventory-stock-${new Date().toISOString().slice(0, 10)}.csv`,
    )
    toast.success('Stock exported as CSV')
  }

  /* ── shared table column builders ── */
  const productCol = (key = 'product'): Column<StockRow> => ({
    key,
    header: 'Product',
    render: (r) => (
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-muted/70 ring-1 ring-border/60">
          <ProductTile icon={iconFor(r.variantName)} size={26} />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-bold">{r.variantName}</div>
          <div className="truncate text-[11.5px] text-muted-foreground">{r.sku}</div>
        </div>
      </div>
    ),
  })
  const skuCol: Column<StockRow> = { key: 'sku', header: 'SKU', render: (r) => <span className="font-medium tabular text-muted-foreground">{r.sku}</span> }
  const batchCol: Column<StockRow> = { key: 'batch', header: 'Batch', render: (r) => <span className="tabular">{r.batchCode}</span> }
  const expiryCol: Column<StockRow> = { key: 'expiry', header: 'Expiry', render: (r) => <span className="tabular">{r.batch.expiryDate ? fmtDate(r.batch.expiryDate) : '—'}</span> }
  const binCol = (onSetBin: (r: StockRow) => void): Column<StockRow> => ({
    key: 'bin', header: 'Location / Bin',
    render: (r) => (
      <span className="inline-flex items-center gap-2">
        <span className="rounded-md bg-muted px-2 py-0.5 text-[12px] font-bold tabular">{r.batch.binLocation || '—'}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onSetBin(r) }}
          className="text-[11px] font-bold text-brand-700 underline-offset-2 hover:underline dark:text-brand-300"
          aria-label={`Set bin for ${r.variantName}`}
        >
          Set bin
        </button>
      </span>
    ),
  })
  const qtyCol: Column<StockRow> = { key: 'qty', header: 'On Hand', align: 'right', render: (r) => <span className="font-bold tabular">{r.onHand}</span> }
  const availableCol: Column<StockRow> = { key: 'available', header: 'Available', align: 'right', render: (r) => <span className="tabular">{r.available}</span> }
  const statusCol = (extra?: (r: StockRow) => React.ReactNode): Column<StockRow> => ({
    key: 'status', header: 'Status',
    render: (r) => (
      <span className="flex flex-wrap items-center gap-1.5">
        <StatusPill status={r.status} />
        {extra?.(r)}
      </span>
    ),
  })
  const actionsCol = (onSetBin: (r: StockRow) => void, onAdjust: (r: StockRow) => void): Column<StockRow> => ({
    key: 'actions', header: 'Actions', align: 'right',
    render: (r) => (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="iconSm" aria-label={`Actions for ${r.variantName}`} onClick={(e) => e.stopPropagation()}>
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownItem onClick={() => onSetBin(r)}><Layers className="h-3.5 w-3.5" /> Set bin</DropdownItem>
          <DropdownItem onClick={() => onAdjust(r)}><ClipboardCheck className="h-3.5 w-3.5" /> Adjust stock</DropdownItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ),
  })

  const openSetBin = (r: StockRow) => { setBinRow(r); setBinChoice(r.batch.binLocation || '') }
  const openAdjust = (r: StockRow) => { setAdjustBatchId(r.batch.id); setAdjustOpen(true) }

  const paginate = <T,>(rows: T[], size: number) => rows.slice((page - 1) * size, page * size)
  const showing = (rows: number, size: number) =>
    rows ? `Showing ${(page - 1) * size + 1} – ${Math.min(page * size, rows)} of ${rows} items` : undefined

  return (
    <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-5">
      <PageHeader
        title="Inventory"
        subtitle="Manage store stock, receive items, track expiry and record adjustments."
        illustration={<InventoryScene />}
        breadcrumb={['Inventory']}
      />

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Stocked Variants" value={stockQ.isLoading ? 0 : variantCount} icon={Boxes} tint="green" highlight />
        <KpiCard label="Low Stock Items" value={lowQ.isLoading ? 0 : lowRows.length} icon={Layers} tint="amber" />
        <KpiCard label="Expiring Items" value={expQ.isLoading ? 0 : expiringRows.length} icon={AlertTriangle} tint="red" />
        <KpiCard label="Adjustment Requests" value={adjQ.isLoading ? 0 : pendingAdjCount} icon={Repeat} tint="violet" />
      </div>

      <motion.div variants={container.item}>
        <Card>
          <div className="border-b border-border/70 px-5 pb-1 pt-3">
            <TabPills id="inventory-tabs" value={tab} onChange={setTab} tabs={TABS} />
          </div>

          {/* ───────────────── STOCK ───────────────── */}
          {tab === 'stock' && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
                <CardTitle className="text-[15px]">Current Stock ({stockRows.length} batches)</CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  <SearchInput value={search} onChange={setSearch} placeholder="Search product, SKU or batch…" className="w-56" />
                  <Button variant="secondary" size="md" onClick={exportCsv} aria-label="Export stock as CSV">
                    <Download className="h-4 w-4" /> Export CSV
                  </Button>
                  <Button size="md" onClick={() => setTab('receive')}>
                    <Plus className="h-4 w-4" /> Add Stock
                  </Button>
                </div>
              </div>
              <DataTable<StockRow>
                columns={[
                  productCol(),
                  skuCol,
                  batchCol,
                  expiryCol,
                  binCol(openSetBin),
                  qtyCol,
                  availableCol,
                  statusCol(),
                  actionsCol(openSetBin, openAdjust),
                ]}
                rows={paginate(stockRows, 10)}
                keyId={(r) => r.batch.id}
                loading={stockQ.isLoading}
                selectable
                selected={selected}
                onSelectedChange={setSelected}
                skeletonRows={8}
                empty={<EmptyState icon={Boxes} title="No stock found" body="Try a different search, or receive stock to fill the shelves." />}
              />
              <Pagination page={page} totalPages={Math.max(1, Math.ceil(stockRows.length / 10))} onChange={setPage} showing={showing(stockRows.length, 10)} />
            </>
          )}

          {/* ───────────────── RECEIVE ───────────────── */}
          {tab === 'receive' && (
            <div className="grid grid-cols-1 gap-5 p-5 lg:grid-cols-2">
              <Card hoverable className="border-border/70 shadow-none">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <span className="grid h-7 w-7 place-items-center rounded-lg bg-primary-soft text-brand-700 dark:text-brand-300"><Truck className="h-4 w-4" /></span>
                    Record Incoming Stock
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Field label="Product" required>
                    <Select
                      value={rcProduct}
                      onValueChange={setRcProduct}
                      placeholder="Select product…"
                      options={variantOptions}
                    />
                  </Field>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Batch No." required>
                      <Input value={rcBatchNo} onChange={(e) => setRcBatchNo(e.target.value)} placeholder="e.g., ML-2408" aria-label="Batch number" />
                    </Field>
                    <Field label="Expiry Date" hint="Required for expiry-tracked products">
                      <Input type="date" value={rcExpiry} onChange={(e) => setRcExpiry(e.target.value)} aria-label="Expiry date" />
                    </Field>
                    <Field label="Quantity" required>
                      <Input type="number" min={1} value={rcQty} onChange={(e) => setRcQty(e.target.value)} placeholder="Enter quantity" aria-label="Quantity" />
                    </Field>
                    <Field label="Location / Bin" hint="Applied to the variant after receipt">
                      <Select
                        value={rcBin}
                        onValueChange={setRcBin}
                        placeholder="Select location…"
                        options={bins.map((b) => ({ value: b, label: b }))}
                      />
                    </Field>
                  </div>
                  <Button
                    size="md"
                    className="w-full"
                    disabled={!receiveValid}
                    onClick={() => {
                      if (!storeId) return
                      const expiry = rcExpiry ? new Date(rcExpiry).toISOString() : undefined
                      void invActions.receiveStock(storeId, rcProduct, rcBatchNo.trim(), Math.round(Number(rcQty)), expiry).then((result) => {
                        if (result !== null && rcBin) void invActions.setBin(storeId, rcProduct, rcBin)
                      })
                      setRcProduct(''); setRcBatchNo(''); setRcExpiry(''); setRcQty(''); setRcBin('')
                    }}
                  >
                    <PackagePlus className="h-4 w-4" /> Record Stock
                  </Button>
                </CardContent>
              </Card>

              <Card hoverable className="border-border/70 shadow-none">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <span className="grid h-7 w-7 place-items-center rounded-lg bg-warning-soft text-amber-600 dark:text-warning"><Repeat className="h-4 w-4" /></span>
                    Recent Adjustments
                  </CardTitle>
                  <button onClick={() => setTab('adjustments')} className="text-[12px] font-bold text-brand-700 hover:underline dark:text-brand-300">View All →</button>
                </CardHeader>
                <CardContent className="space-y-2">
                  {adjQ.isLoading
                    ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-xl" />)
                    : [...adjustments].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5).map((a) => (
                      <div key={a.id} className="flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2.5">
                        <span className={cn(
                          'grid h-8 w-8 shrink-0 place-items-center rounded-full',
                          a.delta >= 0 ? 'bg-success-soft text-success' : 'bg-destructive-soft text-destructive',
                        )}>
                          {a.delta >= 0 ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-semibold">{variantNameOf(a.variantId)}</p>
                          <p className="truncate text-[11px] text-muted-foreground">{a.reason} · {a.by} · {fmtDateTime(a.at)}</p>
                        </div>
                        <span className={cn('shrink-0 text-[13px] font-bold tabular', a.delta >= 0 ? 'text-success' : 'text-destructive')}>
                          {a.delta > 0 ? '+' : ''}{a.delta}
                        </span>
                      </div>
                    ))}
                  {!adjQ.isLoading && adjustments.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">No adjustments recorded yet.</p>}
                </CardContent>
              </Card>
            </div>
          )}

          {/* ───────────────── LOW STOCK ───────────────── */}
          {tab === 'low' && (
            <>
              <div className="px-5 py-3.5">
                <CardTitle className="text-[15px]">Low Stock — below the configured reorder threshold ({lowRows.length})</CardTitle>
              </div>
              <DataTable
                columns={[
                  {
                    key: 'product', header: 'Product',
                    render: (r) => (
                      <div className="flex items-center gap-3">
                        <ProductTile icon={iconFor(r.name)} size={26} />
                        <div>
                          <div className="text-[13.5px] font-bold">{r.name}</div>
                          <div className="text-[11.5px] text-muted-foreground">{r.sku}</div>
                        </div>
                      </div>
                    ),
                  },
                  { key: 'onHand', header: 'On Hand', align: 'right', render: (r) => <span className="tabular">{r.onHand}</span> },
                  { key: 'reserved', header: 'Reserved', align: 'right', render: (r) => <span className="tabular">{r.reserved}</span> },
                  { key: 'available', header: 'Available', align: 'right', render: (r) => <span className="font-bold tabular text-destructive">{r.available}</span> },
                  { key: 'bin', header: 'Bin', render: (r) => <span className="tabular text-muted-foreground">{r.binLocation || '—'}</span> },
                  { key: 'status', header: 'Status', render: () => <Badge tone="red">Reorder needed</Badge> },
                  {
                    key: 'action', header: 'Action', align: 'right',
                    render: (r) => (
                      <Button
                        variant="outline" size="sm"
                        disabled={!allStock.some((s) => s.batch.variantId === r.variantId)}
                        onClick={() => {
                          const first = allStock.find((s) => s.batch.variantId === r.variantId)
                          if (first) { setAdjustBatchId(first.batch.id); setAdjustOpen(true) }
                        }}
                      >
                        <ClipboardCheck className="h-3.5 w-3.5" /> Adjust
                      </Button>
                    ),
                  },
                ]}
                rows={paginate(lowRows, 10)}
                keyId={(r) => r.variantId}
                loading={lowQ.isLoading}
                skeletonRows={6}
                empty={<EmptyState icon={PackageCheck} title="Nothing is running low" body="Every stocked variant is above its reorder threshold." />}
              />
              <Pagination page={page} totalPages={Math.max(1, Math.ceil(lowRows.length / 10))} onChange={setPage} showing={showing(lowRows.length, 10)} />
            </>
          )}

          {/* ───────────────── EXPIRING ───────────────── */}
          {tab === 'expiring' && (
            <>
              <div className="px-5 py-3.5">
                <CardTitle className="text-[15px]">Expiring soon ({expiringRows.length}) — sorted by expiry</CardTitle>
              </div>
              <DataTable
                columns={[
                  {
                    key: 'product', header: 'Product',
                    render: (r) => (
                      <div className="flex items-center gap-3">
                        <ProductTile icon={iconFor(r.variantName)} size={26} />
                        <div>
                          <div className="text-[13.5px] font-bold">{r.variantName}</div>
                          <div className="text-[11.5px] text-muted-foreground">Batch {r.batchCode}</div>
                        </div>
                      </div>
                    ),
                  },
                  { key: 'expiry', header: 'Expiry', render: (r) => <span className="tabular">{fmtDate(r.expiresAt)}</span> },
                  {
                    key: 'days', header: 'Shelf Life',
                    render: (r) => {
                      const days = Math.max(0, daysLeft(r.expiresAt))
                      return (
                        <span className={cn(
                          'rounded-full px-2.5 py-1 text-[11px] font-bold tabular',
                          days <= 2 ? 'bg-destructive-soft text-destructive' : 'bg-warning-soft text-amber-600 dark:text-warning',
                        )}>
                          {days} day{days === 1 ? '' : 's'} left
                        </span>
                      )
                    },
                  },
                  { key: 'onHand', header: 'On Hand', align: 'right', render: (r) => <span className="font-bold tabular">{r.onHand}</span> },
                  { key: 'reserved', header: 'Reserved', align: 'right', render: (r) => <span className="tabular">{r.reserved}</span> },
                  { key: 'state', header: 'Status', render: (r) => <StatusPill status={r.state === 'ACTIVE' ? 'expiring' : 'quarantined'} /> },
                  {
                    key: 'action', header: 'Action', align: 'right',
                    render: (r) => (
                      <Button
                        variant="outline" size="sm"
                        onClick={() => { setAdjustBatchId(r.batchId); setAdjustOpen(true) }}
                      >
                        <ClipboardCheck className="h-3.5 w-3.5" /> Adjust
                      </Button>
                    ),
                  },
                ]}
                rows={paginate(expiringRows, 10)}
                keyId={(r) => r.batchId}
                loading={expQ.isLoading}
                skeletonRows={6}
                empty={<EmptyState icon={PackageCheck} title="No expiring stock" body="Nothing is approaching expiry in the configured window." />}
              />
              <Pagination page={page} totalPages={Math.max(1, Math.ceil(expiringRows.length / 10))} onChange={setPage} showing={showing(expiringRows.length, 10)} />
            </>
          )}

          {/* ───────────────── COUNTS & ADJUSTMENTS ───────────────── */}
          {tab === 'adjustments' && (
            <div className="space-y-5 p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle className="text-[15px]">Stock counts &amp; adjustments</CardTitle>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="md" onClick={startStockCount} disabled={!allStock.length || !!activeCount}>
                    <ClipboardCheck className="h-4 w-4" /> {activeCount ? 'Count in progress' : 'Start stock count'}
                  </Button>
                  <Button size="md" onClick={() => { setAdjustBatchId(undefined); setAdjustOpen(true) }}>
                    <Plus className="h-4 w-4" /> Record adjustment
                  </Button>
                </div>
              </div>

              {/* active count card */}
              {activeCount ? (
                <Card hoverable className="border-brand-200 bg-gradient-to-br from-brand-50/60 to-card">
                  <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                      Active stock count <Badge tone="blue">{activeCount.id.slice(0, 8).toUpperCase()}</Badge>
                    </CardTitle>
                    <span className="text-[11.5px] text-muted-foreground">Started {fmtDateTime(activeCount.startedAt)} · {activeCount.lines.length} batches</span>
                  </CardHeader>
                  <CardContent>
                    <div className="max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                      {activeCount.lines.map((l) => {
                        const input = countInputs[l.batchId] ?? (l.counted === null ? '' : String(l.counted))
                        const countedNum = input.trim() !== '' && Number.isFinite(Number(input)) ? Number(input) : null
                        const variance = countedNum === null ? null : countedNum - l.expected
                        return (
                          <div key={l.batchId} className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 bg-card px-3.5 py-2.5">
                            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{l.name} <span className="font-normal text-muted-foreground">· {l.batchCode}</span></span>
                            <span className="text-[12px] text-muted-foreground">Expected: <span className="font-bold tabular text-foreground">{l.expected}</span></span>
                            <input
                              value={input}
                              onChange={(e) => setCountInputs((s) => ({ ...s, [l.batchId]: e.target.value.replace(/\D/g, '') }))}
                              onBlur={() => void commitCountLine(l.batchId)}
                              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                              placeholder="Counted"
                              aria-label={`Counted quantity for ${l.name} batch ${l.batchCode}`}
                              className="h-9 w-24 rounded-xl border border-input bg-card px-3 text-center text-[13px] font-bold tabular shadow-innersoft focus:outline-none focus:ring-2 focus:ring-ring/60"
                            />
                            <span className={cn(
                              'w-20 text-right text-[12.5px] font-bold tabular',
                              variance === null ? 'text-muted-foreground' : variance === 0 ? 'text-success' : variance > 0 ? 'text-info' : 'text-destructive',
                            )}>
                              {variance === null ? '—' : `${variance > 0 ? '+' : ''}${variance} var`}
                            </span>
                          </div>
                        )
                      })}
                      {activeCount.lines.length === 0 && <p className="py-6 text-center text-xs text-muted-foreground">No active batches to count.</p>}
                    </div>
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      <Button variant="secondary" size="md" onClick={() => setCancelOpen(true)}>
                        Cancel count
                      </Button>
                      <Button size="md" onClick={() => void completeStockCount()} disabled={activeCount.lines.length === 0}>
                        <PackageCheck className="h-4 w-4" /> Complete count
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ) : (
                <div className="rounded-xl border border-dashed border-border px-5 py-6 text-center text-[13px] text-muted-foreground">
                  No open count. <span className="font-semibold text-foreground">Start stock count</span> to snapshot every active batch and record counted quantities over multiple visits.
                </div>
              )}

              {/* session history */}
              {sessions.filter((s) => s.status !== 'open').length > 0 && (
                <Card>
                  <CardHeader><CardTitle>Count Sessions</CardTitle></CardHeader>
                  <CardContent className="px-0 pb-0">
                    <DataTable
                      columns={[
                        { key: 'id', header: 'Session', render: (s) => <span className="font-semibold tabular">{s.id.slice(0, 8).toUpperCase()}</span> },
                        { key: 'started', header: 'Started', render: (s) => <span className="tabular text-muted-foreground">{fmtDateTime(s.startedAt)}</span> },
                        { key: 'completed', header: 'Closed', render: (s) => <span className="tabular text-muted-foreground">{s.completedAt ? fmtDateTime(s.completedAt) : '—'}</span> },
                        { key: 'lines', header: 'Lines', align: 'right', render: (s) => <span className="tabular">{s.lines.length}</span> },
                        {
                          key: 'outcome', header: 'Outcomes',
                          render: (s) => {
                            const applied = s.lines.filter((l) => l.outcome === 'APPLIED').length
                            const pending = s.lines.filter((l) => l.outcome === 'PENDING_APPROVAL').length
                            const failed = s.lines.filter((l) => l.outcome === 'FAILED').length
                            return <span className="flex flex-wrap gap-1.5">
                              {applied > 0 && <Badge tone="green">{applied} applied</Badge>}
                              {pending > 0 && <Badge tone="amber">{pending} pending</Badge>}
                              {failed > 0 && <Badge tone="red">{failed} failed</Badge>}
                              {applied + pending + failed === 0 && <span className="text-muted-foreground">—</span>}
                            </span>
                          },
                        },
                        { key: 'status', header: 'Status', render: (s) => <StatusPill status={s.status === 'completed' ? 'processed' : 'cancelled'} /> },
                      ]}
                      rows={sessions.filter((s) => s.status !== 'open')}
                      keyId={(s) => s.id}
                      loading={sessionsQ.isLoading}
                      skeletonRows={4}
                      empty={<EmptyState icon={ClipboardCheck} title="No count sessions yet" body="Completed stock counts will appear here." />}
                    />
                  </CardContent>
                </Card>
              )}

              {/* adjustments history */}
              <Card>
                <CardHeader>
                  <CardTitle>Adjustments ({adjustments.length})</CardTitle>
                  <span className="text-[11.5px] text-muted-foreground">{pendingAdjCount} pending admin approval</span>
                </CardHeader>
                <CardContent className="px-0 pb-0">
                  <DataTable<StockAdjustment>
                    columns={[
                      { key: 'variant', header: 'Variant', render: (a) => <span className="font-semibold">{variantNameOf(a.variantId)}</span> },
                      {
                        key: 'delta', header: 'Delta', align: 'right',
                        render: (a) => (
                          <span className={cn('font-bold tabular', a.delta >= 0 ? 'text-success' : 'text-destructive')}>
                            {a.delta > 0 ? '+' : ''}{a.delta}
                          </span>
                        ),
                      },
                      { key: 'reason', header: 'Reason', render: (a) => <span className="text-muted-foreground">{a.reason}</span> },
                      { key: 'by', header: 'By', render: (a) => a.by },
                      { key: 'at', header: 'When', render: (a) => <span className="tabular text-muted-foreground">{fmtDateTime(a.at)}</span> },
                      {
                        key: 'approvalStatus', header: 'Status',
                        render: (a) => (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <StatusPill status={a.approvalStatus} />
                            {a.approvalStatus === 'pending' && <Badge tone="amber">Pending admin approval</Badge>}
                          </span>
                        ),
                      },
                    ]}
                    rows={adjustments}
                    keyId={(a) => a.id}
                    loading={adjQ.isLoading}
                    skeletonRows={6}
                    empty={<EmptyState icon={ClipboardCheck} title="No adjustments yet" body="Record an adjustment to correct stock counts." />}
                  />
                </CardContent>
              </Card>
            </div>
          )}
        </Card>
      </motion.div>

      {/* set bin dialog */}
      <Dialog open={!!binRow} onOpenChange={(v) => { if (!v) setBinRow(null) }}>
        <DialogContent
          title="Set bin location"
          description={binRow ? `${binRow.variantName} — all batches of this variant move to the chosen bin.` : ''}
        >
          <div className="space-y-4">
            <Field label="Location / Bin" required>
              <Select value={binChoice} onValueChange={setBinChoice} placeholder="Select bin…" options={bins.map((b) => ({ value: b, label: b }))} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="md" onClick={() => setBinRow(null)}>Cancel</Button>
              <Button
                size="md"
                disabled={!binChoice || !binRow}
                onClick={() => {
                  if (storeId && binRow) void invActions.setBin(storeId, binRow.batch.variantId, binChoice)
                  setBinRow(null)
                }}
              >
                Set bin
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* cancel count confirm */}
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Cancel this stock count?"
        description="Recorded counted quantities are discarded. No stock adjustments are applied."
        confirmLabel="Cancel count"
        destructive
        onConfirm={() => {
          if (activeCount) void invActions.cancelCountSession(activeCount.id)
          setCancelOpen(false)
        }}
      />

      {/* record adjustment dialog */}
      <AdjustDialog
        open={adjustOpen}
        onOpenChange={setAdjustOpen}
        options={batchOptions}
        defaultBatchId={adjustBatchId}
        onConfirm={submitAdjustment}
      />
    </motion.div>
  )
}
