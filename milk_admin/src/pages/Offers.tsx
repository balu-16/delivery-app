// ── §9 Offers & notifications (REAL API: coupons CRUD, push campaigns, inbox) ─
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Plus, MoreVertical, Pencil, Ticket, Megaphone, Bell, ChevronLeft, ChevronRight,
  Send, Eye, CheckCheck,
} from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import { useCoupons, useCampaigns, useCampaignDetail, useInbox, useCategories, useStores, useProducts, useUsers } from '@/hooks/queries'
import { useOfferActions, campaignAttemptKey } from '@/hooks/mutations'
import { rupeesToPaise } from '@/api/money'
import { CAMPAIGN_DESTINATIONS, type CampaignTargetInput } from '@/api/offers'
import { ApiError } from '@/api/http'
import { createCatalogMediaTarget, registerCatalogMedia, uploadToTarget } from '@/api/catalog'
import { timeAgo } from '@/lib/utils'
import { PageHeader, TabPills, tabCount, SearchInput, StatusPill, EmptyState } from '@/components/shared/misc'
import { Select, Field } from '@/components/ui/form'
import { Button, Card, Badge, Input, Switch, Textarea, Label } from '@/components/ui/base'
import {
  Dialog, DialogContent, Drawer, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownItem, Tooltip,
} from '@/components/ui/overlays'
import { DataTable } from '@/components/shared/DataTable'
import type { AdminNotification, AdminUser, Coupon, CouponKind, PushCampaign } from '@/types'
import { fmtDateTime, fmtINR } from '@/lib/utils'

type MainTab = 'coupons' | 'campaigns' | 'inbox'
type CouponKindUi = 'percent' | 'flat' | 'free_delivery'

/* ── Coupon form ───────────────────────────────────────────── */
type CouponFormValues = {
  code: string; kind: CouponKindUi; valuePercent: number; valueRupees: number
  maxCapRupees: number; minOrderRupees: number; perUserLimit: number; globalLimit: number
  storeId: string; categoryId: string; productId: string; stackable: boolean; firstOrderOnly: boolean
  validFrom: string; validTo: string
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
    stackable: false, firstOrderOnly: false, validFrom: '', validTo: '',
  })
  const toLocal = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : '')
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
        validFrom: toLocal(initial.validFrom),
        validTo: toLocal(initial.validTo),
      })
    } else {
      setV({ code: '', kind: 'flat', valuePercent: 10, valueRupees: 50, maxCapRupees: 0, minOrderRupees: 199, perUserLimit: 1, globalLimit: 0, storeId: '', categoryId: '', productId: '', stackable: false, firstOrderOnly: false, validFrom: '', validTo: '' })
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
          <Field label="Valid from (optional)">
            <Input type="datetime-local" value={v.validFrom} onChange={(e) => set('validFrom', e.target.value)} />
          </Field>
          <Field label="Valid to (optional)">
            <Input type="datetime-local" value={v.validTo} onChange={(e) => set('validTo', e.target.value)} />
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

/* ── Campaign dialog (preview → create; customize2 §3E) ───── */
type CampaignMode = 'ALL' | 'USERS' | 'PLATFORM'
type CampaignApp = 'CUSTOMER' | 'RIDER' | 'STORE' | 'ADMIN'

function memberOf(user: AdminUser, apps: CampaignApp[]): boolean {
  if (user.pool === 'CUSTOMER') return apps.includes('CUSTOMER')
  if (user.roles.includes('RIDER')) return apps.includes('RIDER')
  if (user.roles.includes('STORE_MANAGER')) return apps.includes('STORE')
  if (user.roles.includes('SUPER_ADMIN')) return apps.includes('ADMIN')
  return apps.length > 0
}

function campaignErrorText(error: unknown): string {
  if (error instanceof ApiError && error.code === 'INVALID_INPUT')
    return 'The campaign was rejected: no recipients, audience too large (>10,000 devices), or invalid target. Check the audience and preview again.'
  return error instanceof Error ? error.message : 'The server rejected the campaign.'
}

function CampaignDialog({ open, onOpenChange, onCreate, onTestSend }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreate: (input: { title: string; body: string; kind: 'PROMOTIONAL' | 'OPERATIONAL'; target: CampaignTargetInput; clickAction?: string; imageMediaId?: string }, attemptKey: string) => void
  onTestSend: (input: { title: string; body: string; kind: 'PROMOTIONAL' | 'OPERATIONAL'; target: CampaignTargetInput; clickAction?: string; imageMediaId?: string }, attemptKey: string, note: (msg: string) => void) => void
}) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [kind, setKind] = useState<'PROMOTIONAL' | 'OPERATIONAL'>('PROMOTIONAL')
  const [mode, setMode] = useState<CampaignMode>('ALL')
  const [apps, setApps] = useState<CampaignApp[]>(['CUSTOMER'])
  const [platform, setPlatform] = useState<'ANDROID' | 'WEB'>('ANDROID')
  const [selected, setSelected] = useState<AdminUser[]>([])
  const [search, setSearch] = useState('')
  const [clickAction, setClickAction] = useState('')
  const [imageMediaId, setImageMediaId] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState('')
  const [preview, setPreview] = useState<{ devices: number; users: number; digest: string } | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [confirmWhole, setConfirmWhole] = useState(false)
  const [testNote, setTestNote] = useState<string | null>(null)
  const [attemptKey, setAttemptKey] = useState<string | null>(null)
  const usersQ = useUsers({ search: search || undefined, limit: 20 })

  const target: CampaignTargetInput = mode === 'USERS'
    ? { mode, apps, userIds: selected.map((user) => user.userId) }
    : mode === 'PLATFORM'
      ? { mode, apps, platform }
      : { mode, apps }
  const digest = JSON.stringify({ target, kind, title: title.trim(), body: body.trim() })
  const fresh = preview !== null && preview.digest === digest
  const mismatched = selected.filter((user) => !memberOf(user, apps))
  const invalid = title.trim().length < 1
    || body.trim().length < 1
    || apps.length === 0
    || (mode === 'USERS' && selected.length === 0)
    || mismatched.length > 0
  const wholeApp = mode === 'ALL' || mode === 'PLATFORM'

  useEffect(() => {
    if (open) {
      setTitle(''); setBody(''); setKind('PROMOTIONAL'); setMode('ALL'); setApps(['CUSTOMER'])
      setPlatform('ANDROID'); setSelected([]); setSearch(''); setClickAction(''); setImageMediaId(null)
      setImageUrl(''); setPreview(null); setPreviewError(null); setConfirmWhole(false)
      setTestNote(null); setAttemptKey(null)
    }
  }, [open])

  // Preview is stale the moment the audience, platform or kind changes.
  useEffect(() => { setPreview(null) }, [digest])

  const runPreview = async () => {
    setPreviewing(true); setPreviewError(null)
    try {
      const { previewCampaign } = await import('@/api/offers')
      const res = await previewCampaign({ target, kind })
      setPreview({ devices: res.devices ?? 0, users: res.users ?? 0, digest })
      if ((res.devices ?? 0) === 0) setPreviewError('No recipients match this audience. Check the app selection and selected users.')
    } catch (error) {
      setPreview(null)
      setPreviewError(campaignErrorText(error))
    } finally { setPreviewing(false) }
  }

  const uploadImage = async (file: File | undefined) => {
    if (!file) return
    setPreviewError(null)
    try {
      const targetMedia = await createCatalogMediaTarget('CONTENT_IMAGE', file.type || 'image/jpeg', file.size)
      await uploadToTarget(targetMedia, file)
      await registerCatalogMedia(targetMedia.mediaId)
      setImageMediaId(targetMedia.mediaId)
      setImageUrl(`/media/${targetMedia.mediaId}`)
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Image upload failed.')
    }
  }

  const payload = () => ({
    title: title.trim(), body: body.trim(), kind,
    target,
    ...(clickAction ? { clickAction } : {}),
    ...(imageMediaId ? { imageMediaId } : {}),
    ...(imageUrl && !imageMediaId ? { imageUrl } : {}),
  })

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
            <Field label="Audience mode" required>
              <Select value={mode} onValueChange={(v) => setMode(v as CampaignMode)} options={[
                { value: 'ALL', label: 'Whole app (all)' },
                { value: 'USERS', label: 'Selected users' },
                { value: 'PLATFORM', label: 'Platform (device OS)' },
              ]} />
            </Field>
          </div>
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
          {mode === 'PLATFORM' && (
            <Field label="Platform" required hint="Server only delivers to this device platform">
              <Select value={platform} onValueChange={(v) => setPlatform(v as 'ANDROID' | 'WEB')} options={[
                { value: 'ANDROID', label: 'Android' }, { value: 'WEB', label: 'Web' },
              ]} />
            </Field>
          )}
          {mode === 'USERS' && (
            <Field label="Users" required hint={mismatched.length ? `${mismatched.length} selected account(s) do not belong to the selected app — remove them or fix the app selection.` : 'Search People and pick recipients'}>
              <div className="space-y-2">
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or email…" />
                <div className="max-h-36 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
                  {(usersQ.data?.items ?? []).map((user) => {
                    const picked = selected.some((item) => item.userId === user.userId)
                    return (
                      <button
                        key={user.userId} type="button"
                        className="flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[12.5px] hover:bg-muted"
                        onClick={() => setSelected((cur) => (picked ? cur.filter((item) => item.userId !== user.userId) : [...cur, user]))}
                      >
                        <span className="font-semibold">{user.name} <span className="font-normal text-muted-foreground">{user.email}</span></span>
                        {picked && <span className="text-[11px] font-bold text-success">selected</span>}
                      </button>
                    )
                  })}
                  {(usersQ.data?.items ?? []).length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No people match.</p>}
                </div>
                {selected.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {selected.map((user) => (
                      <span key={user.userId} className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold">
                        {user.name}
                        <button type="button" aria-label={`Remove ${user.name}`} onClick={() => setSelected((cur) => cur.filter((item) => item.userId !== user.userId))}>×</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </Field>
          )}
          <Field label="Click action (optional)" hint="Approved destination; anything unsupported falls back to the notifications screen">
            <Select value={clickAction} onValueChange={setClickAction} options={[{ value: '', label: 'No tap target' }, ...CAMPAIGN_DESTINATIONS.map((value) => ({ value, label: value }))]} />
          </Field>
          <Field label="Image (optional)" hint="Registered content image (JPEG/PNG/WebP)">
            <div className="space-y-2">
              <Input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void uploadImage(event.target.files?.[0])} />
              {imageMediaId && <p className="text-xs text-muted-foreground">Registered as {imageMediaId} <button type="button" className="font-bold" onClick={() => { setImageMediaId(null); setImageUrl('') }}>remove</button></p>}
              {imageUrl && imageMediaId && <img src={imageUrl} alt="Campaign image preview" className="h-20 rounded-lg border border-border object-cover" />}
            </div>
          </Field>
          <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-4 py-3">
            <div>
              <Label className="mb-0">Estimated audience</Label>
              <p className="text-xs text-muted-foreground">
                {preview == null ? 'Run the preview to fetch a server-side count'
                  : `${preview.devices.toLocaleString('en-IN')} devices · ${preview.users.toLocaleString('en-IN')} users match`}
              </p>
              {previewError && <p className="text-xs font-semibold text-destructive">{previewError}</p>}
              {testNote && <p className="text-xs text-muted-foreground">{testNote}</p>}
            </div>
            <Button size="sm" variant="outline" disabled={invalid || previewing} onClick={() => void runPreview()}>
              <Send className="h-3.5 w-3.5" /> {previewing ? 'Previewing…' : 'Preview'}
            </Button>
          </div>
          {mode === 'USERS' && (
            <div className="flex items-center justify-between rounded-xl border border-border bg-muted/40 px-4 py-3">
              <div>
                <Label className="mb-0">Test recipient</Label>
                <p className="text-xs text-muted-foreground">Sends only to the first selected user via the same selected-user path.</p>
              </div>
              <Button size="sm" variant="outline" disabled={invalid || selected.length === 0} onClick={() => onTestSend({ ...payload(), target: { mode: 'USERS', apps, userIds: [selected[0]!.userId] } }, campaignAttemptKey(), setTestNote)}>
                Test send
              </Button>
            </div>
          )}
          {wholeApp && (
            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-[12.5px] font-semibold">
              <input type="checkbox" checked={confirmWhole} onChange={(e) => setConfirmWhole(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-input accent-[#2E7D1A]" />
              I confirm this send goes to the entire selected app/platform audience.
            </label>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" disabled={invalid || !fresh || (wholeApp && !confirmWhole)} onClick={() => { const key = attemptKey ?? campaignAttemptKey(); setAttemptKey(key); onCreate(payload(), key) }}>
              <Megaphone className="h-4 w-4" /> {fresh ? 'Create campaign' : 'Run preview to enable'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ── Campaign detail drawer (fetches live delivery detail) ── */
function CampaignDrawer({ campaign, onClose }: { campaign: PushCampaign; onClose: () => void }) {
  const detail = useCampaignDetail(campaign.id)
  const counts = detail.data?.counts
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
        {detail.isLoading && <p className="text-xs text-muted-foreground">Loading delivery detail…</p>}
        {detail.isError && (
          <div className="rounded-xl border border-border/70 p-4 text-[13px]">
            <p className="font-semibold">Could not load delivery detail.</p>
            <Button size="sm" variant="outline" onClick={() => void detail.refetch()}>Try again</Button>
          </div>
        )}
        {counts && (
          <div className="grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4">
            <div className="rounded-xl border border-border/70 p-3"><p className="font-bold tabular">{counts.pending}</p><p className="text-xs text-muted-foreground">Pending</p></div>
            <div className="rounded-xl border border-border/70 p-3"><p className="font-bold tabular">{counts.delivered}</p><p className="text-xs text-muted-foreground">Delivered</p></div>
            <div className="rounded-xl border border-border/70 p-3"><p className="font-bold tabular">{counts.skipped}</p><p className="text-xs text-muted-foreground">Skipped</p></div>
            <div className="rounded-xl border border-border/70 p-3"><p className="font-bold tabular">{counts.failed}</p><p className="text-xs text-muted-foreground">Failed</p></div>
          </div>
        )}
        <p className="text-[11px] text-muted-foreground">Counts are the delivery service's per-device results (provider acceptance). Token values are never shown.</p>
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
        validFrom: values.validFrom ? new Date(values.validFrom).toISOString() : null,
        validTo: values.validTo ? new Date(values.validTo).toISOString() : null,
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
        validFrom: values.validFrom ? new Date(values.validFrom).toISOString() : undefined,
        validTo: values.validTo ? new Date(values.validTo).toISOString() : undefined,
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
              { value: 'coupons', label: 'Coupons', count: tabCount(couponsQ, coupons.length) },
              { value: 'campaigns', label: 'Push campaigns', count: tabCount(campaignsQ, campaigns.length) },
              { value: 'inbox', label: 'My notifications', count: tabCount(inboxQ, inbox.filter((n) => !n.readAt).length) },
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
                loading={couponsQ.isLoading || couponsQ.isPlaceholderData}
                error={couponsQ.isError && !couponsQ.data}
                onRetry={() => void couponsQ.refetch()}
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
                loading={campaignsQ.isLoading || campaignsQ.isPlaceholderData}
                error={campaignsQ.isError && !campaignsQ.data}
                onRetry={() => void campaignsQ.refetch()}
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
              {inboxQ.isLoading && <div className="space-y-2 p-5" role="status" aria-label="Loading notifications">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 w-full rounded-xl" />)}</div>}
              {inboxQ.isError && !inboxQ.data && <div className="space-y-2 p-5" role="alert"><p>Could not load notifications.</p><Button size="sm" variant="secondary" onClick={() => void inboxQ.refetch()}>Try again</Button></div>}
              {!inboxQ.isLoading && !(inboxQ.isError && !inboxQ.data) && inbox.length === 0 && (
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
        onCreate={(input, attemptKey) => actions.addCampaign(input, attemptKey).mutate(undefined, {
          onError: (e) => setServerError(campaignErrorText(e)),
          onSuccess: () => { setServerError(null); setCampaignOpen(false) },
        })}
        onTestSend={(input, attemptKey, note) => actions.addCampaign(input, attemptKey).mutate(undefined, {
          onError: (e) => note(campaignErrorText(e)),
          onSuccess: () => note('Test campaign sent to the test recipient.'),
        })}
      />
      {campaignDetail && <CampaignDrawer campaign={campaignDetail} onClose={() => setCampaignDetail(null)} />}
    </div>
  )
}

export default Offers
