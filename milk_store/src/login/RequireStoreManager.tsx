import { useEffect, useRef } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { useStoreAuth } from './authStore'

/**
 * Route guard: bootstraps the cookie session once per mount tree, then gates.
 * While the session is being resolved a skeleton renders (never a flash of the
 * login page), and unauthenticated visitors go to /login remembering where
 * they came from. Store-web has no cross-portal 403 — only store managers
 * reach this tree.
 */
export function RequireStoreManager({ children }: { children: JSX.Element }) {
  const status = useStoreAuth((s) => s.status)
  const bootstrap = useStoreAuth((s) => s.bootstrap)
  const booted = useRef(false)
  const location = useLocation()

  useEffect(() => {
    if (!booted.current) {
      booted.current = true
      void bootstrap()
    }
  }, [bootstrap])

  if (status === 'loading')
    return (
      <div className="page-bg grid min-h-full place-items-center p-4" aria-busy="true" aria-live="polite">
        <div className="flex flex-col items-center gap-3">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-brand-600 border-t-transparent" />
          <p className="text-sm font-semibold text-muted-foreground">Restoring your session…</p>
        </div>
      </div>
    )
  if (status !== 'authenticated')
    return <Navigate to="/login" state={{ from: location.pathname }} replace />
  return children
}
