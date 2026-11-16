import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { StoreLayout } from '@/layout/StoreLayout'
import { RequireStoreManager } from '@/login/RequireStoreManager'
import { STORE_PAGE_IMPORTS } from '@/routes'

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

function RouteFallback() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading page">
      <div className="skeleton h-9 w-64 rounded-xl" />
      <div className="skeleton h-4 w-80 rounded-lg" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        {[1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-[110px] rounded-card" />)}
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="skeleton h-[300px] rounded-card lg:col-span-6" />
        <div className="skeleton h-[300px] rounded-card lg:col-span-3" />
        <div className="skeleton h-[300px] rounded-card lg:col-span-3" />
      </div>
    </div>
  )
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
        <Route path="dashboard" element={page(<Store.Dashboard />)} />
        <Route path="orders-picking" element={page(<Store.OrdersPicking />)} />
        <Route path="inventory" element={page(<Store.Inventory />)} />
        <Route path="returns" element={page(<Store.Returns />)} />
        <Route path="rider-applications" element={page(<Store.RiderApplications />)} />
        <Route path="cod-deposits" element={page(<Store.CodDeposits />)} />
        <Route path="status" element={page(<Store.StoreStatus />)} />
        <Route path="staff-workload" element={page(<Store.StaffWorkload />)} />
        <Route path="notifications" element={page(<Store.NotificationsAccount />)} />
      </Route>

      {/* everything else -> /404 */}
      <Route path="*" element={page(<NotFound />)} />
    </Routes>
  )
}
