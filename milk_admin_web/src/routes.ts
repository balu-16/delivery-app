// Single source for route chunks — used BOTH by React.lazy (App.tsx) and by the
// sidebar's hover/focus prefetcher, so they reference the same dynamic imports.
export const pageImports = {
  Dashboard: () => import('@/pages/Dashboard').then(m => ({ default: m.Dashboard })),
  Stores: () => import('@/pages/Stores').then(m => ({ default: m.Stores })),
  Products: () => import('@/pages/Products').then(m => ({ default: m.Products })),
  Inventory: () => import('@/pages/Inventory').then(m => ({ default: m.Inventory })),
  Orders: () => import('@/pages/Orders').then(m => ({ default: m.Orders })),
  OrderDetail: () => import('@/pages/OrderDetail').then(m => ({ default: m.OrderDetail })),
  People: () => import('@/pages/People').then(m => ({ default: m.People })),
  Payments: () => import('@/pages/Payments').then(m => ({ default: m.Payments })),
  Payouts: () => import('@/pages/Payouts').then(m => ({ default: m.Payouts })),
  Offers: () => import('@/pages/Offers').then(m => ({ default: m.Offers })),
  Subscriptions: () => import('@/pages/Subscriptions').then(m => ({ default: m.Subscriptions })),
  Support: () => import('@/pages/Support').then(m => ({ default: m.Support })),
  Reports: () => import('@/pages/Reports').then(m => ({ default: m.Reports })),
  Approvals: () => import('@/pages/Approvals').then(m => ({ default: m.Approvals })),
  Settings: () => import('@/pages/Settings').then(m => ({ default: m.Settings })),
  Login: () => import('@/pages/Login').then(m => ({ default: m.Login })),
  NotFound: () => import('@/pages/NotFound').then(m => ({ default: m.NotFound })),
} as const

/** Sidebar nav path → page key (details/routes are prefetched via their parent list). */
export const NAV_PATH_IMPORTS: Record<string, () => Promise<unknown>> = {
  '/dashboard': pageImports.Dashboard,
  '/stores': pageImports.Stores,
  '/products': pageImports.Products,
  '/inventory': pageImports.Inventory,
  '/orders': pageImports.Orders,
  '/people': pageImports.People,
  '/payments': pageImports.Payments,
  '/payouts': pageImports.Payouts,
  '/offers': pageImports.Offers,
  '/subscriptions': pageImports.Subscriptions,
  '/support': pageImports.Support,
  '/reports': pageImports.Reports,
  '/approvals': pageImports.Approvals,
  '/settings': pageImports.Settings,
}
