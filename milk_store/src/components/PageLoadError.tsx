import { AlertTriangle, RefreshCw } from 'lucide-react'
import { PageHeader } from '@dairydirect/shared/ui/misc'
import type { StoreArtwork } from '@dairydirect/shared/assets/storeArtwork'
import { Button } from '@dairydirect/shared/ui/base'

export interface PageQuery {
  isError: boolean
  error: unknown
  refetch: () => Promise<unknown>
}

/** Show an API failure instead of displaying fabricated empty data. */
export function firstFailedQuery(queries: PageQuery[]): PageQuery | undefined {
  const failed = queries.filter((query) => query.isError)
  if (!failed.length) return undefined
  return {
    isError: true,
    error: failed[0].error,
    refetch: () => Promise.all(failed.map((query) => query.refetch())),
  }
}

function requestMessage(query: PageQuery) {
  const status = (query.error as { status?: number } | null)?.status
  return status === 401
    ? 'Your session may have expired. Sign in again to continue.'
    : status === 403
      ? 'You do not have access to this store or this information.'
      : 'Check your connection and try again. The latest information could not be loaded.'
}

export function InlineLoadError({ query, label }: { query: PageQuery; label: string }) {
  return (
    <div role="alert" className="space-y-2 rounded-xl border border-border bg-card p-4 text-sm">
      <p className="font-semibold">Could not load {label}</p>
      <p className="text-muted-foreground">{requestMessage(query)}</p>
      <Button variant="outline" size="sm" onClick={() => { void query.refetch() }}>
        <RefreshCw className="h-3.5 w-3.5" /> Try again
      </Button>
    </div>
  )
}

export function PageLoadError({ title, artwork, query }: { title: string; artwork: StoreArtwork; query: PageQuery }) {
  const status = (query.error as { status?: number } | null)?.status
  return (
    <div className="space-y-5">
      <PageHeader title={title} artwork={artwork} />
      <div role="alert" className="rounded-card border border-border bg-card p-6 shadow-soft">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <h2 className="font-bold">Could not load this page</h2>
            <p className="mt-1 text-sm text-muted-foreground">{requestMessage(query)}</p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => { void query.refetch() }}>
                <RefreshCw className="h-3.5 w-3.5" /> Try again
              </Button>
              {status === 401 && <a href="/login" className="rounded-xl px-3 py-2 text-sm font-semibold text-brand-700 hover:underline dark:text-brand-300">Sign in</a>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
