import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { StoreLayout } from '@/layout/StoreLayout'
import { RequireStoreManager } from '@/login/RequireStoreManager'
import { STORE_PAGE_IMPORTS } from '@/routes'
import { RouteFallback } from '@dairydirect/shared/ui/RouteFallback'

// Route-level code splitting, one lazy bundle per section.
const LoginPage = lazy(() => import('@/login/StoreLoginPage').then(m => ({ default: m.StoreLoginPage })))
const ForgotPassword = lazy(() => import('@/login/ForgotPasswordPage').then(m => ({ default: m.ForgotPasswordPage })))
const ResetPassword = lazy(() => import('@/login/ResetPasswordPage').then(m => ({ default: m.ResetPasswordPage })))
const NotFound = lazy(() => import('@dairydirect/shared/ui/NotFound').then(m => ({ default: m.NotFound })))

const Store = {
  Dashboard: lazy(STORE_PAGE_IMPORTS.StoreDashboard),
  OrdersPicking: lazy(STORE_PAGE_IMPORTS.StoreOrdersPicking),
  Inventory: lazy(STORE_PAGE_IMPORTS.StoreInventory),
  Returns: lazy(STORE_PAGE_IMPORTS.StoreReturns),
  RiderApplications: lazy(STORE_PAGE_IMPORTS.StoreRiderApplications),
  CodDeposits: lazy(STORE_PAGE_IMPORTS.StoreCodDeposits),
  StoreStatus: lazy(STORE_PAGE_IMPORTS.StoreStoreStatus),
  StaffWorkload: lazy(STORE_PAGE_IMPORTS.StoreStaffWorkload),
  NotificationsAccount: lazy(STORE_PAGE_IMPORTS.StoreNotificationsAccount),
}

const page = (el: React.ReactNode) => <Suspense fallback={<RouteFallback />}>{el}</Suspense>

// Store-web is a standalone app: routes live at the root (no /store prefix).
// Only store managers pass RequireStoreManager; the login page is this app's own.
export default function App() {
  return (
    <Routes>
      {/* public */}
      <Route path="/login" element={page(<LoginPage />)} />
      <Route path="/forgot-password" element={page(<ForgotPassword />)} />
      <Route path="/reset-password" element={page(<ResetPassword />)} />
      <Route path="/404" element={page(<NotFound />)} />

      {/* store sections (role = store_manager only, enforced by RequireStoreManager) */}
      <Route path="/" element={<RequireStoreManager><StoreLayout /></RequireStoreManager>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Store.Dashboard />} />
        <Route path="orders-picking" element={<Store.OrdersPicking />} />
        <Route path="inventory" element={<Store.Inventory />} />
        <Route path="returns" element={<Store.Returns />} />
        <Route path="rider-applications" element={<Store.RiderApplications />} />
        <Route path="cod-deposits" element={<Store.CodDeposits />} />
        <Route path="status" element={<Store.StoreStatus />} />
        <Route path="staff-workload" element={<Store.StaffWorkload />} />
        <Route path="notifications" element={<Store.NotificationsAccount />} />
      </Route>

      {/* everything else -> /404 */}
      <Route path="*" element={page(<NotFound />)} />
    </Routes>
  )
}
