# 🐄 DairyDirect — Admin Portal (refactored to the "Admin sidebar" spec)

A fully working, heavily animated admin portal for a dairy delivery business across
Maharashtra — **React 18 + TypeScript + Vite + Tailwind + Radix UI + Framer Motion +
Recharts + React-Leaflet + Zustand + TanStack Query**. Refactored to the 14-section
"Admin sidebar" spec; the spec is the single source of truth.

## Quick start

```bash
npm install
npm run dev          # → http://localhost:5173
npm run build        # production build
npm run typecheck    # tsc --noEmit (clean)
```

**Demo login** (any password ≥ 4 chars):

| Email | Role |
| --- | --- |
| `admin@dairydirect.in` | Admin — full portal access |
| `rohit.kulkarni@dairydirect.in` | Store manager (Colaba Fresh Store) |
| `lalita.bisht@dairydirect.in` | Support agent |

Role model: **Admin, Store manager, Rider, Support agent, Customer** (customers are
records in People, they do not sign into the portal). There is no separate super-admin.

## Sidebar (exactly 14 sections)

1. **Dashboard** (`/dashboard`) — date + store filter, order pipeline KPIs, store status
   (online/paused/high picking backlog), pending counts linking pre-filtered pages,
   low-stock & expiring alerts, reconciliation issues, failed jobs, and THREE separate
   financial KPIs: Sales, Wallet top-ups, Refunds (never combined).
   Aggregation via one mock service: `getDashboardSummary(range, storeId)` in
   `src/data/selectors.ts` — swap for a backend endpoint later.
2. **Stores & service areas** (`/stores`) — store CRUD (location, capacity,
   online/paused, COD availability), detail drawer with weekly hours editor + holiday
   calendar + manager assignment, Cities & zones with polygon editing on Leaflet
   (`PolygonEditor`), zone priorities, legal entities linked to stores. A store manager
   can pause/resume their own store; the admin controls wider config (noted in the UI).
3. **Products & pricing** (`/products`) — categories & brands, variants with SKU/barcode,
   publish/unpublish, per-store availability + price override, tax & shelf-life,
   CSV import wizard (upload → dry run → error table → confirm), sensitive changes
   (price/publish) create approval requests and show "Pending approval" on the item.
4. **Inventory** (`/inventory`) — cross-store stock comparison, low-stock list,
   movements/adjustments log with filters, shelf-life + expiring batches, discrepancy
   view (damage/expiry/unusual adjustments flagged). Oversight only — receiving/counting/
   quality handling belongs to store managers (not built, per spec).
5. **Orders & delivery** (`/orders`, `/orders/:id`) — filters by store/customer/status/date;
   detail with items, payment attempts, refunds (status exactly as returned) and timeline;
   eligibility-gated actions with reason tooltips (hold/release, cancel w/ required reason,
   request correction, reassign rider before pickup, resolve wrong-address report, reset
   delivery-code lock); "Live map" tab (all riders + animated delivery route).
6. **People** (`/people`) — 3 tabs: Customers (search/status, block/unblock, deep links to
   orders & tickets — no mega-profile), Rider applications (read-only documents;
   "Reviewed by assigned store manager"), Workforce (invite store-manager/rider/support
   accounts, assign managers to stores, block/unblock, password reset, role-change
   workflow for admin access via approvals).
7. **Payments, refunds & wallets** (`/payments`) — payment attempts (captured/failed),
   refunds with exact statuses (Requested/Processing/Paid/Failed) + manual refund
   evidence (reference + file), reconciliation findings, wallet ledger + authorized
   adjustments (reason required), invoice-render failures with gated Retry.
8. **Rider payouts & COD** (`/payouts`) — payout records, approve when `canApprove`,
   record payment reference/evidence AFTER paid ("Manual settlement is recorded here;
   no bank transfer is initiated."), corrections & COD offsets.
9. **Offers & notifications** (`/offers`) — coupons (percentage/flat/free delivery with
   min order, validity, usage limits, eligible stores & products), push campaigns
   (audiences or selected users, preview, status list), My notifications (the admin's own
   bell feed).
10. **Subscriptions** (`/subscriptions`) — configuration only: subscribable products,
    delivery slots, subscription holidays, generation runs with inspect/retry,
    subscription settings. Shows a "Subscriptions are currently disabled" banner when
    the feature flag is off.
11. **Support & reviews** (`/support`) — tickets with respond/status/saved responses/
    internal notes/authorized attachments viewer, refund request from eligible
    order-related tickets (creates it in Payments), rating moderation queue.
12. **Reports & exports** (`/reports`) — exactly 6 tabs: Catalog & stock, Financial
    activity, Picking & store performance, Rider activity, Subscriptions, Support
    activity; preview table → Export creates a job (Pending/Complete/Failed) with an
    authorized download only when Complete.
13. **Approvals & compliance** (`/approvals`) — queue (pending/completed/rejected/expired)
    with `canApprove`-gated approve/reject + reason when not allowed, fraud findings,
    payment-reconciliation findings, data-erasure requests and legal holds.
14. **Settings & system** (`/settings`) — feature toggles (COD, wallets, subscriptions —
    effective instantly across the app), business rules (fees, order limits, rider
    requirements, dispatch settings), failed background jobs with recovery actions,
    operational notifications and invoice-render failures.

Top bar: global search + ⌘K/Ctrl+K palette (stores, products, orders, customers, riders,
tickets), notification bell (My notifications), user menu with the light/dark/system
toggle. The signed-in user is labeled **Admin** everywhere.

## Data model & persistence

`src/data/seed.ts` builds one deterministic dataset (demo clock: 24 Jan 2026, 11:05):
8 stores / 13 zones / 3 legal entities / 12 products · 26 variants / ~480 customers /
12 riders / 24 workforce accounts / 1,248 orders (identical across Orders, Payments,
Payouts, Support and Reports) / payment attempts / refunds with exact statuses /
wallet ledger / reconciliation + fraud findings / 48 rider payouts incl. corrections and
COD offsets / coupons & campaigns / subscription runs / tickets & ratings / approvals,
erasure requests and legal holds / export jobs / background jobs / feature flags &
business rules. Mutations persist through a journal in localStorage
(`dairydirect-journal-v2`); Settings & system → restore via `resetDemoData()`.

Supabase: `supabase/schema.sql` (all tables + RLS: staff read, admin-only writes via
`is_admin()`) and `supabase/seed.sql` (reference data). The app runs with **zero
configuration** on the mock layer; set `VITE_USE_SUPABASE=true` + keys in `.env`
(see `.env.example`) to point it at Supabase.

## Needs backend support (built with mocks only)

- **Dashboard aggregation** — `getDashboardSummary()` is a client-side mock; the real
  backend should provide one aggregation endpoint.
- **Live rider map** — the Orders "Live map" tab animates a pseudo-route locally; a true
  fleet view needs a dedicated admin-facing backend (live locations/websockets).
- **Full customer profile** — People shows basic details + deep links by design; a
  combined 360° profile needs more read APIs.
- **COD reconciliation dashboard** — COD appears inside payouts and reports only, per
  spec; a standalone reconciliation dashboard needs backend aggregation.
- **Browse-all ratings** — Support shows the moderation queue; browsing all ratings
  needs additional read APIs.
- Store slots/holidays edits persist page-locally in the demo (localStorage
  `dd-sub-config`); production needs journal/API rows.

## Structure

```
src/
  components/ui/        base.tsx · overlays.tsx · form.tsx
  components/shared/    KpiCard · DataTable+Pagination · charts · misc (PageHeader, pills, tabs) ·
                        domain.tsx (ApprovalBadge, StatusTimeline, ExportJobRow, ApprovalCard,
                        CsvImportWizard) · map/ (LazyMap, MapInner, PolygonEditor)
  data/                 seed.ts · selectors.ts (incl. getDashboardSummary) · api.ts · rng.ts
  hooks/                queries.ts · mutations.ts · flags.ts · misc.ts
  illustrations/        scenes.tsx (all animated headers incl. new Products/Inventory/
                        Payments/Payouts/Support/Approvals/People scenes) · avatars · productIcons · Logo
  layouts/              AppLayout · Sidebar (14 items) · Topbar (bell + Admin menu) · CommandPalette
  pages/                Dashboard · Stores · Products · Inventory · Orders(+Detail) · People ·
                        Payments · Payouts · Offers · Subscriptions · Support · Reports ·
                        Approvals · Settings · Login · NotFound
  services/             exports.ts (xlsx/csv) · supabaseClient.ts
  store/                db.ts (journal persistence) · auth.ts
supabase/               schema.sql · seed.sql
```

## Removed in the refactor (no leftovers)

Overview dashboard, Farms & farm verification, Cities "expansion" planning + coverage
gauges + import-zones hype cards, Delivery page (merged; live map became a tab), the 28-
permission matrix + roles/access cards + audit-log widget, old roles (Super Admin,
Operations Admin, Farm Manager, City Manager, Delivery Lead, Finance Admin), platform
commission + settlement summary + revenue-by-category donut, combined "Net revenue",
generic "Assign Delivery", delivery performance donut/gauges/top-partners leaderboard,
old offers (combo/bundle, subscription offers, Refer & Earn, campaign analytics,
marketing banner), per-customer subscription management + plan marketing cards +
renewal-revenue KPI, old report tabs (Business/Sales/Farm/Delivery/Customer) + Key
Insights + revenue-by-city map + Top farms + Report Center, Settings business profile/
cover upload/integration cards (Razorpay/Twilio/Supabase)/security & 2FA/password
policy/sessions/system preferences/data & backup/notification toggles, and the
MaharashtraMap/landmark/razorpay/twilio modules.
