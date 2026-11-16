import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Logo } from '../../assets/Logo'
import { useUI } from './ui'
import { Tooltip } from '../../ui/overlays'

export interface SidebarItem { to: string; label: string; icon: React.ComponentType<any> }

/** Hover/focus prefetch hook injected by each portal (keeps portals decoupled). */
export interface SidebarConfig {
  items: SidebarItem[]
  homePath: string
  badge: string
  /** 'light' = admin (white sidebar, green gradient pill). 'dark' = store manager (green gradient sidebar, light pill). */
  variant?: 'light' | 'dark'
  prefetch?: (path: string) => void
}

export function SidebarNav({ config, onNavigate, mobile = false }: { config: SidebarConfig; onNavigate?: () => void; mobile?: boolean }) {
  const collapsed = useUI((s) => s.sidebarCollapsed)
  const toggle = useUI((s) => s.toggleSidebar)
  const dark = config.variant === 'dark'
  const warm = (p: string) => config.prefetch?.(p)

  return (
    <div
      className={cn(
        'flex h-full flex-col transition-[width] duration-300',
        dark ? 'bg-gradient-to-b from-[#1d4d16] via-[#21581b] to-[#173f12]' : 'bg-card',
        mobile ? 'w-full' : collapsed ? 'w-[84px]' : 'w-[240px]',
      )}
    >
      <div className={cn('flex items-center gap-1.5 px-4 pt-5 pb-4', mobile && 'justify-between')}>
        <NavLink to={config.homePath} className="min-w-0 flex-1" onClick={onNavigate}>
          {collapsed && !mobile ? <Logo compact /> : <Logo badge={config.badge} dark={dark} />}
        </NavLink>
        {!mobile && (
          <button
            onClick={toggle}
            className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-lg transition', dark ? 'text-white/70 hover:bg-white/10' : 'text-muted-foreground hover:bg-primary-soft hover:text-foreground')}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        )}
        {mobile && (
          <button onClick={onNavigate} className={cn('grid h-8 w-8 place-items-center rounded-lg', dark ? 'text-white/70 hover:bg-white/10' : 'hover:bg-muted')} aria-label="Close menu">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <nav className="scrollbar-thin min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pt-1" aria-label="Primary">
        {config.items.map((item) => (
          <Tooltip key={item.to} content={collapsed && !mobile ? item.label : ''} side="right">
            <NavLink
              to={item.to}
              title={item.label}
              onClick={onNavigate}
              onMouseEnter={() => warm(item.to)}
              onFocus={() => warm(item.to)}
              className={cn(
                'group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13.5px] font-semibold transition-colors',
                collapsed && !mobile && 'justify-center px-0',
                dark ? 'text-white/75 hover:text-white' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {({ isActive }) => (
                <>
                  {isActive && (
                    <motion.span
                      layoutId={`sidebar-pill-${config.variant ?? 'light'}`}
                      className={cn('absolute inset-0 rounded-xl', dark ? 'bg-brand-200 shadow-[0_4px_14px_-4px_rgba(255,255,255,0.35)]' : 'gradient-primary shadow-pill')}
                      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
                    />
                  )}
                  {!isActive && <span className={cn('absolute inset-0 rounded-xl transition-colors', dark ? 'group-hover:bg-white/10' : 'group-hover:bg-primary-soft')} />}
                  <item.icon className={cn('relative z-10 h-[18px] w-[18px] shrink-0 transition-transform group-hover:-translate-y-px group-active:scale-90', isActive && (dark ? 'text-[#123312]' : 'text-white'))} strokeWidth={2} />
                  {(!collapsed || mobile) && <span className={cn('relative z-10 truncate', isActive && (dark ? 'text-[#123312]' : 'text-white'))}>{item.label}</span>}
                </>
              )}
            </NavLink>
          </Tooltip>
        ))}
      </nav>
      <div aria-hidden="true" className={cn('sidebar-artwork relative shrink-0', collapsed && !mobile && 'hidden')}>
        <img
          src={`${import.meta.env.BASE_URL}images/store/sidebar-farm.webp`}
          alt=""
          decoding="async"
          className="h-[190px] w-full object-cover object-bottom"
        />
      </div>
    </div>
  )
}

export function MobileSidebar({ config, open, onClose }: { config: SidebarConfig; open: boolean; onClose: () => void }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <div className="absolute inset-0 bg-foreground/30 backdrop-blur-[2px]" onClick={onClose} />
      <motion.div
        initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }}
        transition={{ type: 'spring', stiffness: 320, damping: 32 }}
        className={cn('absolute inset-y-0 left-0 w-[280px] p-0 shadow-lift', config.variant === 'dark' ? 'bg-gradient-to-b from-[#1d4d16] to-[#173f12]' : 'bg-card')}
      >
        <SidebarNav config={config} mobile onNavigate={onClose} />
      </motion.div>
    </div>
  )
}
