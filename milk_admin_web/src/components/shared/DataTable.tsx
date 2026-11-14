import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, Inbox } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Checkbox, Skeleton } from '@/components/ui/base'

export interface Column<T> {
  key: string
  header: React.ReactNode
  render?: (row: T, index: number) => React.ReactNode
  className?: string
  headerClassName?: string
  align?: 'left' | 'right' | 'center'
}

export function DataTable<T extends { [k: string]: any }>({
  columns, rows, keyId, loading = false, selectable = false, selected = [], onSelectedChange,
  onRowClick, empty, skeletonRows = 5, footer, className,
}: {
  columns: Column<T>[]
  rows: T[]
  keyId: (row: T) => string
  loading?: boolean
  selectable?: boolean
  selected?: string[]
  onSelectedChange?: (ids: string[]) => void
  onRowClick?: (row: T) => void
  empty?: React.ReactNode
  skeletonRows?: number
  footer?: React.ReactNode
  className?: string
}) {
  const allSelected = rows.length > 0 && rows.every((r) => selected.includes(keyId(r)))
  const someSelected = rows.some((r) => selected.includes(keyId(r)))
  return (
    <div className={cn('overflow-hidden', className)}>
      <div className="scrollbar-thin overflow-x-auto">
        <table className="w-full min-w-[720px] border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              {selectable && (
                <th className="sticky top-0 z-10 w-10 border-b border-border bg-muted/40 px-4 py-3">
                  <Checkbox
                    ariaLabel="Select all"
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(v) => onSelectedChange?.(v ? rows.map(keyId) : [])}
                  />
                </th>
              )}
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn(
                    'sticky top-0 z-10 whitespace-nowrap border-b border-border bg-muted/40 px-4 py-3 text-[11.5px] font-bold uppercase tracking-wide text-muted-foreground',
                    c.align === 'right' && 'text-right',
                    c.align === 'center' && 'text-center',
                    c.headerClassName,
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: skeletonRows }).map((_, i) => (
                  <tr key={i}>
                    {selectable && <td className="border-b border-border/60 px-4 py-3.5"><Skeleton className="h-4 w-4 rounded" /></td>}
                    {columns.map((c) => (
                      <td key={c.key} className="border-b border-border/60 px-4 py-3.5"><Skeleton className="h-4 w-full max-w-[140px]" /></td>
                    ))}
                  </tr>
                ))
              : rows.map((row, i) => {
                  const id = keyId(row)
                  const isSel = selected.includes(id)
                  return (
                    <motion.tr
                      key={id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04, duration: 0.3 }}
                      className={cn(
                        'group transition-colors',
                        onRowClick && 'cursor-pointer',
                        isSel ? 'bg-primary-softer' : 'hover:bg-primary-softer/60',
                      )}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                    >
                      {selectable && (
                        <td className="border-b border-border/60 px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            ariaLabel={`Select ${id}`}
                            checked={isSel}
                            onCheckedChange={(v) => onSelectedChange?.(v ? [...selected, id] : selected.filter((s) => s !== id))}
                          />
                        </td>
                      )}
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          className={cn(
                            'border-b border-border/60 px-4 py-3 text-[13.5px]',
                            c.align === 'right' && 'text-right',
                            c.align === 'center' && 'text-center',
                            c.className,
                          )}
                        >
                          {c.render ? c.render(row, i) : String(row[c.key] ?? '')}
                        </td>
                      ))}
                    </motion.tr>
                  )
                })}
          </tbody>
        </table>
      </div>
      {!loading && rows.length === 0 && (empty ?? <DefaultEmpty />)}
      {footer}
    </div>
  )
}

export function DefaultEmpty({ title = 'Nothing here yet', body }: { title?: string; body?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary-soft text-brand-700 dark:text-brand-300">
        <Inbox className="h-6 w-6" />
      </div>
      <div className="text-sm font-bold">{title}</div>
      {body && <div className="max-w-xs text-xs text-muted-foreground">{body}</div>}
    </div>
  )
}

export function Pagination({
  page, totalPages, onChange, className, showing,
}: {
  page: number
  totalPages: number
  onChange: (p: number) => void
  className?: string
  showing?: string
}) {
  if (totalPages <= 0) return null
  const pages: Array<number | 'dots'> = []
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i)
  } else {
    pages.push(1)
    if (page > 3) pages.push('dots')
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i)
    if (page < totalPages - 2) pages.push('dots')
    pages.push(totalPages)
  }
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 px-5 py-3.5', className)}>
      {showing && <p className="text-xs font-medium text-muted-foreground">{showing}</p>}
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => onChange(Math.max(1, page - 1))}
          disabled={page === 1}
          className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition hover:border-brand-300 hover:text-foreground disabled:opacity-40"
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        {pages.map((p, i) =>
          p === 'dots' ? (
            <span key={`d${i}`} className="px-1 text-xs text-muted-foreground">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onChange(p)}
              className={cn(
                'grid h-8 min-w-8 place-items-center rounded-lg px-2 text-[13px] font-semibold transition-all',
                p === page ? 'gradient-primary text-white shadow-pill' : 'border border-border bg-card text-muted-foreground hover:border-brand-300 hover:text-foreground',
              )}
            >
              {p}
            </button>
          ),
        )}
        <button
          onClick={() => onChange(Math.min(totalPages, page + 1))}
          disabled={page === totalPages}
          className="grid h-8 w-8 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition hover:border-brand-300 hover:text-foreground disabled:opacity-40"
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
