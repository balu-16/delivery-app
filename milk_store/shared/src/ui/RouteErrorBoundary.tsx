import { Component, type ErrorInfo, type ReactNode } from 'react'

/** Keeps the navigation available if a page or a lazily loaded bundle fails. */
export class RouteErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // Do not put customer information or API response contents in the console.
    console.error('[store-portal] Unable to display this section.')
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" className="mx-auto max-w-lg rounded-card border border-border bg-card p-6 text-center shadow-soft">
        <h1 className="text-lg font-bold">This page could not be loaded</h1>
        <p className="mt-2 text-sm text-muted-foreground">Check your connection and reload the page, or return to the dashboard.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={() => window.location.reload()} className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white">Reload page</button>
          <a href="/dashboard" className="rounded-xl border border-border px-4 py-2 text-sm font-semibold">Dashboard</a>
        </div>
      </div>
    )
  }
}
