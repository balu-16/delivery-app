import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { SidebarNav, MobileSidebar, type SidebarConfig } from './Sidebar'
import { Topbar, type BellNotification } from './Topbar'
import { useUI } from './ui'
import { cn } from '../../lib/utils'

/** Applies the saved session theme once (user menu toggles it live afterwards). */
function useThemeEffect(themeKey: string) {
  useEffect(() => {
    const saved = localStorage.getItem(themeKey)
    if (saved === 'dark') document.documentElement.classList.add('dark')
  }, [themeKey])
}

export interface ShellUser {
  name: string
  email: string
  avatar: number
}

export interface AppShellProps {
  sidebar: SidebarConfig
  searchPlaceholder: string
  onSearchClick?: () => void
  /** Rendered between the menu button and the search bar (e.g. the store selector). */
  topbarLeft?: React.ReactNode
  userLabel?: string
  /** Signed-in user snapshot (each app feeds this from its own auth store). */
  user: ShellUser | null
  onSignOut: () => void
  /** User-menu shortcuts. */
  homePath: string
  settingsPath: string
  /** Per-app localStorage key for the theme preference. */
  themeKey: string
  /** Per-app session config: cross-tab logout watch + idle timeout behaviour. */
  sessionStorageKey: string
  onSessionExpire: () => void
  bellTitle?: string
  bellNotifications?: BellNotification[]
  onBellMarkAllRead?: () => void
  onBellMarkRead?: (id: string) => void
  /** Portal-specific overlay (e.g. the admin command palette). */
  overlay?: React.ReactNode
}

/** Idle timeout (30 min → warn at 28) + cross-tab logout via the app's session key. */
function useSessionGuard(sessionStorageKey: string, onSessionExpire: () => void) {
  useEffect(() => {
    const IDLE_MS = 30 * 60_000
    let last = Date.now()
    const bump = () => { last = Date.now() }
    const events: Array<keyof WindowEventMap> = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart']
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }))
    const onStorage = (e: StorageEvent) => {
      if (e.key === sessionStorageKey && e.newValue === null) {
        // another tab signed out → sign out here too
        window.location.reload()
      }
    }
    window.addEventListener('storage', onStorage)
    const timer = setInterval(() => {
      if (Date.now() - last > IDLE_MS - 120_000 && Date.now() - last < IDLE_MS) {
        import('../../lib/toast').then(({ toast }) => toast.warning('You will be signed out soon — move the mouse to stay logged in'))
      }
      if (Date.now() - last > IDLE_MS) onSessionExpire()
    }, 30_000)
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump))
      window.removeEventListener('storage', onStorage)
      clearInterval(timer)
    }
  }, [sessionStorageKey, onSessionExpire])
}

/** Generic portal shell — shared by AdminLayout and StoreLayout. No app imports here. */
export function AppShell({ sidebar, searchPlaceholder, onSearchClick, topbarLeft, userLabel, user, onSignOut, homePath, settingsPath, themeKey, sessionStorageKey, onSessionExpire, bellTitle, bellNotifications, onBellMarkAllRead, onBellMarkRead, overlay }: AppShellProps) {
  useThemeEffect(themeKey)
  useSessionGuard(sessionStorageKey, onSessionExpire)
  const location = useLocation()
  const mobileNavOpen = useUI((s) => s.mobileNavOpen)
  const setMobileNavOpen = useUI((s) => s.setMobileNavOpen)
  return (
    <div className="flex h-full">
      <aside className={cn('hidden shrink-0 lg:block', sidebar.variant === 'dark' ? '' : 'border-r border-border/60 bg-card')}>
        <SidebarNav config={sidebar} />
      </aside>
      <MobileSidebar config={sidebar} open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          searchPlaceholder={searchPlaceholder}
          onSearchClick={onSearchClick}
          left={topbarLeft}
          userLabel={userLabel}
          user={user}
          onSignOut={onSignOut}
          homePath={homePath}
          settingsPath={settingsPath}
          themeKey={themeKey}
          bellTitle={bellTitle}
          bellNotifications={bellNotifications}
          onBellMarkAllRead={onBellMarkAllRead}
          onBellMarkRead={onBellMarkRead}
        />
        <main className="page-bg scrollbar-thin flex-1 overflow-y-auto">
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
        </main>
      </div>
      {overlay}
    </div>
  )
}
