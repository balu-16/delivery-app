# Store portal ↔ backend integration matrix

Every visible workflow in the nine store sections mapped to the `/v1/store`
operation that serves it. Generated types: `src/api/store-api.generated.ts`
(from `server/openapi/store.json`). Session: `store_session` HttpOnly cookie +
`x-store-csrf` header (server-managed, independent from admin-web).

| Section | UI workflow | Backend operation |
|---|---|---|
| Login | sign-in (first-login NEW_PASSWORD_REQUIRED) | POST `/v1/store/auth/login` → POST `/v1/store/auth/challenge` |
| Login | refresh bootstrap | GET `/v1/store/auth/session` |
| Login | forgot / reset password (real e-mail code) | POST `/v1/store/auth/forgot-password(+/confirm)` |
| Login | sign-out (all tabs synced) | POST `/v1/store/auth/logout` |
| Store selection | manager assignments | `manager.stores` from session / GET `/v1/store/me` |
| 1 Dashboard | KPIs, workload, upcoming tasks, alerts, store status | GET `/v1/store/dashboard` (+ `/status`, low-stock, expiring, returns, COD, rider apps composition) |
| 1 Dashboard | pause / resume store | POST `/v1/store/status` |
| 2 Picking | queue / all / mine tabs | GET `/v1/store/pick-tasks?scope=QUEUE\|ALL\|MINE` |
| 2 Picking | task detail + FEFO | GET `/v1/store/pick-tasks/{id}` |
| 2 Picking | claim / start / heartbeat / release | POST `/v1/store/pick-tasks/{id}/claim\|start\|heartbeat\|release` |
| 2 Picking | barcode pick / short / substitute | POST `/v1/store/pick-tasks/{id}/items/{itemId}/pick\|short\|substitute` |
| 2 Packing | bags, seal code, cold chain | POST `/v1/store/orders/{id}/pack` |
| 2 Handover | rider-presented code | POST `/v1/store/orders/{id}/handover` |
| 2 Reassign | staff reassignment | POST `/v1/store/pick-tasks/{id}/reassign` |
| 3 Inventory | stock / low-stock / expiring / bins | GET `/v1/store/inventory` · `/low-stock` · `/expiring` · `/batches` |
| 3 Inventory | full filtered CSV export | GET `/v1/store/inventory/export` |
| 3 Inventory | receive stock | POST `/v1/store/inventory/receipts` |
| 3 Inventory | cycle counts (approval rule) | POST `/v1/store/inventory/cycle-counts` |
| 3 Inventory | adjustments (maker-checker) | POST `/v1/store/inventory/adjustments` · GET `/adjustments` history |
| 3 Inventory | receipts history | GET `/v1/store/inventory/receipts` |
| 4 Returns | eligible failed-delivery orders | GET `/v1/store/returns?tab=ELIGIBLE` |
| 4 Returns | record return | POST `/v1/store/orders/{id}/return` |
| 4 Returns | persistent inspection drafts | GET/POST `/v1/store/returns/orders/{orderId}/draft` |
| 4 Returns | QC decision (saleable/damaged/expired) | POST `/v1/store/returns/{id}/qc` |
| 4 Returns | recorded parcels + outcomes | GET `/v1/store/returns?tab=RECORDED` · detail GET `/v1/store/returns/orders/{orderId}` |
| 5 Riders | application list/detail | GET `/v1/store/rider-applications(/{userId})` |
| 5 Riders | document preview (presigned) | POST `/v1/store/rider-documents/{id}/read-url` |
| 5 Riders | approve / request replacement | POST `/v1/store/rider-documents/{id}/review` |
| 6 COD | eligible riders + cash in hand | GET `/v1/store/cod/riders` |
| 6 COD | deposit (integer paise, idempotent) | POST `/v1/store/cod/deposits` |
| 6 COD | history, totals, discrepancies | GET `/v1/store/cod/deposits` |
| 7 Status | facts, hours, history | GET `/v1/store/status` |
| 7 Status | pause (reason) / resume | POST `/v1/store/status` |
| 8 Staff | roster + active/overdue workload | GET `/v1/store/staff` · `/sla-board` |
| 8 Staff | reassignment | POST `/v1/store/pick-tasks/{id}/reassign` |
| 9 Notifications | inbox, read/unread, mark-all | GET `/v1/store/notifications` · POST `/notifications/{id}/read` · `/unread` · `/read-all` |
| 9 Notifications | preferences (category-backed) | GET/PATCH `/v1/store/notification-preferences` |
| 9 Account | profile + sign-out | session payload · POST `/v1/store/auth/logout` |
| Top bar | store-scoped search | GET `/v1/store/search?type=ORDERS\|CUSTOMERS\|PRODUCTS` |

## Retired demo behavior

- `shared/src/mock-db/*` no longer drives any runtime path (seed, journal,
  `DEMO_NOW`, demo credentials, generated handover codes — all gone from the
  app bundle).
- Server is the sole authority for IDs, statuses, quantities, deadlines and
  outcomes; the UI renders server responses and honest empty states.

## Preference category mapping

The portal's five toggles persist onto backend delivery categories:
pickingOrders→ORDER_UPDATES, inventoryAlerts→STORE_OPS, riderApplications→RIDING,
codDeposits→PAYMENTS, storeStatus→ADMIN.
