import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { LayoutDashboard, ShoppingCart, Boxes, Undo2, UserCheck, Banknote, Store as StoreIcon, UsersRound, BellRing, ChevronDown } from 'lucide-react'
import { AppShell, type AppShellProps } from '@dairydirect/shared/ui/shell/AppShell'
import { Button } from '@dairydirect/shared/ui/base'
import { useStoreAuth, useActiveStore } from '@/login/authStore'
import { useActiveStoreId, useStoreNotifications } from '../api/storeQueries'
import { useStoreNotificationActions } from '../api/storeMutations'
import { searchStore } from '../api/storeApi'
import { useDebouncedValue } from '@dairydirect/shared/hooks/misc'
import { cn } from '@dairydirect/shared/lib/utils'
import { STORE_NAV_PATH_IMPORTS } from '../routes'

// Store Manager sidebar — exactly 9 items, in spec order. Store-web owns the root paths.
export const STORE_NAV_ITEMS = [
  { to: '/dashboard', label: 'Store Dashboard', icon: LayoutDashboard },
  { to: '/orders-picking', label: 'Orders & Picking', icon: ShoppingCart },
  { to: '/inventory', label: 'Inventory', icon: Boxes },
  { to: '/returns', label: 'Returns & Quality Checks', icon: Undo2 },
  { to: '/rider-applications', label: 'Rider Applications', icon: UserCheck },
  { to: '/cod-deposits', label: 'COD Cash Deposits', icon: Banknote },
  { to: '/status', label: 'Store Status', icon: StoreIcon },
  { to: '/staff-workload', label: 'Staff & Workload', icon: UsersRound },
  { to: '/notifications', label: 'Notifications & Account', icon: BellRing },
]

/** The manager's assigned stores, straight from the authenticated session. */
export function useAssignedStores(): Array<{ id: string; name: string; code: string }> {
  const user = useStoreAuth((s) => s.user)
  if (!user) return []
  return user.stores.map((s) => ({ id: s.storeId, name: s.name, code: s.storeId.slice(-6) }))
}

/** The manager's active store — falls back to the first assigned store. */
export function useActiveStoreDetails() {
  const stores = useAssignedStores()
  const activeId = useActiveStore((s) => s.activeStoreId)
  const active = stores.find((s) => s.id === activeId) ?? stores[0]
  return { stores, active: active ?? null, store: active ?? null }
}

function StoreSelector() {
  const { stores, active } = useActiveStoreDetails()
  const setActive = useActiveStore((s) => s.setActiveStore)
  const [open, setOpen] = useState(false)
  if (!active) return null
  if (stores.length <= 1) {
    // single store → static label (no selector per spec)
    return (
      <div className="flex h-10 min-w-0 max-w-[150px] items-center gap-2 rounded-xl border border-border bg-card px-3 text-[13px] font-semibold shadow-soft sm:max-w-[280px]" aria-label="Assigned store" title={active.name}>
        <StoreIcon className="h-4 w-4 shrink-0 text-brand-600" />
        <span className="min-w-0 truncate">{active.name}</span>
        <span className="hidden shrink-0 text-muted-foreground sm:inline">({active.code})</span>
      </div>
    )
  }
  return (
    <div className="relative min-w-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex h-10 min-w-0 max-w-[150px] items-center gap-2 rounded-xl border border-border bg-card px-3 text-[13px] font-semibold shadow-soft transition hover:border-brand-300 sm:max-w-[280px]"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Active store"
      >
        <StoreIcon className="h-4 w-4 shrink-0 text-brand-600" />
        <span className="min-w-0 truncate">{active.name}</span>
        <span className="hidden shrink-0 text-muted-foreground sm:inline">({active.code})</span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <ul role="listbox" className="absolute left-0 top-12 z-50 w-72 rounded-xl border border-border bg-card p-1.5 shadow-lift">
            {stores.map((s) => (
              <li key={s.id}>
                <button
                  role="option"
                  aria-selected={s.id === active.id}
                  onClick={() => { setActive(s.id); setOpen(false) }}
                  className={cn('flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-[13px] font-semibold transition', s.id === active.id ? 'bg-primary-soft text-brand-700 dark:text-brand-300' : 'hover:bg-muted')}
                >
                  <span>{s.name} <span className="text-muted-foreground">({s.code})</span></span>
                  {s.id === active.id && <span className="h-2 w-2 rounded-full bg-brand-600" />}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/** Browser tab title: "Store · <page> · DairyDirect". */
function useStorePageTitle() {
  const location = useLocation()
  useEffect(() => {
    const base = '/' + (location.pathname.split('/')[1] ?? '')
    const label = STORE_NAV_ITEMS.find((i) => i.to === base)?.label ?? 'DairyDirect'
    document.title = `Store · ${label} · DairyDirect`
  }, [location.pathname])
}

function StoreSearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const storeId = useActiveStoreId()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [type, setType] = useState<'ORDERS' | 'CUSTOMERS' | 'PRODUCTS'>('ORDERS')
  const debounced = useDebouncedValue(q, 250)
  const results = useQuery({
    queryKey: ['store', 'search', storeId, type, debounced],
    queryFn: () => searchStore(storeId!, type, debounced.trim()),
    enabled: open && !!storeId && debounced.trim().length >= 2,
  })
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[80] grid place-items-start bg-black/40 px-4 pt-24" onClick={onClose}>
      <div className="mx-auto w-full max-w-xl rounded-2xl border border-border bg-card p-4 shadow-lift" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="Store search">
        <div className="flex gap-2">
          <input value={q} onChange={(event) => setQ(event.target.value)} autoFocus placeholder="Search this store…" aria-label="Search this store" className="h-10 flex-1 rounded-xl border border-input bg-card px-3 text-sm" />
          <select value={type} onChange={(event) => setType(event.target.value as typeof type)} aria-label="Search type" className="h-10 rounded-xl border border-input bg-card px-2 text-sm">
            <option value="ORDERS">Orders</option>
            <option value="CUSTOMERS">Customers</option>
            <option value="PRODUCTS">Products</option>
          </select>
        </div>
        <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
          {(results.data?.items ?? []).map((item, index) => {
            const order = item as { orderId?: string; orderNumber?: string; customerName?: string; status?: string }
            const customer = item as { userId?: string; name?: string; email?: string }
            const product = item as { variantId?: string; productName?: string; sku?: string }
            const label = type === 'ORDERS'
              ? `${order.orderNumber ?? order.orderId} · ${order.customerName ?? ''} · ${order.status ?? ''}`
              : type === 'CUSTOMERS'
                ? `${customer.name ?? 'Customer'} · ${customer.email ?? ''}`
                : `${product.productName ?? 'Product'} · ${product.sku ?? ''}`
            return (
              <li key={`${type}-${index}`}>
                <button
                  className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    onClose()
                    if (type === 'ORDERS') navigate('/orders-picking')
                    else if (type === 'PRODUCTS') navigate('/inventory')
                  }}
                >
                  {label}
                </button>
              </li>
            )
          })}
          {debounced.trim().length >= 2 && !results.isLoading && (results.data?.items.length ?? 0) === 0 && (
            <li className="px-3 py-4 text-sm text-muted-foreground">No matches in this store.</li>
          )}
        </ul>
      </div>
    </div>
  )
}

export function StoreLayout() {
  useStorePageTitle()
  const user = useStoreAuth((s) => s.user)
  const idleExpiresAt = useStoreAuth((s) => s.idleExpiresAt)
  const navigate = useNavigate()
  const { active } = useActiveStoreDetails()
  const { data: storeNotifications = [] } = useStoreNotifications()
  const { markNotificationRead, markAllRead, broadcastLogout } = useStoreNotificationActions()
  const [searchOpen, setSearchOpen] = useState(false)
  const lastRefresh = useRef(0)
  const onSessionActivity = useCallback(() => {
    const now = Date.now()
    if (now - lastRefresh.current < 60_000) return
    lastRefresh.current = now
    void useStoreAuth.getState().bootstrap()
  }, [])

  const shell: AppShellProps = {
    sidebar: {
      items: STORE_NAV_ITEMS, homePath: '/dashboard', badge: 'Store Manager Portal',
      variant: 'light', prefetch: (path) => { void STORE_NAV_PATH_IMPORTS[path]?.().catch(() => {}) },
    },
    searchPlaceholder: 'Search orders by ID, customer, product…',
    onSearchClick: () => setSearchOpen(true),
    userLabel: 'Store Manager',
    user: user ? { name: user.name, email: user.email, avatar: 0 } : null,
    onSignOut: () => {
      void useStoreAuth.getState().logout().then(() => {
        // Cross-tab logout: a removal event under the session key signs out other tabs.
        try { localStorage.setItem('dd_store_session', 'signout'); localStorage.removeItem('dd_store_session') } catch { /* private mode */ }
        broadcastLogout()
        navigate('/login')
      })
    },
    homePath: '/dashboard',
    settingsPath: '/notifications',
    themeKey: 'dd_store_theme',
    sessionStorageKey: 'dd_store_session',
    onSessionExpire: () => { void useStoreAuth.getState().logout(); navigate('/login') },
    sessionDeadline: idleExpiresAt,
    onSessionActivity,
    topbarLeft: <StoreSelector />,
    bellTitle: 'Notifications',
    bellNotifications: storeNotifications.map((n) => ({ id: n.id, title: n.title, body: n.body, at: n.at, read: n.read, kind: n.kind })),
    onBellMarkAllRead: () => markAllRead(),
    onBellMarkRead: (id) => markNotificationRead(id),
    overlay: <StoreSearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />,
  }

  return (
    <AppShell {...shell}>
      {active ? <Outlet /> : (
        // Manager with zero store assignments: show the contact-admin screen.
        <div className="grid min-h-[50vh] place-items-center text-center">
          <div className="flex max-w-md flex-col items-center gap-4">
            <span className="grid h-16 w-16 place-items-center rounded-2xl bg-warning-soft text-warning">
              <StoreIcon className="h-8 w-8" />
            </span>
            <div>
              <p className="text-lg font-bold">No store assigned, contact admin</p>
              <p className="mt-1 text-sm text-muted-foreground">Your account has no store assignments yet.</p>
            </div>
            <Button size="lg" onClick={() => { void useStoreAuth.getState().logout(); navigate('/login') }}>Sign out</Button>
          </div>
        </div>
      )}
    </AppShell>
  )
}
