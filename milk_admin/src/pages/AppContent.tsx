// ── App content & notification templates (customize2 §3E) ───────────────────
import { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Edit3, History, Images } from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import { useAppContent, useAppContentHistory, useNotificationTemplates, useNotificationTemplateHistory } from '@/hooks/queries'
import { useAppContentActions } from '@/hooks/mutations'
import { APP_CONTENT_DESTINATIONS, APP_CONTENT_SLOTS, type AppContentLocale, type AppContentRecord, type AppContentSlot } from '@/api/app-content'
import { createCatalogMediaTarget, registerCatalogMedia, uploadToTarget } from '@/api/catalog'
import { ApiError } from '@/api/http'
import { PageHeader, TabPills, tabCount, EmptyState } from '@/components/shared/misc'
import { Button, Card, Badge, Input, Textarea, Label } from '@/components/ui/base'
import { Dialog, DialogContent } from '@/components/ui/overlays'
import { Field, Select } from '@/components/ui/form'

type Tab = 'content' | 'templates'
const LOCALES: AppContentLocale[] = ['en', 'hi', 'te']

function versionText(error: unknown): string {
  if (error instanceof ApiError && error.status === 409)
    return 'Another admin saved first (version changed). Reload and try again.'
  return error instanceof Error ? error.message : 'The server rejected the save.'
}

function ContentDialog({ record, onOpenChange, onSaved }: {
  record: AppContentRecord | null
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const actions = useAppContentActions()
  const historyQ = useAppContentHistory(record?.slot ?? null, record?.locale ?? null)
  const [enabled, setEnabled] = useState(record?.enabled ?? false)
  const [title, setTitle] = useState(record?.title ?? '')
  const [body, setBody] = useState(record?.body ?? '')
  const [destination, setDestination] = useState(record?.destination ?? '')
  const [imageMediaId, setImageMediaId] = useState(record?.imageMediaId ?? '')
  const [startAt, setStartAt] = useState(record?.startAt ? record.startAt.slice(0, 16) : '')
  const [endAt, setEndAt] = useState(record?.endAt ? record.endAt.slice(0, 16) : '')
  const [error, setError] = useState<string | null>(null)
  const [restoreId, setRestoreId] = useState<string | null>(null)

  if (!record) return null
  const slot: AppContentSlot = record.slot
  const locale: AppContentLocale = record.locale
  const preview = { title, body }
  const invalid = Boolean(
    (enabled && (!title.trim() || title.length > 200 || !body.trim() || body.length > 2000)) ||
    (destination && !APP_CONTENT_DESTINATIONS[slot].some(
      (prefix) => destination === prefix || destination.startsWith(`${prefix}/`) || destination.startsWith(`${prefix}?`),
    )) ||
    (startAt && endAt && new Date(endAt) <= new Date(startAt)),
  )

  const toLocal = (value: string) => (value ? new Date(value).toISOString() : null)
  const save = (enable: boolean) => {
    setError(null)
    actions.writeContent(slot, locale, {
      enabled: enable,
      title: title || null,
      body: body || null,
      imageMediaId: imageMediaId || null,
      destination: destination || null,
      startAt: toLocal(startAt),
      endAt: toLocal(endAt),
      expectedVersion: record.version,
    }).mutate(undefined, {
      onError: (e) => setError(versionText(e)),
      onSuccess: () => { setError(null); onSaved(); onOpenChange(false) },
    })
  }
  const restore = (entryId: string) => {
    const entry = historyQ.data?.find((item) => item.id === entryId)
    if (!entry) return
    setError(null)
    actions.writeContent(slot, locale, {
      enabled: entry.enabled,
      title: entry.title,
      body: entry.body,
      imageMediaId: entry.imageMediaId,
      destination: entry.destination,
      startAt: entry.startAt,
      endAt: entry.endAt,
      expectedVersion: record.version,
    }).mutate(undefined, {
      onError: (e) => setError(versionText(e)),
      onSuccess: () => { setError(null); onSaved(); onOpenChange(false) },
    })
  }
  const upload = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    try {
      const target = await createCatalogMediaTarget('CONTENT_IMAGE', file.type || 'image/jpeg', file.size)
      await uploadToTarget(target, file)
      await registerCatalogMedia(target.mediaId)
      setImageMediaId(target.mediaId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Image upload failed.')
    }
  }

  return (
    <Dialog open={!!record} onOpenChange={onOpenChange}>
      <DialogContent title={`${slot} · ${locale}`} description="Preview is the edited values; Publish/Disable writes a new version (audit kept in history for restore)">
        <div className="space-y-3">
          <div className="rounded-xl border border-border/70 bg-muted/30 p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Preview</p>
            <p className="font-bold">{preview.title || '—'}</p>
            <p className="text-[13px] text-foreground/85">{preview.body || '—'}</p>
            {destination && <p className="text-xs text-muted-foreground">Tap → {destination}</p>}
            {imageMediaId && <p className="text-xs text-muted-foreground">Image: {imageMediaId}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Title" required={enabled}><Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></Field>
            <Field label="Destination (optional)" hint={`Allowed: ${APP_CONTENT_DESTINATIONS[slot].join(', ')}`}>
              <Select value={destination} onValueChange={setDestination} options={[{ value: '', label: 'None' }, ...APP_CONTENT_DESTINATIONS[slot].map((value) => ({ value, label: value }))]} />
            </Field>
          </div>
          <Field label="Body" required={enabled}><Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} /></Field>
          <Field label="Content image (optional)" hint="Registered content image; never a product-publication requirement">
            <div className="flex items-center gap-2">
              <Input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => void upload(event.target.files?.[0])} />
              {imageMediaId && <img src={`/media/${imageMediaId}`} alt="Content preview" className="h-10 w-10 rounded object-cover" />}
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start (UTC, optional)"><Input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} /></Field>
            <Field label="End (UTC, optional)"><Input type="datetime-local" value={endAt} onChange={(e) => setEndAt(e.target.value)} /></Field>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] font-semibold">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-input accent-[#2E7D1A]" />
            Enabled (publish); unchecked writes a disabled record that hides the slot
          </label>
          {error && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{error}</p>}
          <div className="space-y-2">
            <Label>History (restore writes a new validated version)</Label>
            <div className="max-h-28 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
              {(historyQ.data ?? []).map((entry) => (
                <button
                  key={entry.id} type="button"
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[12px] hover:bg-muted ${restoreId === entry.id ? 'bg-muted' : ''}`}
                  onClick={() => setRestoreId(entry.id)}
                >
                  <span>v{entry.version} · {entry.enabled ? 'enabled' : 'disabled'} · {entry.title ?? '—'}</span>
                </button>
              ))}
              {(historyQ.data ?? []).length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No prior versions.</p>}
            </div>
            <Button size="sm" variant="outline" disabled={!restoreId} onClick={() => restoreId && restore(restoreId)}>
              <History className="h-3.5 w-3.5" /> Restore selected
            </Button>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="secondary" size="md" disabled={invalid} onClick={() => save(false)}>Disable</Button>
            <Button variant="primary" size="md" disabled={invalid} onClick={() => save(true)}>Publish</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TemplateDialog({ entry, entries, onOpenChange, onSaved }: {
  entry: { templateKey: string; locale: string; channel: string; subject: string; body: string; version: number; source: string; placeholders: string[]; preview: { subject: string; body: string } } | null
  entries: Array<{ templateKey: string; locale: string; channel: string; subject: string; body: string; version: number; source: string; placeholders: string[]; preview: { subject: string; body: string } }>
  onOpenChange: (v: boolean) => void
  onSaved: () => void
}) {
  const actions = useAppContentActions()
  const historyQ = useNotificationTemplateHistory(entry?.templateKey ?? null, entry?.locale ?? null, entry?.channel ?? null)
  const [subject, setSubject] = useState(entry?.subject ?? '')
  const [body, setBody] = useState(entry?.body ?? '')
  const [error, setError] = useState<string | null>(null)
  const [restoreId, setRestoreId] = useState<string | null>(null)
  if (!entry) return null
  const used = [...subject.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]{0,63})\}\}/g)].map((match) => match[1]!)
  const unknown = used.filter((key) => !entry.placeholders.includes(key))
  const invalid = !subject.trim() || subject.length > 200 || !body.trim() || body.length > 2000 || unknown.length > 0
  const seeded = entries.find((item) => item.templateKey === entry.templateKey && item.locale === entry.locale && item.channel === entry.channel && item.source === 'default')
  const save = (nextSubject: string, nextBody: string) => {
    setError(null)
    actions.writeTemplate(entry.templateKey, entry.locale, entry.channel, {
      subject: nextSubject,
      body: nextBody,
      expectedVersion: entry.version,
    }).mutate(undefined, {
      onError: (e) => setError(versionText(e)),
      onSuccess: () => { setError(null); onSaved(); onOpenChange(false) },
    })
  }
  const restore = (entryId: string) => {
    const item = historyQ.data?.find((row) => row.id === entryId)
    if (!item) return
    save(item.subject, item.body)
  }
  return (
    <Dialog open={!!entry} onOpenChange={onOpenChange}>
      <DialogContent title={`${entry.templateKey} · ${entry.locale} · ${entry.channel}`} description="Allowed placeholders come from the event matrix; sample preview below">
        <div className="space-y-3">
          <div className="rounded-xl border border-border/70 bg-muted/30 p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Sample preview</p>
            <p className="font-bold">{entry.preview.subject}</p>
            <p className="text-[13px] text-foreground/85">{entry.preview.body}</p>
          </div>
          <Field label="Allowed placeholders" hint={entry.placeholders.join(', ') || 'none'}><p className="text-xs text-muted-foreground">{entry.placeholders.map((key) => `{{${key}}}`).join(' ') || 'No placeholders for this template.'}</p></Field>
          <Field label="Subject" required error={unknown.length ? `Unknown: ${unknown.join(', ')}` : undefined}><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></Field>
          <Field label="Body" required><Textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} /></Field>
          {error && <p className="rounded-lg bg-destructive-soft px-3 py-2 text-xs font-semibold text-destructive">{error}</p>}
          <div className="space-y-2">
            <Label>History (restore writes a new validated version)</Label>
            <div className="max-h-28 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
              {(historyQ.data ?? []).map((item) => (
                <button key={item.id} type="button" className={`block w-full rounded-md px-2 py-1 text-left text-[12px] hover:bg-muted ${restoreId === item.id ? 'bg-muted' : ''}`} onClick={() => setRestoreId(item.id)}>
                  v{item.version} · {item.subject}
                </button>
              ))}
              {(historyQ.data ?? []).length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">No prior versions.</p>}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={!restoreId} onClick={() => restoreId && restore(restoreId)}>
                <History className="h-3.5 w-3.5" /> Restore selected
              </Button>
              {seeded && <Button size="sm" variant="outline" disabled={invalid} onClick={() => save(seeded.subject, seeded.body)}>Restore to seeded copy</Button>}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="md" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button variant="primary" size="md" disabled={invalid} onClick={() => save(subject, body)}>Save copy</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function AppContent() {
  const container = useStagger()
  const [tab, setTab] = useState<Tab>('content')
  const [editing, setEditing] = useState<AppContentRecord | null>(null)
  const [editingTemplate, setEditingTemplate] = useState<number | null>(null)
  const contentQ = useAppContent()
  const templatesQ = useNotificationTemplates()
  const records = contentQ.data ?? []
  const templates = useMemo(() => templatesQ.data ?? [], [templatesQ.data])

  return (
    <div className="space-y-5">
      <PageHeader
        title="App content &"
        titleAccent="message copy"
        subtitle="Slots shown in the customer and rider apps, and notification template copy."
        artwork="offers"
        breadcrumb={['App content']}
      />
      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-4">
        <motion.div variants={container.item}>
          <TabPills
            id="app-content-tabs"
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            tabs={[
              { value: 'content', label: 'App content', count: tabCount(contentQ, records.length) },
              { value: 'templates', label: 'Notification templates', count: tabCount(templatesQ, templates.length) },
            ]}
          />
        </motion.div>
        {tab === 'content' && (
          <motion.section variants={container.item} className="space-y-3">
            {contentQ.isLoading && <div className="space-y-2 p-5" role="status" aria-label="Loading app content">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 w-full rounded-xl" />)}</div>}
            {contentQ.isError && !contentQ.data && <div className="p-5" role="alert"><p>Could not load app content.</p><Button size="sm" variant="secondary" onClick={() => void contentQ.refetch()}>Try again</Button></div>}
            <div className="space-y-2">
              {APP_CONTENT_SLOTS.map((slot) => {
                const rows = records.filter((record) => record.slot === slot)
                return (
                  <Card key={slot} className="p-4">
                    <div className="mb-2 flex items-center justify-between">
                      <p className="font-bold">{slot}</p>
                      <Badge tone="neutral">{APP_CONTENT_DESTINATIONS[slot].join(' · ')}</Badge>
                    </div>
                    <div className="divide-y divide-border/60">
                      {rows.map((record) => (
                        <div key={`${slot}-${record.locale}`} className="flex items-center justify-between gap-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-[13px] font-semibold">{record.title ?? 'Default (unset — apps use bundled copy)'}</p>
                            <p className="truncate text-xs text-muted-foreground">{record.locale} · v{record.version} · {record.enabled ? 'enabled' : 'disabled'}{record.destination ? ` · → ${record.destination}` : ''}{record.imageMediaId ? ' · has image' : ''}</p>
                          </div>
                          <Button size="sm" variant="outline" onClick={() => setEditing(record)}>
                            <Edit3 className="h-3.5 w-3.5" /> {record.version === 0 ? 'Publish' : 'Edit'}
                          </Button>
                        </div>
                      ))}
                    </div>
                  </Card>
                )
              })}
            </div>
            {records.length === 0 && !contentQ.isLoading && (
              <EmptyState icon={Images} title="No app content" body="Publish a slot to replace the app's bundled copy." />
            )}
          </motion.section>
        )}
        {tab === 'templates' && (
          <motion.section variants={container.item} className="space-y-3">
            {templatesQ.isLoading && <div className="space-y-2 p-5" role="status" aria-label="Loading templates">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 w-full rounded-xl" />)}</div>}
            {templatesQ.isError && !templatesQ.data && <div className="p-5" role="alert"><p>Could not load templates.</p><Button size="sm" variant="secondary" onClick={() => void templatesQ.refetch()}>Try again</Button></div>}
            <div className="space-y-2">
              {templates.map((entry, index) => (
                <Card key={`${entry.templateKey}-${entry.locale}-${entry.channel}`} className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold">{entry.templateKey} <span className="font-normal text-muted-foreground">{entry.locale} · {entry.channel} · v{entry.version} · {entry.source}</span></p>
                    <p className="truncate text-xs text-muted-foreground">{entry.preview.subject} — {entry.preview.body}</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setEditingTemplate(index)}>
                    <Edit3 className="h-3.5 w-3.5" /> Edit
                  </Button>
                </Card>
              ))}
            </div>
            {templates.length === 0 && !templatesQ.isLoading && (
              <EmptyState icon={Images} title="No templates" body="Supported notification templates will appear here." />
            )}
          </motion.section>
        )}
      </motion.div>
      <ContentDialog
        record={editing}
        onOpenChange={(v) => { if (!v) setEditing(null) }}
        onSaved={() => void contentQ.refetch()}
      />
      <TemplateDialog
        entry={editingTemplate == null ? null : templates[editingTemplate] ?? null}
        entries={templates}
        onOpenChange={(v) => { if (!v) setEditingTemplate(null) }}
        onSaved={() => void templatesQ.refetch()}
      />
    </div>
  )
}
