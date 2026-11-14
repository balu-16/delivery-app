import { Suspense, useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { SidebarNav, MobileSidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { CommandPalette } from './CommandPalette'
import { useUI } from './ui'
import { RouteFallback } from '@/components/shared/RouteFallback'

/** Applies the saved session theme once (user menu toggles it live afterwards). */
function useThemeEffect() {
  useEffect(() => {
    const saved = localStorage.getItem('dairydirect-theme')
    if (saved === 'dark') document.documentElement.classList.add('dark')
  }, [])
}

/** Pauses every looping CSS animation while the tab is hidden (battery/CPU). */
function useTabHiddenPause() {
  useEffect(() => {
    const onVis = () => document.body.classList.toggle('tab-hidden', document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
}

export function AppLayout() {
  useThemeEffect()
  useTabHiddenPause()
  const location = useLocation()
  const mobileNavOpen = useUI((s) => s.mobileNavOpen)
  const setMobileNavOpen = useUI((s) => s.setMobileNavOpen)
  return (
    <div className="flex h-full">
      {/* desktop sidebar */}
      <aside className="hidden shrink-0 border-r border-border/60 bg-card lg:block">
        <SidebarNav />
      </aside>
      <MobileSidebar open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="page-bg scrollbar-thin flex-1 overflow-y-auto">
          {/* Hoisted above AnimatePresence on purpose: when a freshly navigated
              route suspends (lazy chunk loading), this boundary shows the
              skeleton. A Suspense INSIDE the keyed motion.div would never commit
              during mode="wait", leaving the area blank instead. */}
          <Suspense fallback={<RouteFallback />}>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className="mx-auto w-full max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8"
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </Suspense>
        </main>
      </div>
      <CommandPalette />
    </div>
  )
}
