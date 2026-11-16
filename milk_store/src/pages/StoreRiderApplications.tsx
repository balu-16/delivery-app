import { firstFailedQuery, InlineLoadError, PageLoadError } from '@/components/PageLoadError'
// §5 Rider Applications — store-scoped application review: KPIs, status tabs fed by
// ?status=, sortable searchable list, detail drawer with document approve/reject.
// Approval is AUTOMATIC (all 4 docs approved → rider created) — no manual approve button.
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  BadgeCheck, Car, Check, ClipboardList, Fingerprint, FileText, Info, MapPin,
  Phone, Mail, Search, ShieldCheck, XCircle, X,
} from 'lucide-react'
import { useDebouncedValue, useStagger } from '@dairydirect/shared/hooks/misc'
import { useActiveStoreId, useRiderApplicationsStore } from '@/api/storeQueries'
import { getRiderApplication } from '@/api/storeApi'
import { useRiderDocActions } from '@/api/storeMutations'
import { useStoreAuth } from '@/login/authStore'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@dairydirect/shared/ui/base'
import { Dialog, DialogContent, Drawer } from '@dairydirect/shared/ui/overlays'
import { Field, Select } from '@dairydirect/shared/ui/form'
import { EmptyState, PageHeader, SearchInput, StatusPill, TabPills } from '@dairydirect/shared/ui/misc'
import { DataTable, Pagination, type Column } from '@dairydirect/shared/ui/DataTable'
import { KpiCard } from '@dairydirect/shared/ui/KpiCard'
import { InitialAvatar } from '@dairydirect/shared/assets/avatars'
import { cn, fmtDateTime, fmtTime, sameDay } from '@dairydirect/shared/lib/utils'
import type { RiderApplication, RiderApplicationDoc } from '@dairydirect/shared/types'

const PAGE_SIZE = 6
const TABS = [
  { value: 'all', label: 'All Applications' },
  { value: 'pending', label: 'Pending' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
]
const APP_STATUS_KEY: Record<RiderApplication['status'], string> = {
  pending: 'pending',
  under_review: 'processing', // no dedicated pill tone — renders amber
  approved: 'approved',
  rejected: 'rejected',
}
const REJECT_REASONS = ['Document expired', 'Illegible photo', 'Details mismatch', 'Other']
const DOC_ICON: Record<RiderApplicationDoc['type'], typeof Car> = {
  license: Car,
  vehicle_rc: FileText,
  aadhaar: Fingerprint,
  insurance: ShieldCheck,
}

/* ── Local helpers ─────────────────────────────────────────── */
function appliedLabel(d: string, now: Date) {
  const dt = new Date(d)
  if (sameDay(dt, now)) return `Today, ${fmtTime(dt)}`
  if (sameDay(dt, new Date(now.getTime() - 86400000))) return `Yesterday, ${fmtTime(dt)}`
  return fmtDateTime(d)
}
function maskNumber(n: string) {
  if (n.includes('•') || n.includes('XXXX')) return n
  return n.length <= 7 ? n : `${n.slice(0, 3)}••••${n.slice(-4)}`
}

/* ── Doc row inside the drawer (approve/reject only for undecided docs) ── */
function DocRow({ app, doc, onApprove, onReject, onPreview }: {
  app: RiderApplication
  doc: RiderApplicationDoc
  onApprove: () => void
  onReject: () => void
  onPreview: () => void
}) {
  const Icon = DOC_ICON[doc.type]
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/60 p-3">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-soft text-brand-700 dark:text-brand-300">
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13.5px] font-semibold">{doc.label}</div>
        <div className="text-xs tabular text-muted-foreground">{maskNumber(doc.number)}</div>
      </div>
      {doc.status === 'approved' && <Badge tone="green">Approved</Badge>}
      {doc.status === 'rejected' && <Badge tone="red">Rejected</Badge>}
      {doc.status === 'pending' && <Badge>Pending</Badge>}
      <Button variant="outline" size="sm" onClick={onPreview} aria-label={`View ${doc.label}`}>View</Button>
      {doc.status === 'pending' ? (
        <div className="flex items-center gap-1.5">
          <Button variant="success" size="sm" onClick={onApprove} aria-label={`Approve ${doc.label} for ${app.id}`}>
            <Check className="h-3.5 w-3.5" /> Approve
          </Button>
          <Button variant="destructive" size="sm" onClick={onReject} aria-label={`Reject ${doc.label} for ${app.id}`}>
            <X className="h-3.5 w-3.5" /> Reject
          </Button>
        </div>
      ) : (
        <div className="text-right text-[11px] text-muted-foreground">
          {doc.decidedAt && <div>Decided {fmtDateTime(doc.decidedAt)}</div>}
          {doc.reason && <div className="max-w-[180px] truncate" title={doc.reason}>{doc.reason}</div>}
        </div>
      )}
    </div>
  )
}

/* ── Page ──────────────────────────────────────────────────── */
export function StoreRiderApplications() {
  const storeId = useActiveStoreId()
  const stagger = useStagger()
  const docActions = useRiderDocActions()
  const user = useStoreAuth((s) => s.user)

  const [params, setParams] = useSearchParams()
  const statusParam = params.get('status') ?? 'all'
  const [search, setSearch] = useState('')
  const debounced = useDebouncedValue(search)
  const [sortDir, setSortDir] = useState<'newest' | 'oldest'>('newest')
  const [page, setPage] = useState(1)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [rejectTarget, setRejectTarget] = useState<{ app: RiderApplication; doc: RiderApplicationDoc } | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const all = useRiderApplicationsStore(storeId)
  const detail = useQuery({
    queryKey: ['store', 'rider-application', user?.id, storeId, drawerId],
    queryFn: () => getRiderApplication(storeId!, drawerId!),
    enabled: !!storeId && !!drawerId,
  })

  const counts = useMemo(() => ({
    all: all.data?.length ?? 0,
    pending: all.data?.filter((a) => a.status === 'pending').length ?? 0,
    under_review: all.data?.filter((a) => a.status === 'under_review').length ?? 0,
    approved: all.data?.filter((a) => a.status === 'approved').length ?? 0,
    rejected: all.data?.filter((a) => a.status === 'rejected').length ?? 0,
  }), [all.data])

  const filtered = useMemo(() => {
    let out = all.data ?? []
    if (statusParam !== 'all') out = out.filter((a) => a.status === statusParam)
    const q = debounced.trim().toLowerCase()
    if (q) {
      out = out.filter((a) =>
        a.riderName.toLowerCase().includes(q) || a.phone.includes(q)
        || a.id.toLowerCase().includes(q) || a.vehicle.registration.toLowerCase().includes(q))
    }
    return [...out].sort((a, b) => (sortDir === 'newest' ? b.appliedAt.localeCompare(a.appliedAt) : a.appliedAt.localeCompare(b.appliedAt)))
  }, [all.data, statusParam, debounced, sortDir])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
  const listed = drawerId ? all.data?.find((a) => a.id === drawerId) ?? null : null
  const activeApp = detail.data ?? listed
  const assigned = activeApp ? user?.stores.find((s) => s.storeId === activeApp.storeId) : undefined

  const setTab = (v: string) => {
    setParams(v === 'all' ? {} : { status: v }, { replace: true })
    setPage(1)
  }

  const columns: Column<RiderApplication>[] = [
    { key: 'id', header: 'Application ID', render: (a) => <span className="font-semibold">{a.id}</span> },
    {
      key: 'rider', header: 'Rider',
      render: (a) => (
        <span className="flex items-center gap-2.5">
          <InitialAvatar name={a.riderName} size={30} />
          <span className="font-medium">{a.riderName}</span>
        </span>
      ),
    },
    {
      key: 'vehicle', header: 'Vehicle',
      render: (a) => (
        <span className="flex flex-col items-start gap-1">
          <Badge tone="neutral" className="tabular">{a.vehicle.registration}</Badge>
          <span className="text-[11px] text-muted-foreground">{a.vehicle.type}</span>
        </span>
      ),
    },
    { key: 'appliedAt', header: 'Applied On', render: (a) => <span className="whitespace-nowrap text-muted-foreground">{appliedLabel(a.appliedAt, new Date())}</span> },
    { key: 'status', header: 'Status', render: (a) => <StatusPill status={APP_STATUS_KEY[a.status]} /> },
  ]

  const loadFailure = firstFailedQuery([all])
  if (loadFailure) return <PageLoadError title="Rider Applications" artwork="riderApplications" query={loadFailure} />

  return (
    <motion.div variants={stagger.container} initial="hidden" animate="show" className="space-y-5">
      <PageHeader
        breadcrumb={['Rider Applications']}
        title="Rider"
        titleAccent="Applications"
        subtitle="Review rider applications, verify documents and approve eligible riders for your store."
        artwork="riderApplications"
      />

      <motion.section variants={stagger.item} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Pending" value={counts.pending} icon={ClipboardList} tint="amber" />
        <KpiCard label="Under Review" value={counts.under_review} icon={Search} tint="blue" />
        <KpiCard label="Approved" value={counts.approved} icon={BadgeCheck} tint="green" />
        <KpiCard label="Rejected" value={counts.rejected} icon={XCircle} tint="red" />
      </motion.section>

      <motion.section variants={stagger.item} className="space-y-4">
        <TabPills
          id="rider-app-tabs"
          value={statusParam}
          onChange={setTab}
          tabs={TABS.map((t) => ({ ...t, count: counts[t.value as keyof typeof counts] }))}
        />
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
          {/* Applications list — left 5 cols */}
          <Card hoverable className="lg:col-span-5">
            <CardHeader className="flex-col items-stretch gap-3 xl:flex-row xl:items-center">
              <CardTitle>Applications ({filtered.length})</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <SearchInput value={search} onChange={setSearch} placeholder="Search name, phone, ID, registration…" className="w-full xl:w-56" />
                <Select
                  value={sortDir}
                  onValueChange={(v) => setSortDir(v as 'newest' | 'oldest')}
                  options={[{ value: 'newest', label: 'Newest First' }, { value: 'oldest', label: 'Oldest First' }]}
                  className="w-40"
                />
              </div>
            </CardHeader>
            <CardContent>
              <DataTable
                columns={columns}
                rows={pageRows}
                keyId={(a) => a.id}
                loading={all.isLoading}
                onRowClick={(a) => { setDrawerId(a.id); setPage(1) }}
                skeletonRows={6}
                empty={<EmptyState icon={BadgeCheck} title="No applications here" body="Rider applications for your store will appear in this list." />}
              />
              <Pagination
                page={page}
                totalPages={totalPages}
                onChange={setPage}
                showing={`Showing ${filtered.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, filtered.length)} of ${filtered.length} applications`}
              />
            </CardContent>
          </Card>

          {/* Review explainer — right 7 cols (detail itself opens in the drawer) */}
          <Card hoverable className="lg:col-span-7">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-brand-600" /> How rider approval works</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-start gap-2 rounded-xl bg-primary-soft px-3.5 py-3 text-[12.5px] font-semibold text-brand-800 dark:text-brand-200">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                Rider becomes approved automatically when all required documents are approved.
              </div>
              <ol className="space-y-2.5 text-[13px]">
                {[
                  'Open an application to review the rider’s vehicle and documents.',
                  'Approve each document that is valid and legible — rejecting any document rejects the whole application and notifies the rider.',
                  'Once all four required documents are approved, the rider is created for your store automatically — no separate approval step.',
                ].map((s, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary-soft text-[11px] font-bold text-brand-700 dark:text-brand-300">{i + 1}</span>
                    <span className="text-foreground/85">{s}</span>
                  </li>
                ))}
              </ol>
              <div>
                <div className="mb-2 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Required documents (4)</div>
                <div className="flex flex-wrap gap-2">
                  <Badge tone="neutral" className="gap-1.5"><Car className="h-3 w-3" /> Driving License</Badge>
                  <Badge tone="neutral" className="gap-1.5"><FileText className="h-3 w-3" /> Vehicle RC</Badge>
                  <Badge tone="neutral" className="gap-1.5"><Fingerprint className="h-3 w-3" /> Aadhaar</Badge>
                  <Badge tone="neutral" className="gap-1.5"><ShieldCheck className="h-3 w-3" /> Insurance</Badge>
                </div>
              </div>
              <p className="rounded-xl bg-muted/50 px-3.5 py-2.5 text-xs text-muted-foreground">
                Reviewing is scoped to your assigned store — you only ever see applications submitted to it.
              </p>
            </CardContent>
          </Card>
        </div>
      </motion.section>

      {/* ── Application detail drawer ── */}
      {activeApp && (
        <Drawer
          open
          onOpenChange={(v) => { if (!v) setDrawerId(null) }}
          width="lg"
          title={
            <span className="flex flex-wrap items-center gap-2.5">
              <InitialAvatar name={activeApp.riderName} size={44} />
              <span className="text-base">{activeApp.riderName}</span>
              <Badge tone="blue" className="tabular">{activeApp.id}</Badge>
              <StatusPill status={APP_STATUS_KEY[activeApp.status]} />
            </span>
          }
          subtitle={`Applied ${fmtDateTime(activeApp.appliedAt)}`}
        >
          {detail.isError ? (
            <InlineLoadError query={detail} label="rider application" />
          ) : detail.isLoading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Loading application…</p>
          ) : detail.data === null ? (
            <p className="py-10 text-center text-sm text-muted-foreground">This application is no longer available.</p>
          ) : <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-border/70 bg-muted/40 px-4 py-3 text-[13px]">
              <a href={`tel:${activeApp.phone.replace(/\s/g, '')}`} className="inline-flex items-center gap-1.5 font-medium hover:text-brand-700">
                <Phone className="h-3.5 w-3.5 text-muted-foreground" /> {activeApp.phone}
              </a>
              <a href={`mailto:${activeApp.email}`} className="inline-flex items-center gap-1.5 font-medium hover:text-brand-700">
                <Mail className="h-3.5 w-3.5 text-muted-foreground" /> {activeApp.email}
              </a>
              <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                Applied: {fmtDateTime(activeApp.appliedAt)}
              </span>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2"><Car className="h-4 w-4 text-brand-600" /> Vehicle Details</CardTitle></CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-[92px_1fr] gap-y-1.5 text-[13px]">
                    <dt className="text-muted-foreground">Type</dt><dd className="font-medium">{activeApp.vehicle.type}</dd>
                    <dt className="text-muted-foreground">Make/Model</dt><dd className="font-medium">{activeApp.vehicle.makeModel}</dd>
                    <dt className="text-muted-foreground">Registration</dt><dd className="font-medium tabular">{activeApp.vehicle.registration}</dd>
                    <dt className="text-muted-foreground">Color</dt><dd className="font-medium">{activeApp.vehicle.color}</dd>
                    <dt className="text-muted-foreground">Year</dt><dd className="font-medium tabular">{activeApp.vehicle.year}</dd>
                  </dl>
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="flex items-center gap-2"><MapPin className="h-4 w-4 text-brand-600" /> Store Assignment</CardTitle></CardHeader>
                <CardContent className="space-y-1.5 text-[13px]">
                  <p>Applied for: <span className="font-semibold">{assigned?.name ?? activeApp.storeId}</span></p>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader className="pb-2"><CardTitle>Documents ({activeApp.documents.length})</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {activeApp.documents.map((doc) => (
                  <DocRow
                    key={doc.id}
                    app={activeApp}
                    doc={doc}
                    onPreview={() => {
                      void docActions.readUrl(doc.id).then((result) => {
                        if (result.readUrl) window.open(result.readUrl, '_blank', 'noopener')
                      }).catch(() => undefined)
                    }}
                    onApprove={() => docActions.decide(doc.id, doc.type, 'approved')}
                    onReject={() => { setRejectTarget({ app: activeApp, doc }); setRejectReason('') }}
                  />
                ))}
                <div className="flex items-start gap-2 rounded-xl bg-primary-soft px-3.5 py-3 text-[12.5px] font-semibold text-brand-800 dark:text-brand-200">
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  Rider becomes approved automatically when all required documents are approved.
                </div>
              </CardContent>
            </Card>
          </div>}
        </Drawer>
      )}

      {/* ── Reject reason dialog ── */}
      <Dialog open={!!rejectTarget} onOpenChange={(v) => { if (!v) setRejectTarget(null) }}>
        <DialogContent
          title={`Reject ${rejectTarget?.doc.label ?? 'document'}`}
          description={rejectTarget ? `${rejectTarget.app.id} · ${rejectTarget.app.riderName} — rejecting a document rejects the application.` : undefined}
        >
          <div className="space-y-4">
            <Field label="Rejection reason" required error={!rejectReason ? 'Pick a reason to continue' : undefined}>
              <Select
                value={rejectReason}
                onValueChange={setRejectReason}
                placeholder="Why is this document being rejected?"
                options={REJECT_REASONS.map((r) => ({ value: r, label: r }))}
              />
            </Field>
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={() => setRejectTarget(null)}>Cancel</Button>
              <Button
                variant="destructive"
                disabled={!rejectReason}
                onClick={() => {
                  if (!rejectTarget) return
                  docActions.decide(rejectTarget.doc.id, rejectTarget.doc.type, 'rejected', rejectReason)
                  setRejectTarget(null)
                }}
              >
                <X className="h-4 w-4" /> Reject document
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </motion.div>
  )
}
