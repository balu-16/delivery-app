// ── §9 Offers & notifications (REAL API: coupons CRUD, push campaigns, inbox) ─
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Plus, MoreVertical, Pencil, Ticket, Megaphone, Bell, ChevronLeft, ChevronRight,
  Send, Eye, CheckCheck,
} from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import { useCoupons, useCampaigns, useInbox, useCategories, useStores, useProducts } from '@/hooks/queries'
import { useOfferActions } from '@/hooks/mutations'
import { rupeesToPaise } from '@/api/money'
import { timeAgo } from '@/lib/utils'
import { PageHeader, TabPills, SearchInput, StatusPill, EmptyState } from '@/components/shared/misc'
import { Select, Field } from '@/components/ui/form'
import { Button, Card, Badge, Input, Switch, Textarea, Label } from '@/components/ui/base'
import {
  Dialog, DialogContent, Drawer, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownItem, Tooltip,
} from '@/components/ui/overlays'
import { DataTable } from '@/components/shared/DataTable'
import type { AdminNotification, Coupon, CouponKind, PushCampaign } from '@/types'
import { fmtDateTime, fmtINR } from '@/lib/utils'

type MainTab = 'coupons' | 'campaigns' | 'inbox'
type CouponKindUi = 'percent' | 'flat' | 'free_delivery'

/* ── Coupon form ───────────────────────────────────────────── */
type CouponFormValues = {
  code: string; kind: CouponKindUi; valuePercent: number; valueRupees: number
  maxCapRupees: number; minOrderRupees: number; perUserLimit: number; globalLimit: number
  storeId: string; categoryId: string; productId: string; stackable: boolean; firstOrderOnly: boolean
}

function CouponFormDialog({ open, onOpenChange, initial, categories, stores, products, serverError, onSubmit }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial: Coupon | null
  categories: Array<{ id: string; name: string }>
  stores: Array<{ id: string; name: string }>
  products: Array<{ id: string; name: string }>
  serverError: string | null
  onSubmit: (values: CouponFormValues) => void
}) {
  const [v, setV] = useState<CouponFormValues>({
    code: '', kind: 'flat', valuePercent: 10, valueRupees: 50, maxCapRupees: 0,
    minOrderRupees: 199, perUserLimit: 1, globalLimit: 0, storeId: '', categoryId: '', productId: '',
    stackable: false, firstOrderOnly: false,
  })
  useEffect(() => {
    if (!open) return
    if (initial) {
      setV({
        code: initial.code,
        kind: initial.kind,
        valuePercent: initial.kind === 'percent' ? initial.value : 10,
        valueRupees: initial.kind === 'flat' ? initial.value : 50,
        maxCapRupees: initial.maxCap ?? 0,
        minOrderRupees: initial.minOrder,
        perUserLimit: initial.perUserLimit ?? 0,
        globalLimit: initial.globalLimit ?? 0,
        storeId: initial.storeId ?? '',
        categoryId: initial.categoryId ?? '',
        productId: initial.productId ?? '',
        stackable: initial.stackable,
        firstOrderOnly: initial.firstOrderOnly,
      })
    } else {
      setV({ code: '', kind: 'flat', valuePercent: 10, valueRupees: 50, maxCapRupees: 0, minOrderRupees: 199, perUserLimit: 1, globalLimit: 0, storeId: '', categoryId: '', productId: '', stackable: false, firstOrderOnly: false })
    }
  }, [open, initial])

  const set = <K extends keyof CouponFormValues>(k: K, value: CouponFormValues[K]) => setV((s) => ({ ...s, [k]: value }))
  const codeInvalid = !/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(v.code)
  const valueInvalid = v.kind === 'percent' ? v.valuePercent <= 0 || v.valuePercent > 100 : v.kind === 'flat' ? v.valueRupees <= 0 : false

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={initial ? `Edit coupon ${initial.code}` : 'Create coupon'} description="Validation and supported types come from the server — unsupported combinations are rejected on submit" wide>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Code" required error={v.code && codeInvalid ? '3–40 chars, letters/digits/_/-' : undefined}>
            <Input value={v.code} onChange={(e) => set('code', e.target.value.toUpperCase())} className="font-mono" placeholder="FREEDLY" />
          </Field>
          <Field label="Type" required hint="Only types the backend accepts are kept">
            <Select value={v.kind} onValueChange={(val) => set('kind', val as CouponKindUi)} options={[
              { value: 'flat', label: 'Flat ₹ off' },
              { value: 'percent', label: 'Percent off' },
              { value: 'free_delivery', label: 'Free delivery' },
            ]} />
          </Field>
          {v.kind === 'percent' && (
            <Field label="Percent off" required error={valueInvalid ? '1–100' : undefined}>
              <Input type="number" value={v.valuePercent} onChange={(e) => set('valuePercent', Number(e.target.value))} />
            </Field>
          )}
          {v.kind === 'flat' && (
            <Field label="Flat discount (₹)" required error={valueInvalid ? 'Must be positive' : undefined}>
              <Input type="number" value={v.valueRupees} onChange={(e) => set('valueRupees', Number(e.target.value))} />
            </Field>
          )}
          {v.kind === 'percent' && (
            <Field label="Max cap (₹, 0 = none)">
              <Input type="number" value={v.maxCapRupees} onChange={(e) => set('maxCapRupees', Number(e.target.value))} />
            </Field>
          )}
          <Field label="Minimum order (₹)" required>
            <Input type="number" value={v.minOrderRupees} onChange={(e) => set('minOrderRupees', Number(e.target.value))} />
          </Field>
          <Field label="Per-user limit (0 = none)">
            <Input type="number" value={v.perUserLimit} onChange={(e) => set('perUserLimit', Number(e.target.value))} />
          </Field>
          <Field label="Global limit (0 = none)">
            <Input type="number" value={v.globalLimit} onChange={(e) => set('globalLimit', Number(e.target.value))} />
          </Field>
          <Field label="Scoped store (optional)">
            <Select value={v.storeId} onValueChange={(val) => set('storeId', val)} options={[{ value: '', label: 'All stores' }, ...stores.map((s) => ({ value: s.id, label: s.name }))]} />
          </Field>
          <Field label="Scoped category (optional)">
            <Select value={v.categoryId} onValueChange={(val) => set('categoryId', val)} options={[{ value: '', label: 'All categories' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]} />
          </Field>
          <Field label="Scoped product (optional)">
            <Select value={v.productId} onValueChange={(val) => set('productId', val)} options={[{ value: '', label: 'All products' }, ...products.map((p) => ({ value: p.id, label: p.name }))]} />
          </Field>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div><Label className="mb-0">Stackable</Label><p className="text-xs text-muted-foreground">Can combine with other offers</p></div>
            <Switch checked={v.stackable} onCheckedChange={(val) => set('stackable', val)} />
          </div>
          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div><Label className="mb-0">First order only</Label><p className="text-xs text-muted-foreground">New customers only</p></div>
            <Switch checked={v.firstOrderOnly} onCheckedChange={(val) => set('firstOrderOnly', val)} />
          </div>
        </div>
        {serverError && <p className="mt-3 rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{serverError}</p>}
        <div className="mt-3 flex justify-end gap-2 pt-1">
          <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" size="md" disabled={codeInvalid || valueInvalid} onClick={() => onSubmit(v)}>
            <Ticket className="h-4 w-4" /> {initial ? 'Save coupon' : 'Create coupon'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ── Campaign dialog (preview → create) ────────────────────── */
function CampaignDialog({ open, onOpenChange, onCreate }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreate: (input: { title: string; body: string; kind: 'PROMOTIONAL' | 'OPERATIONAL'; target: { mode: 'ALL' | 'USERS'; apps: Array<'CUSTOMER' | 'RIDER' | 'STORE' | 'ADMIN'> } }, estimated: number | null) => void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<'PROMOTIONAL' | 'OPERATIONAL'>('PROMOTIONAL')
  const [apps, setApps] = useState<Array<'CUSTOMER' | 'RIDER' | 'STORE' | 'ADMIN'>>(['CUSTOMER'])
  const [estimated, setEstimated] = useState<number | null>(null)
  const [previewing, setPreviewing] = useState(false)

  const invalid = title.trim().length < 1 || body.trim().length < 1 || apps.length === 0

  const preview = async () => {
    setPreviewing(true)
    try {
      const { previewCampaign } = await import('@/api/offers')
      const res = await previewCampaign({ target: { mode: 'ALL', apps }, kind })
      setEstimated(res.estimatedRecipients)
    } catch {
      setEstimated(null)
    } finally {
      setPreviewing(false)
    }
  }

  useEffect(() => {
    if (open) { setTitle(''); setBody(''); setKind('PROMOTIONAL'); setApps(['CUSTOMER']); setEstimated(null) }
  }, [open])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New push campaign" description="Preview the audience server-side, then create — delivery is handled by the notifications service">
        <div className="space-y-3">
          <Field label="Title" required><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} /></Field>
          <Field label="Body" required><Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={500} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Kind" required>
              <Select value={kind} onValueChange={(v) => setKind(v as 'PROMOTIONAL' | 'OPERATIONAL')} options={[
                { value: 'PROMOTIONAL', label: 'Promotional' }, { value: 'OPERATIONAL', label: 'Operational' },
              ]} />
            </Field>
            <Field label="Audience apps" required hint="Target apps for the push">
              <div className="flex flex-wrap gap-3 pt-1">
                {(['CUSTOMER', 'RIDER', 'STORE', 'ADMIN'] as const).map((a) => (
                  <label key={a} className="flex cursor-pointer items-center gap-1.5 text-[12.5px] font-semibold">
                    <input
                      type="checkbox"
                      checked={apps.includes(a)}
                      onChange={(e) => setApps((cur) => (e.target.checked ? [...cur, a] : cur.filter((x) => x !== a)))}
                      className="h-4 w-4 rounded border-input accent-[#2E7D1A]"
                    />
                    {a.toLowerCase()}
                  </label>
                ))}
              </div>
            </Field>
          </div>
          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div>
              <Label className="mb-0">Estimated audience</Label>
              <p className="text-xs text-muted-foreground">{estimated == null ? 'Run the preview to fetch a server-side count' : `${estimated.toLocaleString('en-IN')} devices match`}</p>
            </div>
            <Button size="sm" variant="outline" disabled={invalid || previewing} onClick={() => void preview()}>
              <Send className="h-3.5 w-3.5" /> {previewing ? 'Previewing…' : 'Preview'}
            </Button>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" disabled={invalid} onClick={() => { onCreate({ title: title.trim(), body: body.trim(), kind, target: { mode: 'ALL', apps } }, estimated); onOpenChange(false) }}>
              <Megaphone className="h-4 w-4" /> Create campaign
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ── Campaign detail drawer ────────────────────────────────── */
function CampaignDrawer({ campaign, onClose }: { campaign: PushCampaign; onClose: () => void }) {
  return (
    <Drawer open onOpenChange={(v) => { if (!v) onClose() }} width="md" title={campaign.title} subtitle={`${campaign.kind} · created ${fmtDateTime(campaign.createdAt)}`}>
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="blue">{campaign.kind}</Badge>
          <Badge tone="neutral">{campaign.target.mode}</Badge>
          {campaign.target.apps.map((a) => <Badge key={a} tone="violet">{a.toLowerCase()}</Badge>)}
        </div>
        <div className="rounded-xl border border-border/70 bg-muted/30 p-4">
          <p className="text-[13px] text-foreground/85">{campaign.body}</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl border border-border/70 p-4 text-[13px]">
          <div className="flex gap-2"><dt className="font-semibold text-muted-foreground">Recipients:</dt><dd className="font-bold tabular">{campaign.recipients ?? '—'}</dd></div>
          <div className="flex gap-2"><dt className="font-semibold text-muted-foreground">Created:</dt><dd className="font-medium">{fmtDateTime(campaign.createdAt)}</dd></div>
        </dl>
        <p className="text-[11px] text-muted-foreground">Per-device delivery state is tracked by the notifications service.</p>
      </div>
    </Drawer>
  )
}

export function Offers() {
  const container = useStagger()
  const actions = useOfferActions()
  const [serverError, setServerError] = useState<string | null>(null)
  const [tab, setTab] = useState<MainTab>('coupons')

  const couponsQ = useCoupons()
  const campaignsQ = useCampaigns()
  const inboxQ = useInbox()
  const categoriesQ = useCategories()
  const storesQ = useStores()
  const productsQ = useProducts(100)

  const coupons: Coupon[] = couponsQ.data?.items ?? []
  const campaigns: PushCampaign[] = campaignsQ.data?.items ?? []
  const inbox: AdminNotification[] = inboxQ.data?.items ?? []
  const categories = categoriesQ.data ?? []
  const stores = storesQ.data ?? []
  const products = productsQ.data?.items ?? []

  const [couponSearch, setCouponSearch] = useState('')
  const filteredCoupons = coupons.filter((c) => c.code.toLowerCase().includes(couponSearch.trim().toLowerCase()))

  const [couponFormOpen, setCouponFormOpen] = useState(false)
  const [editingCoupon, setEditingCoupon] = useState<Coupon | null>(null)
  const [campaignOpen, setCampaignOpen] = useState(false)
  const [campaignDetail, setCampaignDetail] = useState<PushCampaign | null>(null)

  const submitCoupon = (values: CouponFormValues) => {
    const kindMap: Record<CouponKindUi, 'PERCENT' | 'FLAT' | 'FREE_DELIVERY'> = { percent: 'PERCENT', flat: 'FLAT', free_delivery: 'FREE_DELIVERY' }
    if (editingCoupon) {
      actions.updateCoupon(editingCoupon.id, {
        minOrderPaise: rupeesToPaise(values.minOrderRupees),
        perUserLimit: values.perUserLimit > 0 ? values.perUserLimit : null,
        globalLimit: values.globalLimit > 0 ? values.globalLimit : null,
        active: editingCoupon.active,
        expectedVersion: editingCoupon.version,
      }, values.code).mutate(undefined, {
        onError: (e) => setServerError(e.message),
        onSuccess: () => { setServerError(null); setCouponFormOpen(false) },
      })
    } else {
      actions.addCoupon({
        code: values.code,
        kind: kindMap[values.kind],
        valuePaise: values.kind === 'percent' ? String(Math.round(values.valuePercent * 100)) : rupeesToPaise(values.kind === 'flat' ? values.valueRupees : values.minOrderRupees),
        maxCapPaise: values.kind === 'percent' && values.maxCapRupees > 0 ? rupeesToPaise(values.maxCapRupees) : undefined,
        minOrderPaise: rupeesToPaise(values.minOrderRupees),
        perUserLimit: values.perUserLimit > 0 ? values.perUserLimit : undefined,
        globalLimit: values.globalLimit > 0 ? values.globalLimit : undefined,
        storeId: values.storeId || undefined,
        categoryId: values.categoryId || undefined,
        productId: values.productId || undefined,
        stackable: values.stackable,
        firstOrderOnly: values.firstOrderOnly,
      }).mutate(undefined, {
        onError: (e) => setServerError(e.message),
        onSuccess: () => { setServerError(null); setCouponFormOpen(false) },
      })
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Offers &"
        titleAccent="notifications"
        subtitle="Coupons, push campaigns and your own admin inbox."
        artwork="offers"
        breadcrumb={['Offers']}
        actions={(
          <div className="flex flex-wrap items-center gap-2.5">
            {tab === 'coupons' && (
              <Button variant="primary" size="md" onClick={() => { setEditingCoupon(null); setCouponFormOpen(true) }}>
                <Plus className="h-4 w-4" /> Add coupon
              </Button>
            )}
            {tab === 'campaigns' && (
              <Button variant="primary" size="md" onClick={() => setCampaignOpen(true)}>
                <Megaphone className="h-4 w-4" /> New campaign
              </Button>
            )}
          </div>
        )}
      />

      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-4">
        <motion.div variants={container.item}>
          <TabPills
            id="offers-tabs"
            value={tab}
            onChange={(v) => setTab(v as MainTab)}
            tabs={[
              { value: 'coupons', label: 'Coupons', count: coupons.length },
              { value: 'campaigns', label: 'Push campaigns', count: campaigns.length },
              { value: 'inbox', label: 'My notifications', count: inbox.filter((n) => !n.readAt).length },
            ]}
          />
        </motion.div>

        {/* ── COUPONS ── */}
        {tab === 'coupons' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <SearchInput value={couponSearch} onChange={setCouponSearch} placeholder="Search coupon code…" className="min-w-[220px] flex-1" />
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(c) => c.id}
                rows={filteredCoupons}
                loading={couponsQ.isLoading}
                empty={<EmptyState icon={Ticket} title="No coupons" body="Create the first coupon for the storefront." />}
                columns={[
                  { key: 'code', header: 'Code', render: (c: Coupon) => <span className="font-mono text-[13px] font-bold">{c.code}</span> },
                  {
                    key: 'value', header: 'Value',
                    render: (c: Coupon) => c.kind === 'percent' ? `${c.value}% off` : c.kind === 'flat' ? `${fmtINR(c.value)} off` : 'Free delivery',
                  },
                  { key: 'min', header: 'Min order', render: (c: Coupon) => <span className="tabular">{fmtINR(c.minOrder)}</span> },
                  { key: 'limits', header: 'Limits', render: (c: Coupon) => <span className="text-[13px] text-muted-foreground">{c.perUserLimit ? `${c.perUserLimit}/user` : '—'}{c.globalLimit ? ` · ${c.globalLimit} total` : ''}</span> },
                  { key: 'active', header: 'State', render: (c: Coupon) => <StatusPill status={c.active ? 'active' : 'inactive'} dot /> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (c: Coupon) => (
                      <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <Button size="sm" variant="ghost" onClick={() => { setEditingCoupon(c); setCouponFormOpen(true) }}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                        <Button size="sm" variant="outline" onClick={() => actions.updateCoupon(c.id, { active: !c.active, expectedVersion: c.version }, c.code).mutate(undefined, { onError: (e) => setServerError(e.message) })}>
                          {c.active ? 'Deactivate' : 'Activate'}
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          </motion.section>
        )}

        {/* ── CAMPAIGNS ── */}
        {tab === 'campaigns' && (
          <motion.section variants={container.item} className="space-y-3">
            <Card className="overflow-hidden">
              <DataTable
                keyId={(c) => c.id}
                rows={campaigns}
                loading={campaignsQ.isLoading}
                onRowClick={(c) => setCampaignDetail(c)}
                empty={<EmptyState icon={Megaphone} title="No campaigns yet" body="Create the first push campaign." />}
                columns={[
                  {
                    key: 'title', header: 'Campaign',
                    render: (c: PushCampaign) => (
                      <div className="min-w-0">
                        <p className="truncate font-semibold">{c.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{c.body}</p>
                      </div>
                    ),
                  },
                  { key: 'kind', header: 'Kind', render: (c: PushCampaign) => <Badge tone={c.kind === 'promotional' ? 'violet' : 'blue'}>{c.kind}</Badge> },
                  { key: 'audience', header: 'Audience', render: (c: PushCampaign) => <span className="text-[13px]">{c.target.apps.join(', ').toLowerCase()}</span> },
                  { key: 'recipients', header: 'Recipients', render: (c: PushCampaign) => <span className="tabular">{c.recipients ?? '—'}</span> },
                  { key: 'created', header: 'Created', render: (c: PushCampaign) => <span className="whitespace-nowrap text-[13px]">{fmtDateTime(c.createdAt)}</span> },
                ]}
              />
            </Card>
          </motion.section>
        )}

        {/* ── INBOX ── */}
        {tab === 'inbox' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex justify-end">
              <Button variant="outline" size="md" onClick={() => actions.markNotificationRead().mutate(undefined, { onError: () => {} })}>
                <CheckCheck className="h-4 w-4" /> Mark all read
              </Button>
            </div>
            <Card className="divide-y divide-border/60">
              {inboxQ.isLoading && <div className="space-y-2 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 w-full rounded-xl" />)}</div>}
              {!inboxQ.isLoading && inbox.length === 0 && (
                <div className="p-8"><EmptyState icon={Bell} title="You're all caught up" body="Operational notifications will appear here." /></div>
              )}
              {inbox.map((n) => (
                <div key={n.id} className={`flex items-start gap-3 p-4 ${n.readAt ? '' : 'bg-primary-softer/70'}`}>
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-muted text-base">
                    <Bell className="h-4 w-4 text-muted-foreground" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13px] font-semibold">
                      <span className="truncate">{n.title}</span>
                      <Badge tone="neutral">{n.category.toLowerCase().replace(/_/g, ' ')}</Badge>
                      {!n.readAt && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>
                    <p className="mt-1 text-[10px] font-medium text-muted-foreground">{timeAgo(n.createdAt, new Date())}</p>
                  </div>
                  {!n.readAt && (
                    <button onClick={() => actions.markNotificationRead(n.id).mutate(undefined, { onError: () => {} })} className="self-start text-[10px] font-semibold text-muted-foreground hover:text-foreground" aria-label={`Mark ${n.title} read`}>
                      Read
                    </button>
                  )}
                </div>
              ))}
            </Card>
          </motion.section>
        )}
      </motion.div>

      {/* dialogs + drawers */}
      <CouponFormDialog
        open={couponFormOpen}
        onOpenChange={setCouponFormOpen}
        initial={editingCoupon}
        categories={categories}
        stores={stores.map((s) => ({ id: s.id, name: s.name }))}
        products={products.map((p) => ({ id: p.id, name: p.name }))}
        serverError={serverError}
        onSubmit={submitCoupon}
      />
      <CampaignDialog
        open={campaignOpen}
        onOpenChange={setCampaignOpen}
        onCreate={(input) => actions.addCampaign({
          target: { mode: input.target.mode, apps: input.target.apps },
          kind: input.kind,
          title: input.title,
          body: input.body,
        }).mutate(undefined, { onError: (e) => setServerError(e.message) })}
      />
      {campaignDetail && <CampaignDrawer campaign={campaignDetail} onClose={() => setCampaignDetail(null)} />}
    </div>
  )
}

export default Offers
