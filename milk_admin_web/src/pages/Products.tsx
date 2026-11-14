import { useEffect, useMemo, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { motion } from 'framer-motion'
import {
  Plus, FileUp, MoreVertical, Pencil, Package, Store as StoreIcon, Trash2,
  EyeOff, Eye, Save, ChevronLeft, ChevronRight, IndianRupee, ListChecks,
} from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import { useProducts, useVariants, useCategories, useBrands, useStores } from '@/hooks/queries'
import { useProductActions } from '@/hooks/mutations'
import { createCatalogMediaTarget, uploadToTarget, createCatalogImport, getCatalogImport, approveCatalogImport, type CatalogImport } from '@/api/catalog'
import { toast } from '@/lib/toast'
import { PageHeader, SearchInput, StatusPill, EmptyState } from '@/components/shared/misc'
import { Select, Field } from '@/components/ui/form'
import { Button, Card, Input, Switch, Badge, Textarea, Label } from '@/components/ui/base'
import {
  Dialog, DialogContent, Drawer, ConfirmDialog, DropdownMenu, DropdownMenuTrigger,
  DropdownMenuContent, DropdownItem, DropdownSeparator, Tooltip,
} from '@/components/ui/overlays'
import { DataTable } from '@/components/shared/DataTable'
import { ProductTile } from '@/illustrations/productIcons'
import type { Product, Variant } from '@/types'
import { fmtINR } from '@/lib/utils'

/* ── Local helpers ─────────────────────────────────────────── */
const ICON_POOL = ['milk', 'paneer', 'ghee', 'curd', 'butter', 'lassi', 'buttermilk', 'cream', 'cheese', 'khoya', 'flavored_milk'] as const
const iconFor = (seed: string): (typeof ICON_POOL)[number] => {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return ICON_POOL[Math.abs(h) % ICON_POOL.length]!
}

/* ── Variant edit dialog ───────────────────────────────────── */
const variantSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  sku: z.string().min(1, 'SKU is required').max(100),
  barcode: z.string().max(100),
  baseUnit: z.enum(['PIECE', 'GRAM', 'MILLILITRE']),
})
type VariantFormValues = z.infer<typeof variantSchema>

function VariantEditDialog({ open, onOpenChange, product, variant, serverError, onSave }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  product: Product
  variant: Variant | null
  serverError: string | null
  onSave: (values: VariantFormValues) => void
}) {
  const { register, handleSubmit, control, reset, formState: { errors } } = useForm<VariantFormValues>({
    resolver: zodResolver(variantSchema),
    defaultValues: { name: '', sku: '', barcode: '', baseUnit: 'PIECE' },
  })
  useEffect(() => {
    if (open && variant) reset({ name: variant.name, sku: variant.sku, barcode: variant.barcode ?? '', baseUnit: variant.baseUnit })
    if (open && !variant) reset({ name: '', sku: '', barcode: '', baseUnit: 'PIECE' })
  }, [open, variant, reset])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={variant ? `Edit ${product.name} – ${variant.name}` : `Add variant to ${product.name}`} description="SKU and barcode must be real values — nothing is generated">
        <form onSubmit={handleSubmit(onSave)} className="space-y-3">
          <Field label="Name" required error={errors.name?.message}><Input {...register('name')} placeholder="e.g. 500 ml pouch" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SKU" required error={errors.sku?.message}><Input {...register('sku')} className="font-mono" /></Field>
            <Field label="Base unit">
              <Controller control={control} name="baseUnit" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} options={[
                  { value: 'PIECE', label: 'Piece' }, { value: 'GRAM', label: 'Gram' }, { value: 'MILLILITRE', label: 'Millilitre' },
                ]} />
              )} />
            </Field>
          </div>
          <Field label="Barcode" error={errors.barcode?.message}><Input {...register('barcode')} className="font-mono" placeholder="EAN/UPC" /></Field>
          {serverError && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{serverError}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" size="md"><Save className="h-4 w-4" /> {variant ? 'Save variant' : 'Add variant'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ── Add/Edit product dialog ───────────────────────────────── */
const productSchema = z.object({
  name: z.string().min(2, 'Product name is required'),
  categoryId: z.string().min(1, 'Pick a category'),
  brandId: z.string(),
  description: z.string().min(1, 'Description is required'),
  hsnCode: z.string().max(32),
  gstRateBps: z.coerce.number({ invalid_type_error: 'GST must be a number' }).int().min(0).max(10000),
  perishable: z.boolean(),
  expiryTracking: z.boolean(),
})
type ProductFormValues = z.infer<typeof productSchema>

function ProductFormDialog({ open, onOpenChange, initial, categories, brands, serverError, onSubmit }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: Product | null
  categories: Array<{ id: string; name: string }>
  brands: Array<{ id: string; name: string }>
  serverError: string | null
  onSubmit: (values: ProductFormValues) => void
}) {
  const { register, handleSubmit, control, reset, formState: { errors } } = useForm<ProductFormValues>({
    resolver: zodResolver(productSchema),
    defaultValues: { name: '', categoryId: '', brandId: '', description: '', hsnCode: '', gstRateBps: 0, perishable: true, expiryTracking: true },
  })
  useEffect(() => {
    if (open) {
      reset(initial
        ? { name: initial.name, categoryId: initial.categoryId, brandId: initial.brandId ?? '', description: initial.description, hsnCode: initial.hsnCode ?? '', gstRateBps: initial.gstRateBps ?? 0, perishable: initial.perishable, expiryTracking: initial.expiryTracking }
        : { name: '', categoryId: '', brandId: '', description: '', hsnCode: '', gstRateBps: 0, perishable: true, expiryTracking: true })
    }
  }, [open, initial, reset])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={initial ? `Edit ${initial.name}` : 'Add product'} wide description="Catalog entry — GST is entered in basis points (5% = 500)">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <Field label="Name" required error={errors.name?.message}><Input {...register('name')} placeholder="e.g. Organic Cow Milk" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category" required error={errors.categoryId?.message}>
              <Controller control={control} name="categoryId" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} options={categories.map((c) => ({ value: c.id, label: c.name }))} placeholder="Pick category" />
              )} />
            </Field>
            <Field label="Brand">
              <Controller control={control} name="brandId" render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange} options={[{ value: '', label: 'No brand' }, ...brands.map((b) => ({ value: b.id, label: b.name }))]} />
              )} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="HSN code" error={errors.hsnCode?.message}><Input {...register('hsnCode')} className="font-mono" /></Field>
            <Field label="GST rate (bps)" required error={errors.gstRateBps?.message} hint="500 = 5%"><Input type="number" {...register('gstRateBps')} /></Field>
          </div>
          <Field label="Description" required error={errors.description?.message}><Textarea {...register('description')} placeholder="Short customer-facing description" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Controller control={control} name="perishable" render={({ field }) => (
              <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-4 py-3">
                <div><Label className="mb-0">Perishable</Label><p className="text-xs text-muted-foreground">Needs cold-chain handling</p></div>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </div>
            )} />
            <Controller control={control} name="expiryTracking" render={({ field }) => (
              <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-4 py-3">
                <div><Label className="mb-0">Expiry tracking</Label><p className="text-xs text-muted-foreground">FEFO batches and shelf-life policy</p></div>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </div>
            )} />
          </div>
          {serverError && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{serverError}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" size="md"><Save className="h-4 w-4" /> {initial ? 'Save product' : 'Create product'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ── Product detail drawer: variants + store pricing ───────── */
function ProductDrawer({ product, variants, stores, onClose, onUpdateVariant, onAddVariant, onSetPrice, onAddAssortment, serverError }: {
  product: Product
  variants: Variant[]
  stores: Array<{ id: string; name: string }>
  onClose: () => void
  onUpdateVariant: (v: Variant, values: VariantFormValues) => void
  onAddVariant: (values: VariantFormValues) => void
  onSetPrice: (variantId: string, storeId: string, selling: number, mrp: number) => void
  onAddAssortment: (variantId: string, storeId: string) => void
  serverError: string | null
}) {
  const [editVariant, setEditVariant] = useState<Variant | null>(null)
  const [addingVariant, setAddingVariant] = useState(false)
  const [priceVariantId, setPriceVariantId] = useState(variants[0]?.id ?? '')
  const [selling, setSelling] = useState('')
  const [mrp, setMrp] = useState('')

  return (
    <Drawer open onOpenChange={(v) => { if (!v) onClose() }} width="lg" title={product.name} subtitle={`${product.perishable ? 'Perishable' : 'Shelf-stable'} · GST ${((product.gstRateBps ?? 0) / 100).toFixed(1)}%`}>
      <div className="space-y-5">
        {/* details */}
        <div className="rounded-xl border border-border/70 bg-muted/30 p-4">
          <p className="text-[13px] text-foreground/85">{product.description || 'No description yet.'}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {product.hsnCode && <Badge tone="blue">HSN {product.hsnCode}</Badge>}
            <Badge tone="violet">{product.expiryTracking ? 'Expiry tracked' : 'No expiry tracking'}</Badge>
            <Badge tone={product.published ? 'green' : 'neutral'}>{product.published ? 'Published' : 'Unpublished'}</Badge>
          </div>
        </div>

        {/* variant list */}
        <section>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-[13px] font-bold uppercase tracking-wide text-muted-foreground">Variants ({variants.length})</h4>
            <Button size="sm" variant="outline" onClick={() => setAddingVariant(true)}><Plus className="h-3.5 w-3.5" /> Add variant</Button>
          </div>
          <div className="space-y-1.5">
            {variants.length === 0 && <p className="rounded-xl border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">No variants yet</p>}
            {variants.map((v) => (
              <div key={v.id} className="flex items-center gap-3 rounded-xl border border-border/70 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-semibold">{v.name}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">SKU {v.sku}{v.barcode ? ` · barcode ${v.barcode}` : ''}</p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditVariant(v)}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
              </div>
            ))}
          </div>
        </section>

        {/* store pricing */}
        <section>
          <h4 className="mb-2 flex items-center gap-2 text-[13px] font-bold uppercase tracking-wide text-muted-foreground"><StoreIcon className="h-3.5 w-3.5" /> Store listing & pricing</h4>
          {variants.length > 0 && (
            <div className="mb-2 w-72">
              <Select value={priceVariantId} onValueChange={setPriceVariantId} options={variants.map((v) => ({ value: v.id, label: `${v.name} · ${v.sku}` }))} />
            </div>
          )}
          <div className="space-y-1.5">
            {stores.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-border/70 px-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{s.name}</span>
                <Tooltip content="List this variant at the store (assortment)">
                  <span>
                    <Button size="sm" variant="outline" disabled={!priceVariantId} onClick={() => onAddAssortment(priceVariantId, s.id)}>
                      <ListChecks className="h-3.5 w-3.5" /> List
                    </Button>
                  </span>
                </Tooltip>
                <Input type="number" value={selling} onChange={(e) => setSelling(e.target.value)} placeholder="Selling ₹" className="h-8 w-28" />
                <Input type="number" value={mrp} onChange={(e) => setMrp(e.target.value)} placeholder="MRP ₹" className="h-8 w-24" />
                <Button size="sm" variant="primary" disabled={!priceVariantId || !Number(selling) || !Number(mrp)}
                  onClick={() => onSetPrice(priceVariantId, s.id, Number(selling), Number(mrp))}>
                  <IndianRupee className="h-3.5 w-3.5" /> Set price
                </Button>
              </div>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">Listing state and current prices live in the platform; setting a price may create an approval per pricing policy.</p>
        </section>
      </div>

      <VariantEditDialog
        open={!!editVariant || addingVariant}
        onOpenChange={(v) => { if (!v) { setEditVariant(null); setAddingVariant(false) } }}
        product={product}
        variant={addingVariant ? null : editVariant}
        serverError={serverError}
        onSave={(values) => {
          if (editVariant && !addingVariant) onUpdateVariant(editVariant, values)
          else onAddVariant(values)
          setEditVariant(null); setAddingVariant(false)
        }}
      />
    </Drawer>
  )
}

/* ── CSV import dialog (real backend flow: target → upload → dry run → approve) ── */
function CatalogImportDialog({ open, onOpenChange, stores }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  stores: Array<{ id: string; name: string }>
}) {
  const [file, setFile] = useState<File | null>(null)
  const [storeId, setStoreId] = useState(stores[0]?.id ?? '')
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'polling' | 'done' | 'error'>('idle')
  const [import_, setImport] = useState<CatalogImport | null>(null)
  const [error, setError] = useState('')
  const [dryRun, setDryRun] = useState(true)

  useEffect(() => {
    if (!open || !import_ || phase !== 'polling') return
    const t = setInterval(() => {
      void getCatalogImport(import_.id).then((res) => {
        setImport(res)
        if (res.status === 'COMPLETED' || res.status === 'FAILED' || res.status === 'AWAITING_APPROVAL') setPhase('done')
      }).catch(() => {})
    }, 1500)
    return () => clearInterval(t)
  }, [open, import_, phase])

  const start = async () => {
    if (!file || !storeId) return
    setPhase('uploading'); setError('')
    try {
      const target = await createCatalogMediaTarget('CATALOG_IMPORT', file.type || 'text/csv', file.size)
      await uploadToTarget(target, file)
      const { id } = await createCatalogImport(target.mediaId, storeId, dryRun)
      setImport({ id, status: 'QUEUED', dryRun, rowsTotal: 0, checkpoint: 0, errors: [], approvalId: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      setPhase('polling')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Import could not be started')
      setPhase('error')
    }
  }

  const approve = async () => {
    if (!import_?.approvalId) return
    try {
      await approveCatalogImport(import_.approvalId)
      toast.success('Import approved — applying rows')
      setPhase('polling')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approval failed')
    }
  }

  const statusLabel = (s: CatalogImport['status']) => s.toLowerCase().replace(/_/g, ' ')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Import catalog from CSV" description="The file uploads to private media and rows are processed server-side (dry run first)" wide>
        <div className="space-y-3">
          <Field label="Target store" required>
            <Select value={storeId} onValueChange={setStoreId} options={stores.map((s) => ({ value: s.id, label: s.name }))} />
          </Field>
          <Field label="CSV file" required hint="Headers: name, category, brand, sku, barcode, base_unit, selling_paise, mrp_paise, …">
            <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="w-full rounded-xl border border-input bg-card px-3 py-2 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary-soft file:px-3 file:py-1.5 file:text-xs file:font-bold file:text-brand-700" />
          </Field>
          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div><Label className="mb-0">Dry run first</Label><p className="text-xs text-muted-foreground">Validate rows without applying — approve separately</p></div>
            <Switch checked={dryRun} onCheckedChange={setDryRun} />
          </div>

          {phase === 'polling' && (
            <div className="rounded-xl border border-border bg-muted/30 p-4 text-[13px]">
              <p className="font-semibold">Import {import_?.id.slice(0, 8)}… · status <Badge tone="blue">{statusLabel(import_?.status ?? 'QUEUED')}</Badge></p>
              <p className="mt-1 text-xs text-muted-foreground">{import_?.checkpoint ?? 0}/{import_?.rowsTotal ?? 0} rows processed</p>
              <div className="mt-2 space-y-1">
                {(import_?.errors ?? []).slice(0, 5).map((e, i) => (
                  <p key={i} className="text-xs font-medium text-destructive">Row {e.row}: {e.code}</p>
                ))}
              </div>
              {(import_?.errors ?? []).length > 0 && import_ && (
                <a href={`/v1/admin/catalog/imports/${import_.id}/report`} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs font-bold text-brand-700 hover:underline dark:text-brand-300">Download error report (CSV)</a>
              )}
            </div>
          )}
          {phase === 'done' && import_?.status === 'AWAITING_APPROVAL' && (
            <div className="rounded-xl border border-amber-200 bg-warning-soft p-4 dark:border-amber-500/30">
              <p className="text-[13px] font-bold text-amber-800 dark:text-amber-200">Dry run validated — approval required</p>
              <Button size="sm" variant="primary" className="mt-2" onClick={() => void approve()}>Approve import</Button>
            </div>
          )}
          {phase === 'done' && import_?.status === 'COMPLETED' && <p className="rounded-xl bg-success-soft px-3 py-2 text-[13px] font-bold text-success">Import completed</p>}
          {phase === 'done' && import_?.status === 'FAILED' && <p className="rounded-xl bg-destructive-soft px-3 py-2 text-[13px] font-bold text-destructive">Import failed — check the error report</p>}
          {error && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="md" onClick={() => onOpenChange(false)}>Close</Button>
            <Button size="md" variant="primary" disabled={!file || !storeId || phase === 'uploading' || phase === 'polling'} onClick={() => void start()}>
              <FileUp className="h-4 w-4" /> {phase === 'uploading' ? 'Uploading…' : phase === 'polling' ? 'Processing…' : 'Start import'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ── Page ──────────────────────────────────────────────────── */
const PAGE_SIZE = 12

export function Products() {
  const container = useStagger()
  const actions = useProductActions()
  const [serverError, setServerError] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null])

  const productsQ = useProducts(PAGE_SIZE, cursor ?? undefined)
  const variantsQ = useVariants(100)
  const categoriesQ = useCategories()
  const brandsQ = useBrands()
  const storesQ = useStores()

  const rows = productsQ.data?.items ?? []
  const variants = variantsQ.data ?? []
  const categories = categoriesQ.data ?? []
  const brands = brandsQ.data ?? []
  const stores = storesQ.data ?? []

  // client-side search over the loaded page (server list has no search param)
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    const vs = variants.filter((v) => v.sku.toLowerCase().includes(q) || v.name.toLowerCase().includes(q)).map((v) => v.productId)
    return rows.filter((p) => p.name.toLowerCase().includes(q) || vs.includes(p.id))
  }, [rows, search, variants])

  useEffect(() => {
    setCursor(null)
    setCursorStack([null])
  }, [search])

  const goNext = () => {
    const nc = productsQ.data?.nextCursor ?? null
    if (!nc) return
    setCursorStack((st) => [...st, nc]); setCursor(nc)
  }
  const goPrev = () => {
    setCursorStack((st) => {
      if (st.length <= 1) return st
      const next = st.slice(0, -1)
      setCursor(next[next.length - 1] ?? null)
      return next
    })
  }

  const [formOpen, setFormOpen] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [detail, setDetail] = useState<Product | null>(null)
  const [publishTarget, setPublishTarget] = useState<Product | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null)
  const [csvOpen, setCsvOpen] = useState(false)

  const detailProduct = detail ? rows.find((p) => p.id === detail.id) ?? detail : null
  // Drawer variants come straight from the server (productId filter) with the
  // global page as fallback when the drawer is closed.
  const drawerVariantsQ = useVariants(100, detailProduct?.id, !!detailProduct)
  const detailVariants = detailProduct
    ? (drawerVariantsQ.data ?? variants.filter((v) => v.productId === detailProduct.id))
    : []

  const catName = (id: string) => categories.find((c) => c.id === id)?.name ?? '—'
  const brandName = (id: string | null) => (id ? brands.find((b) => b.id === id)?.name ?? '—' : 'No brand')

  return (
    <div className="space-y-5">
      <PageHeader
        title="Products &"
        titleAccent="pricing"
        subtitle="Catalog, pack sizes, store-level pricing and the approval flow for sensitive changes."
        artwork="products"
        breadcrumb={['Products']}
      />

      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-4">
        <motion.section variants={container.item} className="flex flex-wrap items-center gap-2.5">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by name or SKU…" className="min-w-[220px] flex-1" />
          <Button variant="primary" size="md" onClick={() => { setEditingProduct(null); setFormOpen(true) }}>
            <Plus className="h-4 w-4" /> Add Product
          </Button>
          <Button variant="secondary" size="md" onClick={() => setCsvOpen(true)}>
            <FileUp className="h-4 w-4" /> CSV import
          </Button>
        </motion.section>

        <motion.section variants={container.item} className="space-y-3">
          <Card className="overflow-hidden">
            <DataTable
              keyId={(p) => p.id}
              rows={filtered}
              loading={productsQ.isLoading}
              onRowClick={(p) => setDetail(p)}
              empty={<EmptyState icon={Package} title="No products match" body="Try a different search or clear the filter." />}
              columns={[
                {
                  key: 'name', header: 'Product',
                  render: (p: Product) => (
                    <div className="flex items-center gap-3">
                      <ProductTile icon={iconFor(p.id)} />
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{p.name}</p>
                        <p className="truncate text-xs text-muted-foreground">{catName(p.categoryId)} · {brandName(p.brandId)}</p>
                      </div>
                    </div>
                  ),
                },
                {
                  key: 'variants', header: 'Variants',
                  render: (p: Product) => {
                    const vs = variants.filter((v) => v.productId === p.id)
                    return (
                      <div className="flex max-w-[260px] flex-wrap gap-1.5">
                        {vs.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                        {vs.map((v) => (
                          <Badge key={v.id} tone="neutral" className="max-w-full gap-1.5">
                            <span className="truncate">{v.name}</span>
                            <span className="font-mono text-[9.5px] opacity-60">{v.sku}</span>
                          </Badge>
                        ))}
                      </div>
                    )
                  },
                },
                { key: 'gst', header: 'GST', render: (p: Product) => <span className="tabular">{p.gstRateBps != null ? `${(p.gstRateBps / 100).toFixed(1)}%` : '—'}</span> },
                { key: 'perishable', header: 'Type', render: (p: Product) => <span className="text-[13px]">{p.perishable ? 'Perishable' : 'Shelf-stable'}</span> },
                { key: 'state', header: 'State', render: (p: Product) => <StatusPill status={p.published ? 'published' : 'unpublished'} /> },
                {
                  key: 'actions', header: '', align: 'right' as const,
                  render: (p: Product) => (
                    <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="iconSm" variant="ghost" aria-label={`Actions for ${p.name}`}><MoreVertical className="h-4 w-4" /></Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                          <DropdownItem onSelect={() => { setEditingProduct(p); setFormOpen(true) }}><Pencil className="h-3.5 w-3.5" /> Edit product</DropdownItem>
                          <DropdownItem onSelect={() => setDetail(p)}><Package className="h-3.5 w-3.5" /> Manage variants & pricing</DropdownItem>
                          <DropdownSeparator />
                          {p.published ? (
                            <DropdownItem onSelect={() => setPublishTarget(p)}><EyeOff className="h-3.5 w-3.5" /> Unpublish</DropdownItem>
                          ) : (
                            <DropdownItem onSelect={() => setPublishTarget(p)}><Eye className="h-3.5 w-3.5" /> Publish</DropdownItem>
                          )}
                          <DropdownItem danger onSelect={() => setDeleteTarget(p)}><Trash2 className="h-3.5 w-3.5" /> Delete</DropdownItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ),
                },
              ]}
            />
            {/* cursor pagination */}
            <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
              <span className="text-xs text-muted-foreground">Page {cursorStack.length} of the catalog feed</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={cursorStack.length <= 1 || productsQ.isLoading} onClick={goPrev}>
                  <ChevronLeft className="h-3.5 w-3.5" /> Prev
                </Button>
                <Button size="sm" variant="outline" disabled={!productsQ.data?.nextCursor || productsQ.isLoading} onClick={goNext}>
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </Card>
        </motion.section>
      </motion.div>

      {/* detail drawer */}
      {detailProduct && (
        <ProductDrawer
          key={detailProduct.id}
          product={detailProduct}
          variants={detailVariants}
          stores={stores.map((s) => ({ id: s.id, name: s.name }))}
          onClose={() => setDetail(null)}
          serverError={serverError}
          onUpdateVariant={(v, values) => actions.updateVariant(v.id, { name: values.name, productId: detailProduct.id, sku: values.sku, barcode: values.barcode || undefined, baseUnit: values.baseUnit }, `${detailProduct.name} – ${values.name}`).mutate(undefined, {
            onError: (e) => setServerError(e.message),
            onSuccess: () => setServerError(null),
          })}
          onAddVariant={(values) => actions.addVariant({ name: values.name, productId: detailProduct.id, sku: values.sku, barcode: values.barcode || undefined, baseUnit: values.baseUnit }).mutate(undefined, {
            onError: (e) => setServerError(e.message),
            onSuccess: () => setServerError(null),
          })}
          onSetPrice={(variantId, storeId, selling, mrp) => actions.setPrice(storeId, variantId, selling, mrp).mutate(undefined, {
            onError: (e) => setServerError(e.message),
            onSuccess: (res) => {
              setServerError(null)
              if (res?.approvalId) toast.info('Price change sent for approval')
            },
          })}
          onAddAssortment={(variantId, storeId) => actions.addAssortment(storeId, variantId).mutate(undefined, {
            onError: (e) => setServerError(e.message),
            onSuccess: () => setServerError(null),
          })}
        />
      )}

      {/* add / edit */}
      <ProductFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        initial={editingProduct}
        categories={categories}
        brands={brands}
        serverError={serverError}
        onSubmit={(v) => {
          const payload = {
            name: v.name,
            categoryId: v.categoryId,
            brandId: v.brandId || null,
            description: v.description,
            hsnCode: v.hsnCode || null,
            gstRateBps: v.gstRateBps,
            perishable: v.perishable,
            expiryTracking: v.expiryTracking,
          }
          if (editingProduct) {
            actions.updateProduct(editingProduct.id, payload, editingProduct.name).mutate(undefined, {
              onError: (e) => setServerError(e.message),
              onSuccess: () => { setServerError(null); setFormOpen(false) },
            })
          } else {
            actions.addProduct(payload).mutate(undefined, {
              onError: (e) => setServerError(e.message),
              onSuccess: () => { setServerError(null); setFormOpen(false) },
            })
          }
        }}
      />

      {/* publish / unpublish */}
      <ConfirmDialog
        open={!!publishTarget}
        onOpenChange={(v) => { if (!v) setPublishTarget(null) }}
        title={publishTarget?.published ? `Unpublish ${publishTarget?.name}?` : `Publish ${publishTarget?.name}?`}
        description={publishTarget?.published
          ? 'The product disappears from the storefront immediately. Existing subscriptions keep working.'
          : 'The product goes live on the storefront in all stores that carry it.'}
        confirmLabel={publishTarget?.published ? 'Unpublish' : 'Publish'}
        destructive={publishTarget?.published}
        onConfirm={() => {
          if (publishTarget) actions.publishProduct(publishTarget.id, publishTarget.name, !publishTarget.published).mutate(undefined, { onError: (e) => setServerError(e.message) })
          setPublishTarget(null)
        }}
      />

      {/* delete */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => { if (!v) setDeleteTarget(null) }}
        title={`Delete ${deleteTarget?.name}?`}
        description="The product and all its variants are removed from the catalog. Past orders keep their line items."
        confirmLabel="Delete product"
        destructive
        onConfirm={() => { if (deleteTarget) actions.deleteProduct(deleteTarget.id, deleteTarget.name).mutate(undefined, { onError: (e) => setServerError(e.message) }); setDeleteTarget(null) }}
      />

      {/* CSV import (server-side) */}
      <CatalogImportDialog open={csvOpen} onOpenChange={setCsvOpen} stores={stores.map((s) => ({ id: s.id, name: s.name }))} />
    </div>
  )
}

export default Products

