// ── §6 People — customers · rider applications · workforce (REAL API) ────────
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { motion } from 'framer-motion'
import {
  Ban, Eye, Info, KeyRound, MoreHorizontal, ShieldCheck, UserPlus, ChevronLeft, ChevronRight, FileText,
} from 'lucide-react'
import { Badge, Button, Card, Input } from '@/components/ui/base'
import {
  Dialog, DialogContent, Drawer, DropdownItem, DropdownMenu, DropdownMenuContent,
  DropdownMenuTrigger, Tooltip,
} from '@/components/ui/overlays'
import { Field, Select } from '@/components/ui/form'
import { EmptyState, PageHeader, SearchInput, TabPills, StatusPill } from '@/components/shared/misc'
import { DataTable } from '@/components/shared/DataTable'
import { InitialAvatar } from '@/illustrations/avatars'
import { useStagger } from '@/hooks/misc'
import { useUsers, useRiderApplications, useRiderApplication, useStoreOptions, useWorkforce } from '@/hooks/queries'
import { usePeopleActions } from '@/hooks/mutations'
import type { AdminUser, RiderApplicationDetail, RiderApplicationListItem, WorkforceAccount } from '@/types'

const PEOPLE_TABS = [
  { value: 'customers', label: 'Customers' },
  { value: 'riders', label: 'Rider applications' },
  { value: 'workforce', label: 'Workforce' },
]

const ROLE_BADGE: Record<string, { label: string; tone: 'amber' | 'green' | 'blue' | 'violet' }> = {
  SUPER_ADMIN: { label: 'Admin', tone: 'amber' },
  STORE_MANAGER: { label: 'Store manager', tone: 'green' },
  RIDER: { label: 'Rider', tone: 'blue' },
  SUPPORT_AGENT: { label: 'Support agent', tone: 'violet' },
}

function shortId(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

/* ── small local helpers ─────────────────────────────────────── */
function ReasonDialog({
  open, title, description, confirmLabel = 'Confirm', destructive, onClose, onSubmit,
}: {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  destructive?: boolean
  onClose: () => void
  onSubmit: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent title={title} description={description}>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="md" onClick={onClose}>Cancel</Button>
          <Button variant={destructive ? 'destructive' : 'primary'} size="md" onClick={() => { onSubmit(); onClose() }}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function RowActions({ children, label = 'Actions' }: { children: React.ReactNode; label?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" size="iconSm" aria-label={label}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <div className="contents" onClick={(e) => e.stopPropagation()}>{children}</div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function CursorBar({ onPrev, onNext, hasPrev, hasNext, loading, label }: {
  onPrev: () => void; onNext: () => void; hasPrev: boolean; hasNext: boolean; loading: boolean; label: string
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={!hasPrev || loading} onClick={onPrev}><ChevronLeft className="h-3.5 w-3.5" /> Prev</Button>
        <Button size="sm" variant="outline" disabled={!hasNext || loading} onClick={onNext}>Next <ChevronRight className="h-3.5 w-3.5" /></Button>
      </div>
    </div>
  )
}

/* ── Add / invite workforce dialog (RHF + zod) ───────────────── */
const addSchema = z.object({
  name: z.string().min(2, 'Enter the full name'),
  email: z.string().email('Enter a valid email'),
  role: z.enum(['STORE_MANAGER', 'RIDER', 'SUPPORT_AGENT']),
})
type AddFormValues = z.infer<typeof addSchema>

function AddWorkforceDialog({ open, onOpenChange, serverError, onSubmit }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  serverError: string | null
  onSubmit: (values: AddFormValues) => void
}) {
  const { register, handleSubmit, control, reset, formState: { errors } } = useForm<AddFormValues>({
    resolver: zodResolver(addSchema),
    defaultValues: { name: '', email: '', role: 'STORE_MANAGER' },
  })
  useEffect(() => { if (open) reset({ name: '', email: '', role: 'STORE_MANAGER' }) }, [open, reset])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add workforce account" description="The invite email is sent by the identity provider">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-3">
          <Field label="Full name" required error={errors.name?.message}><Input {...register('name')} /></Field>
          <Field label="Email" required error={errors.email?.message}><Input type="email" {...register('email')} /></Field>
          <Field label="Role" required>
            <Controller control={control} name="role" render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange} options={[
                { value: 'STORE_MANAGER', label: 'Store manager' },
                { value: 'RIDER', label: 'Rider' },
                { value: 'SUPPORT_AGENT', label: 'Support agent' },
              ]} />
            )} />
          </Field>
          {serverError && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{serverError}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" size="md"><UserPlus className="h-4 w-4" /> Send invite</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ── Role change dialog ──────────────────────────────────────── */
function RoleChangeDialog({ open, onOpenChange, member, serverError, onSubmit }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  member: WorkforceAccount | null
  serverError: string | null
  onSubmit: (role: string, grant: boolean) => void
}) {
  const [role, setRole] = useState('SUPPORT_AGENT')
  const [grant, setGrant] = useState(true)
  useEffect(() => { if (open) { setRole('SUPPORT_AGENT'); setGrant(true) } }, [open])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Role change — ${member?.name ?? ''}`} description="Role changes go through an approval request (maker-checker)">
        <div className="space-y-3">
          <Field label="Target role" required>
            <Select value={role} onValueChange={setRole} options={[
              { value: 'RIDER', label: 'Rider' },
              { value: 'STORE_MANAGER', label: 'Store manager' },
              { value: 'SUPPORT_AGENT', label: 'Support agent' },
              { value: 'SUPER_ADMIN', label: 'Admin (super)' },
            ]} />
          </Field>
          <Field label="Change" required>
            <Select value={grant ? 'grant' : 'revoke'} onValueChange={(v) => setGrant(v === 'grant')} options={[
              { value: 'grant', label: 'Grant role' }, { value: 'revoke', label: 'Revoke role' },
            ]} />
          </Field>
          {serverError && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{serverError}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" onClick={() => { onSubmit(role, grant); onOpenChange(false) }}>
              <ShieldCheck className="h-4 w-4" /> Submit request
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ── Rider application detail drawer ─────────────────────────── */
function RiderApplicationDrawer({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const appQ = useRiderApplication(userId)
  const app: RiderApplicationDetail | null = appQ.data ?? null
  return (
    <Drawer open onOpenChange={(v) => { if (!v) onClose() }} width="md" title="Rider application" subtitle={userId ? shortId(userId) : ''}>
      {appQ.isLoading || !app ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 w-full rounded-xl" />)}</div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill status={app.status.replace(/_/g, '-')} dot />
            {app.vehicleType && <Badge tone="blue">{app.vehicleType}</Badge>}
            {app.vehicleNo && <Badge tone="neutral">{app.vehicleNo}</Badge>}
          </div>
          <div className="rounded-xl border border-border/70 bg-muted/30 p-4 text-[13px]">
            <p className="font-semibold">Home store</p>
            <p className="text-muted-foreground">{app.homeStoreId ? shortId(app.homeStoreId) : 'Not assigned yet'}</p>
          </div>
          <section>
            <h4 className="mb-2 text-[13px] font-bold uppercase tracking-wide text-muted-foreground">Documents</h4>
            <div className="space-y-1.5">
              {app.documents.length === 0 && <p className="rounded-xl border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">No documents uploaded</p>}
              {app.documents.map((d) => (
                <div key={d.id} className="flex items-center gap-3 rounded-xl border border-border/70 px-3 py-2.5">
                  <FileText className="h-4 w-4 shrink-0 text-brand-600" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-semibold">{d.type}</p>
                    <p className="text-[11px] text-muted-foreground">{d.reason ?? '—'}</p>
                  </div>
                  <StatusPill status={d.status} />
                </div>
              ))}
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
              Document review and approval happen in the store-manager flow for the assigned store — the admin portal shows the state only.
            </p>
          </section>
          {app.requiredDocuments.length > 0 && (
            <section>
              <h4 className="mb-2 text-[13px] font-bold uppercase tracking-wide text-muted-foreground">Required documents</h4>
              <div className="flex flex-wrap gap-1.5">
                {app.requiredDocuments.map((r) => <Badge key={r} tone="neutral">{r}</Badge>)}
              </div>
            </section>
          )}
        </div>
      )}
    </Drawer>
  )
}

/* ── Page ──────────────────────────────────────────────────── */
export function People() {
  const container = useStagger()
  const actions = usePeopleActions()
  const [serverError, setServerError] = useState<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const [tab, setTab] = useState<string>(searchParams.get('tab') ?? 'customers')

  const storesQ = useStoreOptions()
  const stores = storesQ.data ?? []

  // customers tab (pool CUSTOMER via server search)
  const [custSearch, setCustSearch] = useState('')
  const [custCursor, setCustCursor] = useState<string | null>(null)
  const [custStack, setCustStack] = useState<Array<string | null>>([null])
  const customersQ = useUsers({ search: custSearch || undefined, cursor: custCursor ?? undefined, limit: 12 })

  // workforce tab
  const [wfSearch, setWfSearch] = useState('')
  const [wfCursor, setWfCursor] = useState<string | null>(null)
  const [wfStack, setWfStack] = useState<Array<string | null>>([null])
  const workforceQ = useWorkforce({ search: wfSearch || undefined, cursor: wfCursor ?? undefined, limit: 12 })

  // rider applications tab
  const [appCursor, setAppCursor] = useState<string | null>(null)
  const [appStack, setAppStack] = useState<Array<string | null>>([null])
  const [appStatus, setAppStatus] = useState<string>('PENDING')
  const appsQ = useRiderApplications({ status: appStatus, cursor: appCursor ?? undefined })
  const [detailAppId, setDetailAppId] = useState<string | null>(null)

  const [addOpen, setAddOpen] = useState(false)
  const [roleTarget, setRoleTarget] = useState<WorkforceAccount | null>(null)
  const [blockTarget, setBlockTarget] = useState<AdminUser | WorkforceAccount | null>(null)
  const [unblockTarget, setUnblockTarget] = useState<AdminUser | WorkforceAccount | null>(null)

  useEffect(() => { setSearchParams(tab === 'customers' ? {} : { tab }, { replace: true }) /* eslint-disable-line react-hooks/exhaustive-deps */ }, [tab])

  const customers: AdminUser[] = (customersQ.data?.items ?? []).filter((u) => u.pool === 'CUSTOMER')
  const workforce: WorkforceAccount[] = workforceQ.data?.items ?? []
  const apps: RiderApplicationListItem[] = appsQ.data?.items ?? []

  const pageNext = <T extends { nextCursor: string | null }>(data: T | undefined, setC: (c: string | null) => void, setStack: React.Dispatch<React.SetStateAction<Array<string | null>>>) => {
    const nc = data?.nextCursor ?? null
    if (!nc) return
    setStack((st) => [...st, nc]); setC(nc)
  }
  const pagePrev = (setC: (c: string | null) => void, setStack: React.Dispatch<React.SetStateAction<Array<string | null>>>) => {
    setStack((st) => {
      if (st.length <= 1) return st
      const s = st.slice(0, -1)
      setC(s[s.length - 1] ?? null)
      return s
    })
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="People"
        titleAccent="& accounts"
        subtitle="Customers, rider applications and the workforce accounts behind the operation."
        artwork="people"
        breadcrumb={['People']}
      />

      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-4">
        <motion.div variants={container.item}>
          <TabPills
            id="people-tabs"
            value={tab}
            onChange={setTab}
            tabs={PEOPLE_TABS}
          />
        </motion.div>

        {/* ── CUSTOMERS ── */}
        {tab === 'customers' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <SearchInput value={custSearch} onChange={setCustSearch} placeholder="Search customers by name or email…" className="min-w-[220px] flex-1" />
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(u) => u.userId}
                rows={customers}
                loading={customersQ.isLoading}
                empty={<EmptyState icon={Info} title="No customers match" body="Try a different search term." />}
                columns={[
                  {
                    key: 'name', header: 'Customer',
                    render: (u: AdminUser) => (
                      <div className="flex items-center gap-3">
                        <InitialAvatar name={u.name} size={30} />
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{u.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{u.email}</p>
                        </div>
                      </div>
                    ),
                  },
                  { key: 'id', header: 'Id', render: (u: AdminUser) => <span className="font-mono text-xs text-muted-foreground">{shortId(u.userId)}</span> },
                  { key: 'status', header: 'Status', render: (u: AdminUser) => <StatusPill status={u.status} dot /> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (u: AdminUser) => (
                      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                        <RowActions label={`Actions for ${u.name}`}>
                          {u.status === 'active' ? (
                            <DropdownItem danger onSelect={() => setBlockTarget(u)}><Ban className="h-3.5 w-3.5" /> Block customer</DropdownItem>
                          ) : (
                            <DropdownItem onSelect={() => setUnblockTarget(u)}><ShieldCheck className="h-3.5 w-3.5" /> Unblock customer</DropdownItem>
                          )}
                        </RowActions>
                      </div>
                    ),
                  },
                ]}
              />
              <CursorBar
                onPrev={() => pagePrev(setCustCursor, setCustStack)}
                onNext={() => pageNext(customersQ.data, setCustCursor, setCustStack)}
                hasPrev={custStack.length > 1}
                hasNext={!!customersQ.data?.nextCursor}
                loading={customersQ.isLoading}
                label={`Page ${custStack.length} · customer feed`}
              />
            </Card>
          </motion.section>
        )}

        {/* ── RIDER APPLICATIONS ── */}
        {tab === 'riders' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="w-52">
                <Select value={appStatus} onValueChange={setAppStatus} options={[
                  { value: 'PENDING', label: 'Pending review' },
                  { value: 'UNDER_REVIEW', label: 'Under review' },
                  { value: 'APPROVED', label: 'Approved' },
                  { value: 'REJECTED', label: 'Rejected' },
                  { value: 'SUSPENDED', label: 'Suspended' },
                ]} />
              </div>
              <p className="text-xs text-muted-foreground">Document review happens in the store-manager flow.</p>
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(a) => a.userId}
                rows={apps}
                loading={appsQ.isLoading}
                empty={<EmptyState icon={Info} title="No applications in this state" body="Try a different status filter." />}
                columns={[
                  {
                    key: 'name', header: 'Applicant',
                    render: (a: RiderApplicationListItem) => (
                      <div className="flex items-center gap-3">
                        <InitialAvatar name={a.name} size={30} />
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{a.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{a.email}</p>
                        </div>
                      </div>
                    ),
                  },
                  { key: 'id', header: 'Id', render: (a: RiderApplicationListItem) => <span className="font-mono text-xs text-muted-foreground">{shortId(a.userId)}</span> },
                  { key: 'status', header: 'Status', render: (a: RiderApplicationListItem) => <StatusPill status={a.status.replace(/_/g, '-')} dot /> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (a: RiderApplicationListItem) => (
                      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                        <Tooltip content="Open application details">
                          <span>
                            <Button size="sm" variant="ghost" onClick={() => setDetailAppId(a.userId)}><Eye className="h-3.5 w-3.5" /> Details</Button>
                          </span>
                        </Tooltip>
                      </div>
                    ),
                  },
                ]}
              />
              <CursorBar
                onPrev={() => pagePrev(setAppCursor, setAppStack)}
                onNext={() => pageNext(appsQ.data, setAppCursor, setAppStack)}
                hasPrev={appStack.length > 1}
                hasNext={!!appsQ.data?.nextCursor}
                loading={appsQ.isLoading}
                label={`Page ${appStack.length} · application feed`}
              />
            </Card>
          </motion.section>
        )}

        {/* ── WORKFORCE ── */}
        {tab === 'workforce' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <SearchInput value={wfSearch} onChange={setWfSearch} placeholder="Search workforce by name or email…" className="min-w-[220px] flex-1" />
              <Button variant="primary" size="md" onClick={() => setAddOpen(true)}><UserPlus className="h-4 w-4" /> Add workforce</Button>
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(w) => w.userId}
                rows={workforce}
                loading={workforceQ.isLoading}
                empty={<EmptyState icon={Info} title="No workforce accounts match" body="Try a different search term." />}
                columns={[
                  {
                    key: 'name', header: 'Member',
                    render: (w: WorkforceAccount) => (
                      <div className="flex items-center gap-3">
                        <InitialAvatar name={w.name} size={30} />
                        <div className="min-w-0">
                          <p className="truncate font-semibold">{w.name}</p>
                          <p className="truncate text-xs text-muted-foreground">{w.email}</p>
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: 'roles', header: 'Roles',
                    render: (w: WorkforceAccount) => (
                      <div className="flex flex-wrap gap-1.5">
                        {w.roles.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
                        {w.roles.map((r) => (
                          <Badge key={r} tone={ROLE_BADGE[r]?.tone ?? 'neutral'}>{ROLE_BADGE[r]?.label ?? r.toLowerCase()}</Badge>
                        ))}
                      </div>
                    ),
                  },
                  { key: 'id', header: 'Id', render: (w: WorkforceAccount) => <span className="font-mono text-xs text-muted-foreground">{shortId(w.userId)}</span> },
                  { key: 'status', header: 'Status', render: (w: WorkforceAccount) => <StatusPill status={w.status} dot /> },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (w: WorkforceAccount) => (
                      <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                        <RowActions label={`Actions for ${w.name}`}>
                          <DropdownItem onSelect={() => actions.requestPasswordReset(w.userId, w.name).mutate(undefined, { onError: (e) => setServerError(e.message) })}>
                            <KeyRound className="h-3.5 w-3.5" /> Request password reset
                          </DropdownItem>
                          <DropdownItem onSelect={() => setRoleTarget(w)}><ShieldCheck className="h-3.5 w-3.5" /> Change role</DropdownItem>
                          {w.status === 'active' ? (
                            <DropdownItem danger onSelect={() => setBlockTarget(w)}><Ban className="h-3.5 w-3.5" /> Block account</DropdownItem>
                          ) : (
                            <DropdownItem onSelect={() => setUnblockTarget(w)}><ShieldCheck className="h-3.5 w-3.5" /> Unblock account</DropdownItem>
                          )}
                        </RowActions>
                      </div>
                    ),
                  },
                ]}
              />
              <CursorBar
                onPrev={() => pagePrev(setWfCursor, setWfStack)}
                onNext={() => pageNext(workforceQ.data, setWfCursor, setWfStack)}
                hasPrev={wfStack.length > 1}
                hasNext={!!workforceQ.data?.nextCursor}
                loading={workforceQ.isLoading}
                label={`Page ${wfStack.length} · workforce feed`}
              />
            </Card>
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-warning-soft px-4 py-3 dark:border-amber-500/30">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-warning" />
              <p className="text-[13px] font-medium leading-relaxed text-amber-800 dark:text-amber-200">
                Store assignments live on each store's drawer (Stores &rsaquo; store &rsaquo; Store managers). Role changes and admin grants always go through Approvals.
              </p>
            </div>
          </motion.section>
        )}
      </motion.div>

      {/* drawers + dialogs */}
      {detailAppId && <RiderApplicationDrawer userId={detailAppId} onClose={() => setDetailAppId(null)} />}
      <AddWorkforceDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        serverError={serverError}
        onSubmit={(v) => actions.addWorkforce({ email: v.email, name: v.name, role: v.role as 'RIDER' | 'STORE_MANAGER' | 'SUPPORT_AGENT' }).mutate(undefined, {
          onError: (e) => setServerError(e.message),
          onSuccess: () => { setServerError(null); setAddOpen(false) },
        })}
      />
      <RoleChangeDialog
        open={!!roleTarget}
        onOpenChange={(v) => { if (!v) setRoleTarget(null) }}
        member={roleTarget}
        serverError={serverError}
        onSubmit={(role, grant) => {
          if (roleTarget) actions.requestRoleChange(roleTarget.userId, roleTarget.name, role as never, grant).mutate(undefined, { onError: (e) => setServerError(e.message) })
        }}
      />
      <ReasonDialog
        open={!!blockTarget}
        title={`Block ${blockTarget && 'name' in blockTarget ? blockTarget.name : ''}?`}
        description="The account loses portal/app access immediately. Orders in flight are unaffected."
        confirmLabel="Block account"
        destructive
        onClose={() => setBlockTarget(null)}
        onSubmit={() => {
          if (blockTarget) {
            actions.blockUser(blockTarget.userId, blockTarget.name, true).mutate(undefined, { onError: (e) => setServerError(e.message) })
          }
        }}
      />
      <ReasonDialog
        open={!!unblockTarget}
        title="Unblock account?"
        description="Access is restored on the next sign-in."
        confirmLabel="Unblock"
        onClose={() => setUnblockTarget(null)}
        onSubmit={() => {
          if (unblockTarget) {
            actions.blockUser(unblockTarget.userId, unblockTarget.name, false).mutate(undefined, { onError: (e) => setServerError(e.message) })
          }
        }}
      />
      {serverError && tab === 'customers' && <p className="text-xs font-semibold text-destructive">{serverError}</p>}
    </div>
  )
}

export default People

