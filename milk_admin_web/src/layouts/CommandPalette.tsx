import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Dialog, DialogContent } from '@/components/ui/overlays'
import { SearchInput } from '@/components/shared/misc'
import { InitialAvatar } from '@/illustrations/avatars'
import { NAV_ITEMS } from './Sidebar'
import { useUI } from './ui'
import { globalSearch } from '@/api/search'
import { useAuth } from '@/store/auth'
import { Search, ArrowRight, ShoppingCart, Package, Store as StoreIcon, Users, Bike, LifeBuoy } from 'lucide-react'
import type { SearchGroup } from '@/types'

type Result = {
  id: string
  group: string
  title: string
  sub?: string | null
  to: string
  icon?: React.ReactNode
}

const GROUP_ICONS: Record<string, React.ReactNode> = {
  Orders: <ShoppingCart className="h-4 w-4" />,
  Products: <Package className="h-4 w-4" />,
  Stores: <StoreIcon className="h-4 w-4" />,
  Customers: <Users className="h-4 w-4" />,
  Riders: <Bike className="h-4 w-4" />,
  Tickets: <LifeBuoy className="h-4 w-4" />,
}

export function CommandPalette() {
  const open = useUI((s) => s.commandOpen)
  const setOpen = useUI((s) => s.setCommandOpen)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const navigate = useNavigate()
  const scope = useAuth((s) => s.admin?.id ?? 'anon')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen(!open)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, setOpen])

  useEffect(() => {
    if (open) { setQuery(''); setCursor(0) }
  }, [open])

  // Debounced server-side global search (GET /v1/admin/search)
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 250)
    return () => clearTimeout(t)
  }, [query])

  const { data: groups = [], isFetching } = useQuery({
    queryKey: ['global-search', scope, debounced],
    queryFn: () => globalSearch(debounced),
    enabled: open && debounced.trim().length > 0,
    staleTime: 5_000,
  })

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase()
    const pages: Result[] = NAV_ITEMS.filter((n) => !q || n.label.toLowerCase().includes(q)).map((n) => ({
      id: `page-${n.to}`, group: 'Pages', title: n.label, to: n.to, icon: <n.icon className="h-4 w-4" />,
    }))
    if (!q) return pages.slice(0, 8)
    const hits: Result[] = groups.flatMap((g: SearchGroup) =>
      (g.items ?? []).map((it) => ({
        id: `${g.group}-${it.id}`,
        group: g.group,
        title: it.title,
        sub: it.sub ?? null,
        to: targetForGroup(g.group, it.id),
        icon: GROUP_ICONS[g.group],
      })),
    )
    return [...hits, ...pages].slice(0, 20)
  }, [query, groups])

  const grouped = useMemo(() => {
    const map = new Map<string, Result[]>()
    for (const r of results) {
      if (!map.has(r.group)) map.set(r.group, [])
      map.get(r.group)!.push(r)
    }
    return [...map.entries()]
  }, [results])

  const flat = grouped.flatMap(([, rs]) => rs)
  const run = (r: Result) => { setOpen(false); navigate(r.to) }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent title="Command Palette" description="Search orders, products, stores, customers, riders and tickets" wide className="top-[18%] p-0">
        <div
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(flat.length - 1, c + 1)) }
            if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)) }
            if (e.key === 'Enter' && flat[cursor]) { e.preventDefault(); run(flat[cursor]!) }
          }}
        >
          <div className="p-4 pb-2">
            <SearchInput value={query} onChange={setQuery} placeholder="Type to search orders, products, stores, customers, riders, tickets…" kbd />
          </div>
          <div className="scrollbar-thin max-h-[360px] overflow-y-auto p-2">
            {flat.length === 0 && (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <Search className="h-6 w-6 text-muted-foreground/50" />
                <p className="text-sm font-semibold">No matches for “{query}”</p>
                <p className="text-xs text-muted-foreground">Try an order number, a store name, or a customer.</p>
              </div>
            )}
            {isFetching && flat.length === 0 && query && <div className="space-y-2 p-3">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-9 w-full rounded-lg" />)}</div>}
            {grouped.map(([group, items]) => (
              <div key={group} className="mb-1.5">
                <div className="px-3 pb-1 pt-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{group}</div>
                {items.map((r) => {
                  const idx = flat.indexOf(r)
                  return (
                    <button
                      key={`${r.group}-${r.id}`}
                      onClick={() => run(r)}
                      onMouseEnter={() => setCursor(idx)}
                      className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${idx === cursor ? 'bg-primary-soft' : 'hover:bg-muted/60'}`}
                    >
                      <span className="grid h-7 w-7 place-items-center">{r.icon ?? <span className="text-base">•</span>}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-semibold">{r.title}</span>
                        {r.sub && <span className="block truncate text-xs text-muted-foreground">{r.sub}</span>}
                      </span>
                      {idx === cursor && <ArrowRight className="h-4 w-4 text-brand-600" />}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
          <span>↑↓ to navigate · Enter to open</span>
          <span>Esc to close</span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Map server search groups to the portal routes (ids are UUIDs). */
function targetForGroup(group: string, id: string): string {
  const g = group.toLowerCase()
  if (g.includes('order')) return `/orders/${id}`
  if (g.includes('product') || g.includes('variant') || g.includes('catalog')) return '/products'
  if (g.includes('store')) return '/stores'
  if (g.includes('customer') || g.includes('user')) return '/people?tab=customers'
  if (g.includes('rider')) return '/people?tab=riders'
  if (g.includes('ticket') || g.includes('support')) return '/support'
  return '/dashboard'
}

export function PaletteAvatar({ name, size = 20 }: { name: string; size?: number }) {
  return <InitialAvatar name={name} size={size} className="ring-0" />
}
