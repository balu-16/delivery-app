// ── §14 Settings & system (REAL API: config, flags, prefs, ops) ──────────────
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Settings2, RefreshCcw, Save, ServerCog, Bell, Flag, Info, Inbox as InboxIcon,
} from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import { useConfig, useFailedJobs, useOutboxStatus } from '@/hooks/queries'
import { useQuery } from '@tanstack/react-query'
import { getNotificationPreferences } from '@/api/offers'
import { useSystemActions, useOfferActions } from '@/hooks/mutations'
import { PageHeader, TabPills, EmptyState } from '@/components/shared/misc'
import { Field, Select } from '@/components/ui/form'
import { Button, Card, Badge, Input, Switch, Label } from '@/components/ui/base'
import { Dialog, DialogContent, Tooltip } from '@/components/ui/overlays'
import { DataTable } from '@/components/shared/DataTable'
import type { NotificationPreference } from '@/types'
import { fmtDateTime } from '@/lib/utils'

type MainTab = 'config' | 'flags' | 'notifications' | 'ops'
interface ConfigRow { key: string }

const FLAG_LABELS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'cod_enabled', label: 'Cash on delivery', hint: 'COD payment option across storefront flows' },
  { key: 'wallets_enabled', label: 'Wallets', hint: 'Customer wallet top-ups and payments' },
  { key: 'subscriptions_enabled', label: 'Subscriptions', hint: 'Recurring delivery plans and generation runs' },
]

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

function ConfigValueEditor({ open, onOpenChange, configKey, initialValue, onSave, serverError }: {
  open: boolean
  onOpenChange: (v: boolean) => void
  configKey: string | null
  initialValue: unknown
  onSave: (key: string, value: unknown) => void
  serverError: string | null
}) {
  const [raw, setRaw] = useState('')
  useEffect(() => {
    if (open) setRaw(typeof initialValue === 'object' && initialValue !== null ? JSON.stringify(initialValue) : String(initialValue ?? ''))
  }, [open, configKey, initialValue])

  let parsed: unknown = raw
  try { parsed = JSON.parse(raw) } catch { /* keep raw string */ }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Edit ${configKey ?? ''}`} description="Values are validated server-side — conflicts surface as 409s">
        <div className="space-y-3">
          <Field label="Value (JSON or text)" required>
            <Input value={raw} onChange={(e) => setRaw(e.target.value)} className="font-mono" />
          </Field>
          <p className="text-[11px] text-muted-foreground">Current: <span className="font-mono">{typeof initialValue === 'object' ? JSON.stringify(initialValue) : String(initialValue ?? '—')}</span></p>
          {serverError && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{serverError}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" disabled={raw.length === 0} onClick={() => { if (configKey) { onSave(configKey, parsed); onOpenChange(false) } }}>
              <Save className="h-4 w-4" /> Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

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
  const [editKey, setEditKey] = useState<string | null>(null)

  const [concern, setConcern] = useState<string>('invoice')
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
              { value: 'config', label: 'Configuration' },
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
                {FLAG_LABELS.map((f) => {
                  const known = f.key in flags
                  const value = known ? !!flags[f.key] : true
                  return (
                    <div key={f.key} className="flex items-center justify-between gap-4 p-5">
                      <div>
                        <Label className="mb-0">{f.label}</Label>
                        <p className="text-xs text-muted-foreground">{f.hint}</p>
                        {!known && (
                          <p className="mt-1 flex items-center gap-1 text-[10.5px] font-semibold text-muted-foreground">
                            <Info className="h-3 w-3" /> not reported by the server — shown as enabled until configured
                          </p>
                        )}
                      </div>
                      <Switch checked={value} onCheckedChange={(v) => systemActions.updateFlag(f.key, v).mutate(undefined, { onError: (e) => setServerError(e.message) })} />
                    </div>
                  )
                })}
              </Card>
            )}
            {serverError && <p className="text-xs font-semibold text-destructive">{serverError}</p>}
          </motion.section>
        )}

        {/* ── CONFIG ── */}
        {tab === 'config' && (
          <motion.section variants={container.item} className="space-y-3">
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-warning-soft px-4 py-3 dark:border-amber-500/30">
              <Settings2 className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-warning" />
              <p className="text-[13px] font-medium leading-relaxed text-amber-800 dark:text-amber-200">
                These are typed platform rules (fees, thresholds, geo limits). Invalid values are rejected with the server's reason.
              </p>
            </div>
            <Card className="overflow-hidden">
              <DataTable
                keyId={(r: ConfigRow) => r.key}
                rows={Object.keys(configValues).map((k) => ({ key: k }))}
                loading={configQ.isLoading}
                empty={<EmptyState icon={Settings2} title="No configuration keys" body="Server config appears here." />}
                columns={[
                  { key: 'key', header: 'Key', render: (r: ConfigRow) => <span className="font-mono text-[12.5px] font-bold">{r.key}</span> },
                  {
                    key: 'value', header: 'Value',
                    render: (r: ConfigRow) => {
                      const v = configValues[r.key]
                      const text = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v ?? '—')
                      return <span className="block max-w-[420px] truncate font-mono text-[12px] text-muted-foreground">{text}</span>
                    },
                  },
                  {
                    key: 'actions', header: '', align: 'right' as const,
                    render: (r: ConfigRow) => (
                      <div className="flex justify-end">
                        <Button size="sm" variant="outline" onClick={() => setEditKey(r.key)}>
                          <Save className="h-3.5 w-3.5" /> Edit
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            </Card>
          </motion.section>
        )}

        {/* ── NOTIFICATIONS ── */}
        {tab === 'notifications' && (
          <motion.section variants={container.item} className="space-y-3">
            <Card className="divide-y divide-border/60">
              {prefsQ.isLoading && <div className="space-y-2 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 w-full rounded-xl" />)}</div>}
              {!prefsQ.isLoading && prefs.length === 0 && (
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
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Card className="p-5">
                <h3 className="flex items-center gap-2 text-[15px] font-bold tracking-tight"><ServerCog className="h-4 w-4 text-brand-600" /> Outbox</h3>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-[13px]">
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
                </p>
                <p className="mt-2 text-[11px] text-muted-foreground">Suspended outbox rows replay per-consumer from the ops API when a downstream fix lands.</p>
              </Card>
              <Card className="p-5">
                <h3 className="flex items-center gap-2 text-[15px] font-bold tracking-tight"><RefreshCcw className="h-4 w-4 text-brand-600" /> Failed jobs</h3>
                <div className="mt-3 w-52">
                  <Select value={concern} onValueChange={setConcern} options={OPS_CONCERNS.map((c) => ({ value: c, label: `${c} jobs` }))} />
                </div>
                <div className="mt-3 space-y-1.5">
                  {jobsQ.isLoading && <div className="skeleton h-16 w-full rounded-xl" />}
                  {!jobsQ.isLoading && (jobsQ.data ?? []).length === 0 && (
                    <p className="rounded-xl border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">No failed {concern} jobs</p>
                  )}
                  {(jobsQ.data ?? []).map((j) => (
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

      <ConfigValueEditor
        open={!!editKey}
        onOpenChange={(v) => { if (!v) setEditKey(null) }}
        configKey={editKey}
        initialValue={editKey ? configValues[editKey] : undefined}
        serverError={serverError}
        onSave={(k, value) => systemActions.updateConfigKey(k, value).mutate(undefined, {
          onError: (e) => setServerError(e.message),
          onSuccess: () => setServerError(null),
        })}
      />
    </div>
  )
}

/** Local hook wrapper for notification preferences (uses the offers api). */
function useNotificationPrefs() {
  return useQuery({ queryKey: ['notification-preferences'], queryFn: getNotificationPreferences, staleTime: 30_000 })
}

export default Settings
