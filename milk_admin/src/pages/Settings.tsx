// ── §14 Settings & system (REAL API: config, flags, prefs, ops) ──────────────
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  RefreshCcw, ServerCog, Bell, Flag, Info, Inbox as InboxIcon,
} from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import { useConfig, useFailedJobs, useOutboxStatus } from '@/hooks/queries'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { getNotificationPreferences } from '@/api/offers'
import { useSystemActions, useOfferActions } from '@/hooks/mutations'
import { PageHeader, TabPills, EmptyState } from '@/components/shared/misc'
import { Select } from '@/components/ui/form'
import { Button, Card, Badge, Switch, Label } from '@/components/ui/base'
import { Tooltip } from '@/components/ui/overlays'
import type { NotificationPreference } from '@/types'
import { fmtDateTime } from '@/lib/utils'
import { DeliveryPincodes } from './DeliveryPincodes'
import { OperationalSettings } from './OperationalSettings'
import { SettingsHistory, SystemHealth } from './SystemStatus'
import { updateFeatureFlag } from '@/api/settings'

type MainTab = 'config' | 'flags' | 'pincodes' | 'history' | 'notifications' | 'ops'

const FLAG_LABELS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'cod_enabled', label: 'Cash on delivery', hint: 'COD payment option across storefront flows' },
  { key: 'wallet_enabled', label: 'Wallet payments', hint: 'Allow customers to use their existing wallet balance. Top-ups are unavailable.' },
  { key: 'customer_location_required', label: 'Require customer location for orders', hint: 'When off, delivery eligibility uses the address PIN code. When on, the customer must confirm a location before ordering.' },
  { key: 'surge_enabled', label: 'Surge pricing', hint: 'Apply the configured surge fee to checkout and delivery estimates.' },
  { key: 'agent_enabled', label: 'Customer assistant', hint: 'Allow the assistant when its server, worker and model are configured.' },
]

function FlagSetting({setting, flags}: {setting: (typeof FLAG_LABELS)[number]; flags:Record<string,boolean>}) {
  const client = useQueryClient()
  const known = setting.key in flags
  const mutation = useMutation({mutationFn:(value:boolean)=>updateFeatureFlag(setting.key,value),onSuccess:async()=>{await client.invalidateQueries({queryKey:['config']})}})
  return <div className="flex items-center justify-between gap-4 p-5"><div><Label className="mb-0">{setting.label}</Label><p className="text-xs text-muted-foreground">{setting.hint}</p>
    {!known && <p className="mt-1 flex items-center gap-1 text-[10.5px] font-semibold text-muted-foreground"><Info className="h-3 w-3" /> Status unavailable; refresh before changing it</p>}
    {mutation.isError && <p role="alert" className="mt-1 text-xs text-destructive">Could not change this setting. Check your connection and try again.</p>}
    {mutation.isSuccess && <p role="status" className="mt-1 text-xs text-brand-700">Saved</p>}</div>
    <Switch checked={known && flags[setting.key] === true} disabled={!known || mutation.isPending} onCheckedChange={value=>mutation.mutate(value)} /></div>
}

const PREF_LABELS: Record<string, string> = {
  ORDER_UPDATES: 'Order updates',
  PAYMENTS: 'Payments',
  WALLET: 'Wallet',
  RIDING: 'Riding',
  STORE_OPS: 'Store operations',
  ADMIN: 'Admin',
  PROMOTIONS: 'Promotions',
}

// Concern names must match the backend queue registry (platform/queue/concerns.ts).
const OPS_CONCERNS = ['outbox', 'notifications', 'dispatch', 'payments', 'subscriptions', 'imports', 'maintenance'] as const

export function Settings() {
  const container = useStagger()
  const [tab, setTab] = useState<MainTab>('flags')

  const configQ = useConfig()
  const config = configQ.data
  const flags = config?.flags ?? {}
  const configValues = config?.config ?? {}

  const systemActions = useSystemActions()
  const offerActions = useOfferActions()
  const [serverError, setServerError] = useState<string | null>(null)

  const [concern, setConcern] = useState<string>('outbox')
  const jobsQ = useFailedJobs(tab === 'ops' ? concern : null)
  const outboxQ = useOutboxStatus()

  const prefsQ = useNotificationPrefs()
  const prefs: NotificationPreference[] = prefsQ.data ?? []

  useEffect(() => { if (serverError) { const t = setTimeout(() => setServerError(null), 6000); return () => clearTimeout(t) } }, [serverError])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings &"
        titleAccent="system"
        subtitle="Feature flags, platform configuration, notification preferences and operational jobs."
        artwork="settings"
        breadcrumb={['Settings']}
      />

      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-4">
        <motion.div variants={container.item}>
          <TabPills
            id="settings-tabs"
            value={tab}
            onChange={(v) => setTab(v as MainTab)}
            tabs={[
              { value: 'flags', label: 'Feature flags' },
              { value: 'pincodes', label: 'Delivery PINs' },
              { value: 'config', label: 'Configuration' },
              { value: 'history', label: 'Change history' },
              { value: 'notifications', label: 'Notifications' },
              { value: 'ops', label: 'Ops' },
            ]}
          />
        </motion.div>

        {/* ── FLAGS ── */}
        {tab === 'flags' && (
          <motion.section variants={container.item} className="space-y-3">
            {configQ.isLoading ? (
              <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-16 w-full rounded-xl" />)}</div>
            ) : !config ? (
              <Card className="p-8"><EmptyState icon={Flag} title="Config unavailable" body="The server config could not be loaded." /></Card>
            ) : (
              <Card className="divide-y divide-border/60">
                {FLAG_LABELS.map((f) => <FlagSetting key={f.key} setting={f} flags={flags} />)}
              </Card>
            )}
            {serverError && <p className="text-xs font-semibold text-destructive">{serverError}</p>}
          </motion.section>
        )}

        {tab === 'pincodes' && <DeliveryPincodes />}
        {tab === 'history' && <SettingsHistory />}

        {/* ── CONFIG ── */}
        {tab === 'config' && (
          <motion.section variants={container.item} className="space-y-3">
            {configQ.isLoading ? <p role="status">Loading settings…</p> : configQ.isError && !config ? <Card className="p-5"><p>Could not load settings.</p><Button size="sm" onClick={() => void configQ.refetch()}>Try again</Button></Card> : <OperationalSettings config={configValues} />}
          </motion.section>
        )}

        {/* ── NOTIFICATIONS ── */}
        {tab === 'notifications' && (
          <motion.section variants={container.item} className="space-y-3">
            <Card className="divide-y divide-border/60">
              {prefsQ.isLoading && <div className="space-y-2 p-5" role="status" aria-label="Loading notification preferences">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 w-full rounded-xl" />)}</div>}
              {prefsQ.isError && !prefsQ.data && <div className="space-y-2 p-5" role="alert"><p>Could not load notification preferences.</p><Button size="sm" variant="secondary" onClick={() => void prefsQ.refetch()}>Try again</Button></div>}
              {!prefsQ.isLoading && !(prefsQ.isError && !prefsQ.data) && prefs.length === 0 && (
                <div className="p-8"><EmptyState icon={Bell} title="No preference rows" body="Notification categories appear here once the server reports them." /></div>
              )}
              {prefs.map((p) => (
                <div key={p.category} className="flex items-center justify-between gap-4 p-5">
                  <div>
                    <Label className="mb-0">{PREF_LABELS[p.category] ?? p.category}</Label>
                    <p className="text-xs text-muted-foreground">Inbox + push delivery for {PREF_LABELS[p.category]?.toLowerCase() ?? p.category.toLowerCase()} events</p>
                  </div>
                  <Switch
                    checked={p.enabled}
                    onCheckedChange={(v) => {
                      void import('@/api/offers').then(({ updateNotificationPreferences }) =>
                        updateNotificationPreferences([{ category: p.category, enabled: v }]),
                      ).then(() => void prefsQ.refetch()).catch(() => setServerError('Preference update failed'))
                    }}
                  />
                </div>
              ))}
            </Card>
            {serverError && <p className="text-xs font-semibold text-destructive">{serverError}</p>}
          </motion.section>
        )}

        {/* ── OPS ── */}
        {tab === 'ops' && (
          <motion.section variants={container.item} className="space-y-4">
            <SystemHealth />
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card className="p-5">
                <h3 className="flex items-center gap-2 text-[15px] font-bold tracking-tight"><ServerCog className="h-4 w-4 text-brand-600" /> Outbox</h3>
                {outboxQ.isLoading ? <div role="status" aria-label="Loading outbox" className="mt-3 grid grid-cols-2 gap-3"><div className="skeleton h-20 rounded-xl" /><div className="skeleton h-20 rounded-xl" /></div> : outboxQ.isError && !outboxQ.data ? <div role="alert" className="mt-3 space-y-2 text-sm"><p>Could not load outbox status.</p><Button size="sm" variant="secondary" onClick={() => void outboxQ.refetch()}>Try again</Button></div> : <><dl className="mt-3 grid grid-cols-2 gap-3 text-[13px]">
                  <div className="rounded-xl border border-border/70 bg-muted/30 px-3 py-2.5">
                    <dt className="text-[11px] font-bold uppercase text-muted-foreground">Pending</dt>
                    <dd className="text-[22px] font-extrabold tabular">{outboxQ.data?.pending ?? '—'}</dd>
                  </div>
                  <div className="rounded-xl border border-border/70 bg-warning-soft/60 px-3 py-2.5">
                    <dt className="text-[11px] font-bold uppercase text-muted-foreground">Suspended</dt>
                    <dd className="text-[22px] font-extrabold tabular text-amber-600 dark:text-warning">{outboxQ.data?.suspended ?? '—'}</dd>
                  </div>
                </dl>
                <p className="mt-3 text-xs text-muted-foreground">
                  Oldest pending: {outboxQ.data?.oldestPending ? fmtDateTime(outboxQ.data.oldestPending) : '—'} · latest processed: {outboxQ.data?.latestProcessed ? fmtDateTime(outboxQ.data.latestProcessed) : '—'}
                </p></>}
                <p className="mt-2 text-[11px] text-muted-foreground">Suspended outbox rows replay per-consumer from the ops API when a downstream fix lands.</p>
              </Card>
              <Card className="p-5">
                <h3 className="flex items-center gap-2 text-[15px] font-bold tracking-tight"><RefreshCcw className="h-4 w-4 text-brand-600" /> Failed jobs</h3>
                <div className="mt-3 w-52">
                  <Select value={concern} onValueChange={setConcern} options={OPS_CONCERNS.map((c) => ({ value: c, label: `${c} jobs` }))} />
                </div>
                <div className="mt-3 space-y-1.5">
                  {(jobsQ.isLoading || jobsQ.isPlaceholderData) && <div className="skeleton h-16 w-full rounded-xl" role="status" aria-label="Loading failed jobs" />}
                  {jobsQ.isError && !jobsQ.data && <div className="space-y-2" role="alert"><p>Could not load failed jobs.</p><Button size="sm" variant="secondary" onClick={() => void jobsQ.refetch()}>Try again</Button></div>}
                  {!jobsQ.isLoading && !jobsQ.isPlaceholderData && !(jobsQ.isError && !jobsQ.data) && (jobsQ.data ?? []).length === 0 && (
                    <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No failed {concern} jobs</p>
                  )}
                  {!jobsQ.isPlaceholderData && (jobsQ.data ?? []).map((j) => (
                    <div key={j.id} className="flex items-center gap-3 rounded-xl border border-border/70 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-[12.5px] font-bold">{j.id.slice(0, 12)}…</p>
                        <p className="text-[11px] text-muted-foreground">{j.name} · attempts {j.attempts}{j.failedAt ? ` · ${fmtDateTime(j.failedAt)}` : ''}</p>
                      </div>
                      <Tooltip content="Replay this job">
                        <span>
                          <Button size="sm" variant="outline" onClick={() => systemActions.retryJob(concern, j.id).mutate(undefined, { onError: (e) => setServerError(e.message) })}>
                            <RefreshCcw className="h-3.5 w-3.5" /> Replay
                          </Button>
                        </span>
                      </Tooltip>
                    </div>
                  ))}
                </div>
                {serverError && <p className="mt-2 text-xs font-semibold text-destructive">{serverError}</p>}
              </Card>
            </div>
            <Card className="flex items-center gap-3 p-5 text-[13px]">
              <InboxIcon className="h-4 w-4 text-brand-600" />
              <span className="text-muted-foreground">Your own inbox lives under</span>
              <Badge tone="blue">Offers &rsaquo; My notifications</Badge>
            </Card>
          </motion.section>
        )}
      </motion.div>

    </div>
  )
}

/** Local hook wrapper for notification preferences (uses the offers api). */
function useNotificationPrefs() {
  return useQuery({ queryKey: ['notification-preferences'], queryFn: getNotificationPreferences, staleTime: 30_000 })
}

export default Settings
