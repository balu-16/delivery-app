import { lazy, useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AppLayout } from '@/layouts/AppLayout'
import { useAuth } from '@/store/auth'
import { pageImports } from '@/routes'
import { ErrorBoundary } from '@/components/shared/ErrorBoundary'
import { RouteFallback } from '@/components/shared/RouteFallback'

// Route-level code splitting: every page is its own chunk, fetched on demand
// (and prefetched from the sidebar on hover/focus).
const Login = lazy(pageImports.Login)
const Dashboard = lazy(pageImports.Dashboard)
const Stores = lazy(pageImports.Stores)
const Products = lazy(pageImports.Products)
const Inventory = lazy(pageImports.Inventory)
const Orders = lazy(pageImports.Orders)
const OrderDetail = lazy(pageImports.OrderDetail)
const People = lazy(pageImports.People)
const Payments = lazy(pageImports.Payments)
const Payouts = lazy(pageImports.Payouts)
const Offers = lazy(pageImports.Offers)
const Subscriptions = lazy(pageImports.Subscriptions)
const Support = lazy(pageImports.Support)
const Reports = lazy(pageImports.Reports)
const Approvals = lazy(pageImports.Approvals)
const Settings = lazy(pageImports.Settings)
const NotFound = lazy(pageImports.NotFound)

function RequireAuth({ children }: { children: JSX.Element }) {
  const status = useAuth((s) => s.status)
  const location = useLocation()
  useEffect(() => {
    if (status === 'bootstrapping') void useAuth.getState().bootstrap()
  }, [status])
  if (status === 'bootstrapping') return <RouteFallback />
  if (status === 'anonymous') return <Navigate to="/login" state={{ from: location.pathname }} replace />
  return children
}

const page = (el: React.ReactNode, resetKey?: string) => (
  // NOTE: no Suspense here on purpose — lazy route chunks must suspend to the
  // hoisted boundary ABOVE AnimatePresence in AppLayout. A Suspense inside the
  // keyed motion.div leaves the area blank while a chunk loads (AnimatePresence
  // mode="wait" defers the mount, so the inner fallback never shows).
  <ErrorBoundary resetKey={resetKey}>{el}</ErrorBoundary>
)

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={page(<Login />, '/login')} />
      <Route element={<RequireAuth><AppLayout /></RequireAuth>}>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        {/* 1 — Dashboard */}
        <Route path="/dashboard" element={page(<Dashboard />, '/dashboard')} />
        {/* 2 — Stores & service areas */}
        <Route path="/stores" element={page(<Stores />, '/stores')} />
        {/* 3 — Products & pricing */}
        <Route path="/products" element={page(<Products />, '/products')} />
        {/* 4 — Inventory */}
        <Route path="/inventory" element={page(<Inventory />, '/inventory')} />
        {/* 5 — Orders & delivery */}
        <Route path="/orders" element={page(<Orders />, '/orders')} />
        <Route path="/orders/:id" element={page(<OrderDetail />, '/orders')} />
        {/* 6 — People */}
        <Route path="/people" element={page(<People />, '/people')} />
        {/* 7 — Payments, refunds & wallets */}
        <Route path="/payments" element={page(<Payments />, '/payments')} />
        {/* 8 — Rider payouts & COD */}
        <Route path="/payouts" element={page(<Payouts />, '/payouts')} />
        {/* 9 — Offers & notifications */}
        <Route path="/offers" element={page(<Offers />, '/offers')} />
        {/* 10 — Subscriptions */}
        <Route path="/subscriptions" element={page(<Subscriptions />, '/subscriptions')} />
        {/* 11 — Support & reviews */}
        <Route path="/support" element={page(<Support />, '/support')} />
        {/* 12 — Reports & exports */}
        <Route path="/reports" element={page(<Reports />, '/reports')} />
        {/* 13 — Approvals & compliance */}
        <Route path="/approvals" element={page(<Approvals />, '/approvals')} />
        {/* 14 — Settings & system */}
        <Route path="/settings" element={page(<Settings />, '/settings')} />
        <Route path="*" element={page(<NotFound />, '/404')} />
      </Route>
    </Routes>
  )
}
