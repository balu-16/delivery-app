import React, { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useAuth } from '@/store/auth'

/** Test-only copy of App.tsx's RequireAuth (same logic, no lazy pages). */
export function RequireAuth({ children }: { children: React.ReactNode }) {
  const status = useAuth((s) => s.status)
  const location = useLocation()
  useEffect(() => {
    if (status === 'bootstrapping') void useAuth.getState().bootstrap()
  }, [status])
  if (status === 'bootstrapping') return <div aria-busy="true" />
  if (status === 'anonymous') {
    return (
      <div>
        <span>login-redirect</span>
        <span>{location.pathname}</span>
      </div>
    )
  }
  return <>{children}</>
}
