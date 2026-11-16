import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Changing this value remounts the boundary (per-route reset on navigation). */
  resetKey?: string
}

interface State {
  error: Error | null
}

/**
 * Stale lazy-chunk loads (a dev-server restart or rebuild between the loaded
 * shell and a freshly navigated chunk) reject the dynamic import. One
 * automatic reload picks the new build up — the old "blank until I refresh"
 * behaviour, handled for the user. The timestamp guard prevents reload loops.
 */
function isStaleChunkError(error: Error): boolean {
  return /failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module|dynamically imported module/i.test(
    error.message,
  )
}

const CHUNK_RELOAD_KEY = 'admin-portal-chunk-reload-at'

/** One automatic reload (rate-limited) recovers a stale-chunk import failure. */
function maybeReloadForStaleChunk(): boolean {
  try {
    const last = Number(sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0)
    if (Date.now() - last < 5000) return false
    sessionStorage.setItem(CHUNK_RELOAD_KEY, String(Date.now()))
  } catch { /* private mode — still reload once */ }
  window.location.reload()
  return true
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[admin-portal] section crashed:', error.message, info.componentStack)
    if (isStaleChunkError(error) && maybeReloadForStaleChunk()) return
  }

  componentDidUpdate(prev: Props): void {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      // eslint-disable-next-line react/no-did-update-set-state
      this.setState({ error: null })
    }
  }

  render(): ReactNode {
    if (!this.state.error) {
      try { sessionStorage.removeItem(CHUNK_RELOAD_KEY) } catch { /* private mode */ }
      return this.props.children
    }
    return (
      <div className="page-bg grid min-h-full place-items-center p-6">
        <div className="w-full max-w-md rounded-card border border-border bg-card p-7 text-center shadow-lift">
          <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-destructive-soft text-xl">⚠️</div>
          <h2 className="mt-4 text-lg font-extrabold tracking-tight">This section hit a snag</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Something went wrong while rendering this page. Your data is safe — try again or head back to the dashboard.
          </p>
          <p className="mt-3 truncate rounded-lg bg-muted px-3 py-2 text-left text-[11px] font-medium text-muted-foreground" title={this.state.error.message}>
            {this.state.error.message}
          </p>
          <div className="mt-5 flex items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => this.setState({ error: null })}
              className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-white shadow-soft transition hover:bg-brand-700"
            >
              Try again
            </button>
            <a
              href="/dashboard"
              className="rounded-xl border border-border bg-card px-4 py-2 text-sm font-bold text-foreground transition hover:border-brand-300"
            >
              Dashboard
            </a>
          </div>
        </div>
      </div>
    )
  }
}
