import React, { lazy, Suspense } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import App from './App'
import { queryClient } from '@dairydirect/shared/lib/queryClient'
import { TooltipProvider } from '@dairydirect/shared/ui/overlays'
// SW registration is deferred (async) so it never blocks first paint
import('virtual:pwa-register').then((m) => m.registerSW({ immediate: true })).catch(() => {})
// leaflet CSS is imported inside the on-demand map chunk (ui/map)
import '@dairydirect/shared/styles/index.css'

// Toasts load on demand — nothing about them blocks first paint.
const Toaster = lazy(() => import('sonner').then((m) => ({ default: m.Toaster })))

// Queries talk to the real backend; the cookie session bootstraps in RequireStoreManager.
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
