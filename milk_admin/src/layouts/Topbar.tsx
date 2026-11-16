import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, ChevronDown, LogOut, Menu, Search, User, Settings2, Sun, Moon, Monitor } from 'lucide-react'
import { cn, timeAgo } from '@/lib/utils'
import { Kbd, Badge } from '@/components/ui/base'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownItem, DropdownSeparator, DropdownLabel, Popover, PopoverContent, PopoverTrigger } from '@/components/ui/overlays'
import { useAuth } from '@/store/auth'
import { useUI } from './ui'
import { useInbox, useUnreadCount } from '@/hooks/queries'
import { useOfferActions } from '@/hooks/mutations'
import { Avatar as FlatAvatar } from '@/illustrations/avatars'
import type { AdminNotification } from '@/types'

/** Notification bell = the admin's OWN inbox, polled ~60s while visible. */
export function NotificationsBell() {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  const unreadQ = useUnreadCount(visible)
  const inboxQ = useInbox()
  const { markNotificationRead } = useOfferActions()
  const notifications: AdminNotification[] = inboxQ.data?.items ?? []
  const unread = unreadQ.data ?? 0
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="relative grid h-10 w-10 place-items-center rounded-xl border border-border bg-card shadow-soft transition hover:border-brand-300" aria-label={`Notifications (${unread} unread)`}>
          <Bell className={cn('h-[18px] w-[18px] text-foreground/80', unread > 0 && 'origin-top animate-[ring-shake_2.4s_ease-in-out_1]')} />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-success px-1 text-[9px] font-bold text-white ring-2 ring-card">
              {unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-sm font-bold">My notifications</div>
          <button onClick={() => markNotificationRead().mutate(undefined, { onError: () => {} })} className="text-xs font-semibold text-brand-700 hover:underline dark:text-brand-300">Mark all read</button>
        </div>
        <div className="scrollbar-thin max-h-[320px] overflow-y-auto p-1.5">
          {notifications.length === 0 && <p className="p-6 text-center text-xs text-muted-foreground">You're all caught up</p>}
          {notifications.map((n) => {
            const read = !!n.readAt
            return (
              <div key={n.id} className={cn('flex gap-3 rounded-xl p-3 transition hover:bg-muted/60', !read && 'bg-primary-softer/70')}>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-muted text-base"><Bell className="h-4 w-4 text-muted-foreground" /></span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-[13px] font-semibold">
                    <span className="truncate">{n.title}</span>
                    {!read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />}
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{n.body}</p>
                  <p className="mt-1 text-[10px] font-medium text-muted-foreground">{timeAgo(n.createdAt, new Date())}</p>
                </div>
                {!read && (
                  <button onClick={() => markNotificationRead(n.id).mutate(undefined, { onError: () => {} })} className="ml-auto self-start text-[10px] font-semibold text-muted-foreground hover:text-foreground" aria-label={`Mark ${n.title} read`}>
                    Read
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function UserMenu() {
  const admin = useAuth((s) => s.admin)
  const logout = useAuth((s) => s.logout)
  const navigate = useNavigate()
  if (!admin) return null
  const applyTheme = (mode: 'light' | 'dark' | 'system') => {
    const root = document.documentElement
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const dark = mode === 'dark' || (mode === 'system' && mq.matches)
    root.classList.toggle('dark', dark)
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex items-center gap-2.5 rounded-full border border-border bg-card py-1.5 pl-2 pr-3 shadow-soft transition hover:border-brand-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <FlatAvatar index={0} name={admin.name} size={32} />
        <div className="hidden text-left sm:block">
          <div className="text-[13px] font-bold leading-tight">{admin.name}</div>
          <div className="text-[11px] leading-tight text-muted-foreground">Admin</div>
        </div>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownLabel>Signed in as</DropdownLabel>
        <div className="flex items-center gap-3 px-3 pb-2 pt-1">
          <FlatAvatar index={0} name={admin.name} size={40} />
          <div className="min-w-0">
            <div className="truncate text-sm font-bold">{admin.name}</div>
            <div className="truncate text-xs text-muted-foreground">{admin.email}</div>
          </div>
        </div>
        <div className="px-3 pb-2"><Badge tone="green">Admin</Badge></div>
        <DropdownSeparator />
        <DropdownLabel>Theme</DropdownLabel>
        <div className="flex items-center gap-1.5 px-3 pb-2">
          {([
            { mode: 'light' as const, icon: Sun, label: 'Light' },
            { mode: 'dark' as const, icon: Moon, label: 'Dark' },
            { mode: 'system' as const, icon: Monitor, label: 'System' },
          ]).map((t) => (
            <button
              key={t.mode}
              onClick={() => applyTheme(t.mode)}
              className="flex flex-1 items-center justify-center gap-1 rounded-lg border border-border px-2 py-1.5 text-[11px] font-semibold text-muted-foreground transition hover:border-brand-300 hover:text-foreground"
            >
              <t.icon className="h-3.5 w-3.5" /> {t.label}
            </button>
          ))}
        </div>
        <DropdownSeparator />
        <DropdownItem onSelect={() => navigate('/dashboard')}><User className="h-4 w-4" /> Dashboard</DropdownItem>
        <DropdownItem onSelect={() => navigate('/settings')}><Settings2 className="h-4 w-4" /> Settings & system</DropdownItem>
        <DropdownSeparator />
        <DropdownItem danger onSelect={() => { void logout(); navigate('/login') }}>
          <LogOut className="h-4 w-4" /> Log out
        </DropdownItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function Topbar() {
  const setCommandOpen = useUI((s) => s.setCommandOpen)
  const setMobileNavOpen = useUI((s) => s.setMobileNavOpen)
  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
        <button className="grid h-9 w-9 place-items-center rounded-xl hover:bg-muted lg:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
        <button
          onClick={() => setCommandOpen(true)}
          className="group hidden h-10 flex-1 items-center gap-3 rounded-full border border-border bg-card px-4 text-left shadow-innersoft transition hover:border-brand-300 sm:flex"
        >
          <Search className="h-4 w-4 text-muted-foreground transition group-hover:text-brand-600" />
          <span className="flex-1 truncate text-sm text-muted-foreground/80">Search stores, products, orders, customers…</span>
          <span className="flex items-center gap-1"><Kbd>⌘</Kbd><Kbd>K</Kbd></span>
        </button>
        <button onClick={() => setCommandOpen(true)} className="grid h-10 w-10 place-items-center rounded-xl border border-border bg-card shadow-soft sm:hidden" aria-label="Search">
          <Search className="h-4 w-4" />
        </button>
        <div className="ml-auto flex items-center gap-2.5">
          <NotificationsBell />
          <UserMenu />
        </div>
      </div>
    </header>
  )
}
