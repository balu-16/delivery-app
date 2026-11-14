import React, { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { queryClient } from '@/lib/queryClient'
import { TooltipProvider } from '@/components/ui/overlays'
import { pageImports } from './routes'
// SW registration is deferred (async) so it never blocks first paint. In dev,
// unregister any stray service worker — a stale one would serve old chunks and
// blank out client-side navigation until a manual refresh.
import('virtual:pwa-register')
  .then((m) => {
    if (import.meta.env.DEV) {
      navigator.serviceWorker?.getRegistrations?.()
        .then((rs) => rs.forEach((r) => void r.unregister()))
        .catch(() => {})
      return
    }
    m.registerSW({ immediate: true })
  })
  .catch(() => {})
// leaflet CSS is imported inside the on-demand map chunk (components/shared/map)
import './index.css'

// Warm every route chunk once the browser is idle: after this, sidebar
// navigation never waits on a chunk load (no suspends, no skeletons mid-nav).
function warmRouteChunks() {
  Object.values(pageImports).forEach((load) => load().catch(() => {}))
}
if ('requestIdleCallback' in window) {
  window.requestIdleCallback(warmRouteChunks, { timeout: 4000 })
} else {
  setTimeout(warmRouteChunks, 2500)
}

// Toasts load on demand — nothing about them blocks first paint.
const Toaster = lazy(() => import('sonner').then((m) => ({ default: m.Toaster })))

// ── Legacy storage purge ─────────────────────────────────────────────────────
// The mock-era build persisted auth/journal/query caches to localStorage.
// Auth is now cookie-only and no session/query data may ever be persisted —
// remove the legacy keys while keeping unrelated ones (e.g. theme).
const LEGACY_KEYS = [
  'dairydirect-auth-v2',
  'dairydirect-journal-v2',
  'dairydirect-query-cache-v1',
  'dairydirect-subscription-config-v1',
  'dairydirect-subscription-config',
  'dairydirect-flags-v1',
]
for (const key of LEGACY_KEYS) {
  try { window.localStorage.removeItem(key) } catch { /* private mode */ }
  try { window.sessionStorage.removeItem(key) } catch { /* private mode */ }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <TooltipProvider>
          <App />
          <Suspense fallback={null}>
            <Toaster position="top-right" richColors closeButton offset={18} toastOptions={{ style: { borderRadius: '14px', fontFamily: 'Poppins, sans-serif' } }} />
          </Suspense>
        </TooltipProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
)
