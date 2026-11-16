// Store-web route chunks — used by React.lazy in App.tsx and the sidebar's
// hover/focus prefetcher. Pages are prefixed Store*; routes live at the root.
export const STORE_PAGE_IMPORTS = {
  StoreDashboard: () => import('@/pages/StoreDashboard').then(m => ({ default: m.StoreDashboard })),
  StoreOrdersPicking: () => import('@/pages/StoreOrdersPicking').then(m => ({ default: m.StoreOrdersPicking })),
  StoreInventory: () => import('@/pages/StoreInventory').then(m => ({ default: m.StoreInventory })),
  StoreReturns: () => import('@/pages/StoreReturns').then(m => ({ default: m.StoreReturns })),
  StoreRiderApplications: () => import('@/pages/StoreRiderApplications').then(m => ({ default: m.StoreRiderApplications })),
  StoreCodDeposits: () => import('@/pages/StoreCodDeposits').then(m => ({ default: m.StoreCodDeposits })),
  StoreStoreStatus: () => import('@/pages/StoreStoreStatus').then(m => ({ default: m.StoreStoreStatus })),
  StoreStaffWorkload: () => import('@/pages/StoreStaffWorkload').then(m => ({ default: m.StoreStaffWorkload })),
  StoreNotificationsAccount: () => import('@/pages/StoreNotificationsAccount').then(m => ({ default: m.StoreNotificationsAccount })),
} as const

export const STORE_NAV_PATH_IMPORTS: Record<string, () => Promise<unknown>> = {
  '/dashboard': STORE_PAGE_IMPORTS.StoreDashboard,
  '/orders-picking': STORE_PAGE_IMPORTS.StoreOrdersPicking,
  '/inventory': STORE_PAGE_IMPORTS.StoreInventory,
  '/returns': STORE_PAGE_IMPORTS.StoreReturns,
  '/rider-applications': STORE_PAGE_IMPORTS.StoreRiderApplications,
  '/cod-deposits': STORE_PAGE_IMPORTS.StoreCodDeposits,
  '/status': STORE_PAGE_IMPORTS.StoreStoreStatus,
  '/staff-workload': STORE_PAGE_IMPORTS.StoreStaffWorkload,
  '/notifications': STORE_PAGE_IMPORTS.StoreNotificationsAccount,
}
