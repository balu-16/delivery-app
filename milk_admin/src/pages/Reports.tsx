// ── §12 Reports & exports (REAL API: server previews + idempotent exports) ──
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  FileDown, ChevronLeft, ChevronRight, Clock, CheckCircle2, XCircle, RefreshCcw, Download,
} from 'lucide-react'
import { useStagger } from '@/hooks/misc'
import { useReportPreview, useExportJobs, useStoreOptions } from '@/hooks/queries'
import { useExportActions } from '@/hooks/mutations'
import { rangeToFromTo } from '@/api/mapping'
import { openDownloadUrl } from '@/api/http'
import { toast } from '@/lib/toast'
import { PageHeader, TabPills, StatusPill, EmptyState } from '@/components/shared/misc'
import { Select } from '@/components/ui/form'
import { Button, Card, Badge } from '@/components/ui/base'
import { DataTable } from '@/components/shared/DataTable'
import { ExportJobRow } from '@/components/shared/domain'
import type { ExportJob, RangeKey, ReportKind } from '@/types'
import { fmtDateTime } from '@/lib/utils'

const REPORT_TABS = [
  { value: 'catalog', label: 'Catalog' },
  { value: 'stock', label: 'Stock' },
  { value: 'financial', label: 'Financial' },
  { value: 'picking', label: 'Picking' },
  { value: 'rider', label: 'Rider activity' },
  { value: 'subscription', label: 'Subscriptions' },
  { value: 'support', label: 'Support' },
] as const

export function Reports() {
  const container = useStagger()
  const [kind, setKind] = useState<ReportKind>('catalog')
  const [range, setRange] = useState<RangeKey>('30d')
  const storesQ = useStoreOptions()
  const stores = storesQ.data ?? []
  const [storeId, setStoreId] = useState('all')

  const { from, to } = rangeToFromTo(range)
  const filters = { storeId: storeId === 'all' ? undefined : storeId, from, to }

  const [cursor, setCursor] = useState<string | null>(null)
  const [stack, setStack] = useState<Array<string | null>>([null])
  const previewQ = useReportPreview(kind, { ...filters, cursor: cursor ?? undefined, limit: 10 })
  const rows = previewQ.data?.items ?? []
  const columns = useMemoCols(rows)

  const jobsQ = useExportJobs()
  const jobs: ExportJob[] = jobsQ.data ?? []
  const exportsApi = useExportActions()
  const [creating, setCreating] = useState(false)

  useEffect(() => { setCursor(null); setStack([null]) }, [kind, storeId, range])

  // poll the newest export while one is queued/running
  const activeJob = jobs.find((j) => j.status === 'queued' || j.status === 'running')
  useEffect(() => {
    if (!activeJob) return
    const t = setInterval(() => void jobsQ.refetch(), 2000)
    return () => clearInterval(t)
  }, [activeJob?.id, jobsQ])

  const requestExport = () => {
    setCreating(true)
    const mutation = exportsApi.createJob(kind, filters)
    mutation.mutate(undefined, {
      onSuccess: (res) => {
        toast.success(`Export ${String(res.id).slice(0, 8)}… queued — poll below for the download`)
        setCreating(false)
      },
      onError: () => setCreating(false),
    })
  }

  const download = async (id: string) => {
    try {
      const url = await exportsApi.downloadJob(id)
      openDownloadUrl(url)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Download link could not be fetched')
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Reports &"
        titleAccent="exports"
        subtitle="Server-side report previews and export jobs with idempotent, evidence-backed downloads."
        artwork="reports"
        breadcrumb={['Reports']}
        actions={(
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="w-44">
              <Select value={storeId} onValueChange={setStoreId} options={[{ value: 'all', label: 'All stores' }, ...stores.map((s) => ({ value: s.id, label: s.name }))]} />
            </div>
            <Select value={range} onValueChange={(v) => setRange(v as RangeKey)} options={[
              { value: 'today', label: 'Today' }, { value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' }, { value: '90d', label: 'Last 90 days' },
            ]} />
            <Button variant="primary" size="md" disabled={creating} onClick={requestExport}>
              <FileDown className="h-4 w-4" /> {creating ? 'Requesting…' : 'Export this view'}
            </Button>
          </div>
        )}
      />

      <motion.div variants={container.container} initial="hidden" animate="show" className="space-y-4">
        <motion.div variants={container.item}>
          <TabPills
            id="reports-tabs"
            value={kind}
            onChange={(v) => setKind(v as ReportKind)}
            tabs={REPORT_TABS.map((t) => ({ value: t.value, label: t.label }))}
          />
        </motion.div>

        <motion.section variants={container.item}>
          <Card className="overflow-hidden">
            <DataTable
              keyId={(r: Record<string, unknown>) => String(r['id'] ?? JSON.stringify(r).slice(0, 40))}
              rows={rows}
              loading={previewQ.isLoading}
              empty={<EmptyState icon={Clock} title="No rows in this window" body="Try a wider range or different store." />}
              columns={columns}
            />
            <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
              <span className="text-xs text-muted-foreground">Page {stack.length} of the report feed</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" disabled={stack.length <= 1 || previewQ.isLoading} onClick={() => setStack((st) => { if (st.length <= 1) return st; const s = st.slice(0, -1); setCursor(s[s.length - 1] ?? null); return s })}>
                  <ChevronLeft className="h-3.5 w-3.5" /> Prev
                </Button>
                <Button size="sm" variant="outline" disabled={!previewQ.data?.nextCursor || previewQ.isLoading} onClick={() => {
                  const nc = previewQ.data?.nextCursor ?? null
                  if (!nc) return
                  setStack((st) => [...st, nc]); setCursor(nc)
                }}>
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </Card>
        </motion.section>

        {/* export jobs */}
        <motion.section variants={container.item}>
          <Card className="overflow-hidden">
            <div className="px-5 pt-5 pb-3">
              <h3 className="text-[15px] font-bold tracking-tight">Export jobs</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Files are generated server-side; downloads open the pre-signed URL</p>
            </div>
            {jobsQ.isLoading ? (
              <div className="space-y-2 px-5 pb-5">{[1, 2].map((i) => <div key={i} className="skeleton h-12 w-full rounded-xl" />)}</div>
            ) : jobs.length === 0 ? (
              <div className="px-5 pb-6"><EmptyState icon={Download} title="No exports yet" body="Request an export from the preview above." /></div>
            ) : (
              <div className="divide-y divide-border/60">
                {jobs.map((job) => (
                  <ExportJobRow
                    key={job.id}
                    job={{
                      id: job.id,
                      status: job.status === 'complete' ? 'complete' : job.status === 'failed' ? 'failed' : 'pending',
                      label: `${job.kind} report`,
                      filtersSummary: `${job.rowCount} rows · updated ${fmtDateTime(job.updatedAt)}`,
                      authorized: job.status === 'complete',
                      createdAt: job.createdAt,
                    }}
                    onDownload={() => void download(job.id)}
                  />
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3 border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-success" /> complete — downloadable</span>
              <span className="inline-flex items-center gap-1.5"><RefreshCcw className="h-3.5 w-3.5 text-info" /> queued/running — polls every 2s</span>
              <span className="inline-flex items-center gap-1.5"><XCircle className="h-3.5 w-3.5 text-destructive" /> failed — request again</span>
              <span className="ml-auto"><Badge tone="neutral"><StatusPill status={activeJob ? 'pending' : 'idle'} /></Badge></span>
            </div>
          </Card>
        </motion.section>
      </motion.div>
    </div>
  )
}

/** Derive generic columns from the first preview row (server-defined shapes). */
function useMemoCols(rows: Array<Record<string, unknown>>) {
  const first = rows[0] ?? {}
  const keys = Object.keys(first).slice(0, 6)
  return keys.map((k) => ({
    key: k,
    header: k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    render: (row: Record<string, unknown>) => {
      const v = row[k]
      if (v == null) return <span className="text-muted-foreground">—</span>
      if (typeof v === 'boolean') return <Badge tone={v ? 'green' : 'neutral'}>{v ? 'yes' : 'no'}</Badge>
      return <span className="text-[13px]">{String(v)}</span>
    },
  }))
}

export default Reports
