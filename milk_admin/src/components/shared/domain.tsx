import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  CheckCircle2, XCircle, Clock, ShieldCheck, Download, FileSpreadsheet, AlertTriangle,
  FileUp, Check, Loader2, RotateCcw, MapPin,
} from 'lucide-react'
import { cn, fmtDateTime } from '@/lib/utils'
import { Badge, Button, Card } from '@/components/ui/base'
import { Dialog, DialogContent } from '@/components/ui/overlays'
import { StatusPill } from '@/components/shared/misc'
import type { Approval, ExportJob } from '@/types'

/* ── ApprovalBadge — shows pending/approved state driven by record fields ── */
export function ApprovalBadge({ pendingApprovalId, label = 'Pending approval' }: { pendingApprovalId?: string | null; label?: string }) {
  if (!pendingApprovalId) return null
  return (
    <Badge tone="amber" className="gap-1.5">
      <Clock className="h-3 w-3" /> {label}
    </Badge>
  )
}

/* ── StatusTimeline — vertical step timeline driven by record timestamps ── */
export function StatusTimeline({ steps }: { steps: Array<{ label: string; at?: string; note?: string } | null> }) {
  const visible = steps.filter(Boolean) as Array<{ label: string; at?: string; note?: string }>
  const firstPending = visible.findIndex((s) => !s.at)
  return (
    <ol className="relative space-y-1">
      {visible.map((s, i) => {
        const done = !!s.at
        const current = i === firstPending
        return (
          <li key={`${s.label}-${i}`} className="relative flex gap-3 pb-4 last:pb-0">
            {i < visible.length - 1 && <span className="absolute left-[11px] top-6 h-full w-0.5 bg-border" aria-hidden />}
            <span
              className={cn(
                'relative z-10 grid h-6 w-6 shrink-0 place-items-center rounded-full ring-4 ring-card',
                done ? 'bg-success text-white' : current ? 'bg-info text-white animate-pulse-soft' : 'bg-muted text-muted-foreground',
              )}
            >
              {done ? <Check className="h-3.5 w-3.5" strokeWidth={3} /> : current ? <span className="h-2 w-2 rounded-full bg-white" /> : <span className="h-1 w-1 rounded-full bg-current" />}
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className={cn('text-[13px] font-semibold', !done && !current && 'text-muted-foreground')}>{s.label}</div>
              <div className="text-[11px] text-muted-foreground">{s.at ? fmtDateTime(s.at) : s.note ?? '—'}</div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/* ── ExportJobRow — one export job with authorized download only when Complete ── */
export interface ExportJobRowData {
  id: string
  status: 'pending' | 'complete' | 'failed'
  label: string
  filtersSummary: string
  rowCount?: number
  authorized: boolean
  createdAt: string
  error?: string
}

export function ExportJobRow({ job, onDownload }: { job: ExportJobRowData; onDownload: (job: ExportJobRowData) => void }) {
  const tone = job.status === 'complete' ? 'green' : job.status === 'failed' ? 'red' : 'amber'
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3"
    >
      <span className={cn(
        'grid h-9 w-9 shrink-0 place-items-center rounded-xl',
        job.status === 'complete' ? 'bg-success-soft text-success' : job.status === 'failed' ? 'bg-destructive-soft text-destructive' : 'bg-warning-soft text-amber-600 dark:text-warning',
      )}>
        {job.status === 'pending' ? <Loader2 className="h-4 w-4 animate-spin" /> : job.status === 'failed' ? <AlertTriangle className="h-4 w-4" /> : <FileSpreadsheet className="h-4 w-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold">
          <span className="truncate">{job.label}</span>
          <StatusPill status={job.status === 'complete' ? 'completed' : job.status} />
        </div>
        <p className="truncate text-xs text-muted-foreground">{job.filtersSummary}{job.rowCount ? ` · ${job.rowCount.toLocaleString('en-IN')} rows` : ''}{job.error ? ` · ${job.error}` : ''}</p>
      </div>
      <span className="text-[11px] text-muted-foreground">{fmtDateTime(job.createdAt)}</span>
      {job.status === 'complete' && job.authorized ? (
        <Button size="sm" variant="outline" onClick={() => onDownload(job)}>
          <Download className="h-3.5 w-3.5" /> Download
        </Button>
      ) : job.status === 'complete' ? (
        <span className="text-[11px] font-semibold text-muted-foreground">Not authorized</span>
      ) : job.status === 'failed' ? (
        <Badge tone="red">Failed</Badge>
      ) : (
        <Badge tone="amber">Pending…</Badge>
      )}
    </motion.div>
  )
}

/* ── CsvImportWizard — upload → DRY RUN → error table → confirm apply ── */
export interface CsvRowError { row: number; field: string; error: string }
export interface CsvImportResult<T> { rows: T[]; errors: CsvRowError[]; totalRows: number }

export function CsvImportWizard<T>({
  open, onOpenChange, title, templateHeader, validateRow, onApply, itemNoun = 'rows',
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  templateHeader: string
  validateRow: (row: Record<string, string>, index: number) => T | CsvRowError
  onApply: (rows: T[]) => void
  itemNoun?: string
}) {
  const [phase, setPhase] = useState<'upload' | 'review'>('upload')
  const [parsed, setParsed] = useState<CsvImportResult<T> | null>(null)
  const [fileName, setFileName] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const reset = () => { setPhase('upload'); setParsed(null); setFileName('') }

  const handleFile = async (file: File) => {
    const text = await file.text()
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
    if (lines.length === 0) return
    const header = lines[0]!.split(',').map((h) => h.trim().toLowerCase())
    const rows: T[] = []
    const errors: CsvRowError[] = []
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i]!.split(',').map((c) => c.trim())
      const obj: Record<string, string> = {}
      header.forEach((h, idx) => { obj[h] = cols[idx] ?? '' })
      const res = validateRow(obj, i)
      if (res && typeof res === 'object' && 'row' in (res as CsvRowError)) errors.push(res as CsvRowError)
      else rows.push(res as T)
    }
    setFileName(file.name)
    setParsed({ rows, errors, totalRows: lines.length - 1 })
    setPhase('review')
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v) }}>
      <DialogContent title={title} description="Upload → dry-run validation → review errors → apply only if clean" wide>
        {phase === 'upload' ? (
          <div>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault(); setDragOver(false)
                const f = e.dataTransfer.files?.[0]
                if (f) void handleFile(f)
              }}
              className={cn(
                'grid place-items-center gap-3 rounded-xl border-2 border-dashed p-10 text-center transition',
                dragOver ? 'border-brand-400 bg-primary-soft' : 'border-border',
              )}
            >
              <FileUp className="h-8 w-8 text-muted-foreground" />
              <div>
                <p className="text-sm font-semibold">Drop a .csv file here, or</p>
                <label className="mt-2 inline-flex cursor-pointer items-center gap-2 rounded-full gradient-primary px-4 py-2 text-xs font-bold text-white shadow-pill">
                  Choose file
                  <input type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f) }} />
                </label>
              </div>
              <p className="text-[11px] text-muted-foreground">Expected header: <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{templateHeader}</code></p>
            </div>
            <p className="mt-3 rounded-lg bg-primary-softer px-3 py-2 text-[11px] font-medium text-brand-700 dark:text-brand-300">
              Dry run: the file is validated row-by-row first. Nothing is applied until you confirm on the next step.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-muted/60 px-4 py-3 text-sm">
              <div className="font-semibold">{fileName}</div>
              <div className="flex items-center gap-2 text-xs">
                <Badge tone="green">{parsed!.rows.length} valid</Badge>
                <Badge tone={parsed!.errors.length ? 'red' : 'green'}>{parsed!.errors.length} errors</Badge>
                <Badge>{parsed!.totalRows} total</Badge>
              </div>
            </div>
            {parsed!.errors.length > 0 && (
              <div className="overflow-hidden rounded-xl border border-border">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="bg-muted/60 text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2">Row</th>
                      <th className="px-3 py-2">Field</th>
                      <th className="px-3 py-2">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed!.errors.slice(0, 12).map((e, i) => (
                      <tr key={i} className="border-t border-border/60">
                        <td className="px-3 py-2 font-bold tabular">{e.row}</td>
                        <td className="px-3 py-2 font-medium">{e.field}</td>
                        <td className="px-3 py-2 text-destructive">{e.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {parsed!.errors.length > 12 && <p className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">+{parsed!.errors.length - 12} more errors…</p>}
              </div>
            )}
            <div className="flex items-center justify-between">
              <Button variant="secondary" size="md" onClick={reset}><RotateCcw className="h-4 w-4" /> Choose another file</Button>
              <Button
                variant="primary" size="md"
                disabled={parsed!.rows.length === 0}
                onClick={() => { onApply(parsed!.rows); reset(); onOpenChange(false) }}
              >
                <Check className="h-4 w-4" /> Apply {parsed!.rows.length} {itemNoun}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ── ApprovalCard — maker-checker queue card driven by backend approval rows ── */
export interface ApprovalCardData {
  id: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  canApprove: boolean
  cannotApproveReason?: string
}

export function ApprovalCard({ approval, onDecide, children }: {
  approval: ApprovalCardData
  onDecide: (id: string, status: 'completed' | 'rejected') => void
  /** Page-provided details (action label, maker/checker, metadata). */
  children?: React.ReactNode
}) {
  const tone = approval.status === 'pending' ? 'amber' : approval.status === 'approved' ? 'green' : approval.status === 'rejected' ? 'red' : 'neutral'
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      className="rounded-card border border-border/70 bg-card p-4 shadow-soft"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-bold">
          <ShieldCheck className={cn('h-4 w-4', approval.status === 'pending' ? 'text-warning' : 'text-brand-600')} />
          Maker-checker approval
        </div>
        <Badge tone={tone as 'amber' | 'green' | 'red' | 'neutral'}>{approval.status.toUpperCase()}</Badge>
      </div>
      {children && <div className="mt-3">{children}</div>}
      {approval.status === 'pending' && !approval.canApprove && (
        <p className="mt-3 text-[11px] font-medium text-muted-foreground" title={approval.cannotApproveReason}>
          <XCircle className="mr-1 inline h-3.5 w-3.5 text-destructive" />
          {approval.cannotApproveReason ?? 'You cannot approve this item'}
        </p>
      )}
      {approval.status === 'pending' && approval.canApprove && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => onDecide(approval.id, 'rejected')}>Reject</Button>
          <Button size="sm" variant="primary" onClick={() => onDecide(approval.id, 'completed')}>
            <CheckCircle2 className="h-3.5 w-3.5" /> Approve
          </Button>
        </div>
      )}
    </motion.div>
  )
}

/* ── Simple section header used inside pages ── */
export function SectionCard({ title, subtitle, children, className, action }: { title: string; subtitle?: string; children: React.ReactNode; className?: string; action?: React.ReactNode }) {
  return (
    <Card className={cn('rounded-card', className)}>
      <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
        <div>
          <h3 className="text-[15px] font-bold tracking-tight">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {action}
      </div>
      <div className="px-5 pb-5">{children}</div>
    </Card>
  )
}

export function ZoneLegend() {
  return (
    <div className="pointer-events-none absolute left-3 top-3 z-[500] rounded-xl border border-border bg-card/95 p-3 shadow-soft">
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold"><MapPin className="h-3 w-3 text-brand-600" /> Service zones</p>
      <div className="space-y-1 text-[11px] text-muted-foreground">
        <p className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm bg-brand-600/40 ring-1 ring-brand-600" /> Priority 1</p>
        <p className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm bg-amber-400/40 ring-1 ring-amber-500" /> Priority 2</p>
        <p className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-sm bg-sky-400/40 ring-1 ring-sky-500" /> Priority 3</p>
      </div>
    </div>
  )
}

export function XCircleIcon() {
  return <XCircle className="h-4 w-4" />
}
