import { NavLink, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import {
  LayoutDashboard, Store, Package, Boxes, ShoppingCart, Users, Wallet, Bike, Tags,
  CalendarClock, Headset, FileOutput, ClipboardCheck, Settings2, ChevronLeft, ChevronRight, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Logo } from '@/illustrations/Logo'
import { useUI } from './ui'
import { Tooltip } from '@/components/ui/overlays'
import { NAV_PATH_IMPORTS } from '@/routes'

/** Hover/focus prefetch: warms the route chunk for the section. A stale
 * prefetch (dev restart between builds) rejects quietly — the real navigation
 * handles recovery via the route ErrorBoundary. */
function warmRoute(path: string) {
  NAV_PATH_IMPORTS[path]?.().catch(() => {})
}

// The 14 spec sections, exactly in order.
export const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/stores', label: 'Stores & service areas', icon: Store },
  { to: '/products', label: 'Products & pricing', icon: Package },
  { to: '/inventory', label: 'Inventory', icon: Boxes },
  { to: '/orders', label: 'Orders & delivery', icon: ShoppingCart },
  { to: '/people', label: 'People', icon: Users },
  { to: '/payments', label: 'Payments, refunds & wallets', icon: Wallet },
  { to: '/payouts', label: 'Rider payouts & COD', icon: Bike },
  { to: '/offers', label: 'Offers & notifications', icon: Tags },
  { to: '/subscriptions', label: 'Subscriptions', icon: CalendarClock },
  { to: '/support', label: 'Support & reviews', icon: Headset },
  { to: '/reports', label: 'Reports & exports', icon: FileOutput },
  { to: '/approvals', label: 'Approvals & compliance', icon: ClipboardCheck },
  { to: '/settings', label: 'Settings & system', icon: Settings2 },
]

export function SidebarNav({ onNavigate, mobile = false }: { onNavigate?: () => void; mobile?: boolean }) {
  const collapsed = useUI((s) => s.sidebarCollapsed)
  const toggle = useUI((s) => s.toggleSidebar)

  return (
    <div className={cn('flex h-full flex-col', mobile ? 'w-full' : collapsed ? 'w-[84px]' : 'w-[240px]', 'transition-[width] duration-300')}>
      <div className={cn('flex items-center gap-1.5 px-4 pt-5 pb-4', mobile && 'justify-between')}>
        <NavLink to="/dashboard" className="min-w-0 flex-1" onClick={onNavigate}>
          {collapsed && !mobile ? <Logo compact /> : <Logo />}
        </NavLink>
        {/* Collapse toggle lives beside the brand (bottom button removed). */}
        {!mobile && (
          <button
            onClick={toggle}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-primary-soft hover:text-foreground"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        )}
        {mobile && (
          <button onClick={onNavigate} className="grid h-8 w-8 place-items-center rounded-lg hover:bg-muted" aria-label="Close menu">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <nav className="scrollbar-thin min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pt-1" aria-label="Primary">
        {NAV_ITEMS.map((item) => (
          <Tooltip key={item.to} content={collapsed && !mobile ? item.label : ''} side="right">
            <NavLink
              to={item.to}
              onClick={onNavigate}
              onMouseEnter={() => warmRoute(item.to)}
              onFocus={() => warmRoute(item.to)}
              className={({ isActive }) =>
                cn(
                  'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-semibold transition-colors',
                  collapsed && !mobile && 'justify-center px-0',
                  isActive ? 'text-white' : 'text-muted-foreground hover:text-foreground',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.span
                      layoutId="sidebar-pill"
                      className="absolute inset-0 rounded-xl gradient-primary shadow-pill"
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                  {!isActive && <span className="absolute inset-0 rounded-xl bg-transparent transition-colors group-hover:bg-primary-soft" />}
                  <item.icon className={cn('relative z-10 h-[18px] w-[18px] shrink-0 transition-transform group-hover:-translate-y-px group-active:scale-90', isActive && 'text-white')} strokeWidth={2} />
                  {(!collapsed || mobile) && <span className="relative z-10 truncate">{item.label}</span>}
                </>
              )}
            </NavLink>
          </Tooltip>
        ))}
      </nav>
      {/* Decorative brand artwork stays out of the way on short screens. */}
      <div aria-hidden="true" className={cn('sidebar-artwork relative shrink-0', collapsed && !mobile && 'hidden')}>
        <img
          src={`${import.meta.env.BASE_URL}images/admin/sidebar-farm.webp`}
          alt=""
          decoding="async"
          className="h-[190px] w-full object-cover object-bottom"
        />
      </div>
    </div>
  )
}

export function MobileSidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 bg-foreground/30 backdrop-blur-[2px]" onClick={onClose} />
      <motion.div
        initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        className="absolute inset-y-0 left-0 w-[280px] bg-card p-0 shadow-lift"
      >
        <SidebarNav mobile onNavigate={() => { onClose(); navigate('/dashboard') }} />
      </motion.div>
    </div>
  )
}
