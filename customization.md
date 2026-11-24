# Admin & Store Portal Customization — Features, Gaps & Fixes

Audit of what is customizable from the admin portal today, what is missing,
what to build, and the permission boundaries for the store manager.
Evidence paths are repo-relative. No code was changed for this audit.

Product decision in force: single admin role for now (everyone who needs the
portal is SUPER_ADMIN). There is no support team yet, so SUPPORT_AGENT stays
unused until support is hired. One role per user is enforced
(`server/src/modules/identity/domain/identity-policy.ts`).

---

## 1. What IS customizable today (verified in code)

### 1.1 Catalog — products, variants, prices, images, imports
- Products: full CRUD + publish/unpublish (`POST/PUT/DELETE /v1/admin/catalog/products[/{id}]`,
  `/products/{id}/publish`, `/products/{id}/unpublish`). Fields: name, category,
  brand, description, HSN, GST bps, perishable, expiry tracking.
- Variants: full CRUD (`/v1/admin/catalog/variants[/{id}]`): name, base unit
  (PIECE/GRAM/MILLILITRE), SKU, barcode.
- Brands, categories: full CRUD. Category/brand delete is refused while a
  published product uses them.
- Prices: `POST /v1/admin/catalog/prices` with storeId, variantId, selling/MRP
  paise, validity window. Changes beyond `catalogPriceApprovalPercent` need a
  second approval (`Approvals` queue). See pricing note in §3 S1: the effective
  price is global per variant.
- Images: upload-target (presigned POST) + register flow
  (`POST /v1/admin/catalog/media/targets`, `POST /v1/admin/catalog/media/{id}/register`).
  Images attach at PRODUCT level only (see G10).
- Bulk: CSV imports with dry-run, row-level error report, and checker approval
  (`/v1/admin/catalog/imports*`).
- Assortment: add variant to store (`POST /v1/admin/catalog/assortment`).
  No removal (see G2).
- Search synonyms: list + set/clear (`GET/PUT /v1/admin/catalog/synonyms`).

### 1.2 Stores, geo, serviceability
- Legal entities, cities (GeoJSON bounds), zones, delivery PIN rows: full CRUD
  (`/v1/admin/legal-entities`, `/cities`, `/zones`, `/delivery-pincodes`).
- Stores: create / patch / delete (`/v1/admin/stores[/{id}]`): legal entity,
  city, lat/lng, hourly capacity, last-order buffer. Plus hours
  (`PUT /stores/{id}/hours`), holidays (PUT/DELETE), staff assignment
  (`PUT /stores/{id}/staff`), COD toggle (`PATCH /stores/{id}/cod`),
  status (`POST /stores/{id}/status`), operations read.
- UI: `milk_admin/src/pages/Stores.tsx` covers all of the above.

### 1.3 Offers, discounts, referrals
- Coupons: create (PERCENT/FLAT/FREE_DELIVERY, caps, min order, per-user and
  global limits, validity window, store/category/product scope, variant
  exclusions, stackable, first-order-only) + list + PATCH (limits, validity,
  min order, active flag, version-checked). No delete — disable via
  `active=false`. Kind/value freeze after creation (anti-bait-and-switch).
- Referral program: NOT manageable (see G6).

### 1.4 Delivery charges and platform settings
- `POST /v1/admin/config/{key}` accepts the full ~100-key universe
  (`server/src/modules/app-config/contracts/config.ts`): order min/max, COD
  limit, all fee slabs and fees, free-delivery threshold, surge, dispatch,
  ETA, rider earnings, picking, inventory, zones/maps, wallet/topup,
  refunds, agent, notifications quiet hours, support SLAs.
- Feature flags (9): `agent_enabled`, `customer_location_required`,
  `online_payments_enabled`, `wallet_enabled`, `cod_enabled`,
  `subscriptions_enabled`, `auto_substitution`, `reinstate_expired_orders`,
  `surge_enabled` (`POST /v1/admin/feature-flags/{key}`).
- UI gap: Settings/OperationalSettings pages expose ~30 keys + fee-slab
  editor + only 5 of 9 flags (see G8, G9).

### 1.5 Notifications
- Push campaigns to CUSTOMER/RIDER/STORE/ADMIN apps, ALL/USERS/PLATFORM
  targeting, PROMOTIONAL/OPERATIONAL kinds, title/body/click-action/image,
  preview with reach estimate, idempotent create, list + delivery detail.
  Create = immediate fan-out (see G3 for schedule/cancel).
- Sending is SUPER_ADMIN-only, enforced at domain layer too.

### 1.6 Orders, payments, wallet, payouts
- Orders: list/detail/timeline/payments/invoice, cancel, hold, partial refund
  (amount + reason), delivery-code reset, rider reassign, wrong-address
  resolve, force-state restricted to CANCELLED/EXPIRED with reason.
- Payments: attempts, reconciliation list/review. Refunds list + manual-paid
  marking. Invoice render-failure retry.
- Wallet: adjustments (cash/promo × credit/debit + reason) with second-person
  approval + ledger. Solo admin can request + approve (audited single-person).
- Payouts: list, approval request, execute, cancel, paid, corrections,
  settlement, evidence upload.
- Subscriptions: plans/slots/holidays read+write, run history + retry.
  No per-customer management (see G4).

### 1.7 People, access, riders
- Workforce invite (RIDER/STORE_MANAGER/SUPPORT_AGENT/SUPER_ADMIN), user
  search, block/unblock, password reset, role-change request + approve,
  store assignment on/off.
- Rider applications: list + detail (read-only). Approval is automatic from
  document reviews (see §3 note). Direct approve/reject or admin override:
  see G7.
- Rider distance/earnings reviews with decision recording.

### 1.8 Inventory, support, compliance, ops
- Inventory: batches/ledger/report/summary reads, stock corrections,
  adjustment approvals, shelf-life rules.
- Support: tickets (list/get/update/acknowledge/messages/attachments),
  ticket refunds with maker-checker execute, canned responses, ratings
  moderation, fraud-signal review, rider-distance reviews.
- Compliance/P11: approvals queue + reject, erasure requests + retry +
  approvals, legal holds + release, exports/reports.
- Ops: outbox + failed-job inspection and replay, system health/history,
  dashboard, global search.


## 2. Gaps and fixes (do these to be ultimately customizable)

Ordered by value. Each item: what is missing → what to build.

### G8. Flags UI covers 5 of 9 flags — ADD 4 TOGGLES (smallest fix)
`milk_admin/src/pages/Settings.tsx` `FLAG_LABELS` is missing
`online_payments_enabled`, `subscriptions_enabled`, `auto_substitution`,
`reinstate_expired_orders`. The API already accepts all nine.
Fix: add four entries copying the existing pattern; verify each toggle flips
real behavior (e.g. subscriptions flag gates subscription UI).

### G9. Settings UI covers ~30 of ~100+ config keys — EXTEND GROUPS (best value)
API accepts every key; the UI only exposes the curated list in
`OperationalSettings.tsx`. Highest-impact missing keys: `feeTaxRules`,
`codEligibility`, `promoSpendCapBps`, wallet/topup caps and thresholds,
`refundDestinationPolicy`, `paymentWindowSeconds`, `catalogPriceApproval*`,
import limits, dispatch/ETA/picking/inventory/zone/map/handover/geofence keys.
Fix: add groups reusing the `Setting` row pattern + fee-slab editor pattern;
keep server-side validation as the backstop.

### G1. No reject for catalog price/import approvals — ADD REJECT (small)
Domain has `approve` only (`catalog.ts`, `imports.ts`). A bad request sits
until expiry.
Fix: add `reject(actor, requestId, reason)` at domain level, routes
`POST /v1/admin/catalog/approvals/{id}/reject` and
`POST /v1/admin/catalog/imports/approvals/{id}/reject`, Approvals UI action,
audit entries. Migrate nothing; requests already expire.

### G2. Assortment is add-only — ADD REMOVE (small-medium)
`setAssortment` is INSERT-only; nothing deletes a store/variant row, and
unpublish is product-global. Admin cannot delist one variant from one store.
Fix: add `removeAssortment` + `DELETE /v1/admin/catalog/assortment` (store +
variant) with guards: refuse while the variant sits in any active cart or
open order for that store (or define expire-and-drain semantics). UI: remove
button on the store assortment list with the guard message.

### G4. No per-customer subscription management — ADD SUPPORT ACTIONS (medium)
Admin has plans/slots/holidays/runs only. Support cannot pause/cancel/skip/
resume one customer's subscription.
Fix: add audited endpoints acting as the customer would (reuse the customer
domain operations, actor = staff, reason required), notify the customer,
surface in Support/People UI next to the user's subscriptions.

### G3. Campaigns can't be scheduled/paused/cancelled — ADD LIFECYCLE (medium)
Create fans out immediately in-transaction. No draft/schedule/cancel.
Fix (only if marketing needs it): `SCHEDULED` state + worker pickup +
cancel-before-send; keep preview + idempotent create unchanged.

### G5. Agent/nudge content not manageable — ADD TEMPLATE CRUD (medium)
`agent_nudge_templates` exists with zero admin routes (only config-key toggles).
Fix: add template list/get/create/update/disable + preview/test-send to one
test user, under SUPER_ADMIN.

### G6. Referral program not manageable — ADD REFERRAL ADMIN (medium)
Invites/claims tables exist (`068_referral_invites`), zero admin routes.
Fix: referral rules/rewards configuration + claim review queue (approve/reject
with reason) + invite/code lookup.

### G7. No direct rider-application decision — ADD AUDITED OVERRIDE (small)
By design, status flips automatically from document reviews
(`rider-onboarding.ts`: all required docs approved → APPROVED; any rejected →
REJECTED), and store managers are correctly scoped to their store's applicants
with self-review forbidden (`store-review-access.ts`). But a wrongly rejected
rider has no fix path except a manual role grant.
Fix: add explicit `POST approve/override` + `POST reject` on the application
with reason + audit, restricted to SUPER_ADMIN; keep document review as the
normal path.

### G10. Images are product-level only — CONFIRM OR EXTEND (decision + small/medium)
Media register takes `productId`; `catalog_product_images` has no variant link.
Fix: if variants need own images, add variant-image mapping + UI; otherwise
document product-level as the rule.

### G8b. Coupon delete — NO ACTION (documented behavior)
No DELETE route; disable via `active=false` and kind/value freeze after
creation. Keep; make sure support docs state the rule.


## 3. Semantics to confirm (working as coded — verify intent, no bug)

- **S1. Price is global per variant.** `catalog_global_prices` is a
  latest-wins view over `catalog_prices`; cart, quote, checkout, and scheduled
  orders all read it. A price set "for store A" effectively applies everywhere,
  so the required `storeId` in `PriceDto` is misleading. If single-price is the
  model: keep, but fix the DTO/docs; if per-store pricing is wanted, checkout
  pricing must change — large.
- **S2. One role per user** (`roles.length !== 1` → FORBIDDEN). No dual-hat
  staff. Operational consequence only.
- **S3. No post-placement order-item edit** (cancel + reorder instead) and no
  arbitrary force-state (restricted to CANCELLED/EXPIRED with reason). Keep.
- **S4. Price changes above threshold need approval** (`catalogPriceApproval*`
  config + Approvals queue). Keep; ensure the queue is monitored.


## 4. Store manager permissions — verdict: correctly limited

Enforcement points (all verified): every `/v1/store/*` route requires the
STORE_MANAGER role; cookie sessions pin it; mutations require `x-store-csrf`;
per-request `storeId` is checked against live assignments at the domain layer
(`hasStoreRole`: assignment + matching user role + active user, row-locked in
transactions); rider review additionally requires the applicant's home store
to match and forbids self-review.

Manager CAN (appropriate): dashboard/KPIs/SLA, inventory
(receive/count/adjust/request/approve/batch/quality/bin/export), picking full
lifecycle, orders pack/handover/returns-QC, COD deposits, rider document
review, inbox, own-store ONLINE/PAUSED toggle (no close/delete), read-only
staff list.

Manager CANNOT (verified by route absence): catalog, prices, coupons, config,
flags, wallet, payouts, refunds, users, stores, campaigns, tickets, reports.
`GET /staff` is read-only; assignment is admin-only.

Permission issues to resolve:
- **P1. SUPPORT_AGENT cannot use the admin portal — DEFERRED.** Cookie
  sessions force SUPER_ADMIN (`identity-guard.ts`) and the UI is cookie-only,
  so support staff would need full admin or work outside the portal. No action
  while there is no support team. Revisit on first support hire: either
  support-scoped portal sessions or documented token-only usage.
- **P2. Store managers CAN approve their own inventory counts.** The
  maker-checker carve-out permits single-person approval for STORE_MANAGER
  (added Nov 14, deliberate, audit-flagged). Re-confirm this is still intended;
  to tighten, require a distinct checker for store approvals.
- **P3. Store pause needs no reason?** `POST /v1/store/status` takes an
  optional reason while pausing directly affects customer availability.
  Decide: keep optional or require it.


## 5. Master test prompt (copy everything below the line and run it)

> Paste this to a tester or agent as the acceptance run. Isolated staging DB
> only. Destructive cases must never run on production.

---

You are testing the DairyDirect admin portal (milk_admin), store portal
(milk_store), and their downstream effects on the customer app, partner app,
and store app. Test on an isolated staging database. NEVER run destructive
cases on production.

SETUP (do first, record IDs)
S1. Create SUPER_ADMIN user A (workforce invite → set password → login).
Verify login works and wrong password fails.
S2. Create STORE_MANAGER user M assigned ONLY to store S1 (not S2). Log into
the store portal as M.
S3. Create SUPPORT_AGENT user G. Attempt admin portal login; record the exact
result (expected today: rejected — P1 deferred until support exists).
S4. Create test customer C, rider R, product P (variant V) in category CAT.

ADMIN — CATALOG (Products page)
A1. Create brand B, category CAT2. Rename CAT2. Expected: list reflects change.
A2. Create product P2 under CAT2 with description, HSN, GST bps,
perishable=true, expiryTracking=true. Expected: unpublished; customer app
does NOT show it.
A3. Upload a product image (valid PNG/JPG) and attach to P2. Then try a 50MB
file and an .exe. Expected: valid succeeds and renders; invalid rejected
with a clear error.
A4. Add variant V2 (PIECE) with SKU + barcode to P2. Expected: variant listed.
A5. Publish P2 → visible in customer browse/search. Unpublish → disappears.
A6. Set price for V2 (store S1, selling ₹100, MRP ₹120, no dates). Expected:
applies immediately (small change); customer app shows ₹100.
A7. Set price for V2 to ₹500 (large jump). Expected: returns approvalId, price
stays ₹100; approve in Approvals → ₹500. Try to REJECT an approval → record
whether any reject affordance exists (G1).
A8. Set price with validFrom = tomorrow. Expected: current price unchanged
until then.
A9. Add V2 to S1 assortment. Attempt to REMOVE V2 from S1 assortment → record
whether any remove affordance exists (G2).
A10. Add synonym term→expansion; search it in the customer app. Clear it
(expansion=null). Verify both directions.
A11. Run a catalog CSV import (2 valid rows + 1 bad row): dry-run, then real.
Check the report shows row errors. Approve the import. Verify products appear.
A12. Delete V2, then P2, then CAT2. Then try deleting a category that still
has a published product → must be refused.
A13. Set a price "for store S1" and check the price shown for S2's context.
Record: price is global per variant (S1) — confirm this matches the intended
pricing model.

ADMIN — STORES, GEO, SERVICEABILITY
B1. Create legal entity, city (with polygon), zone, PIN row, then store S3
(capacity, buffer minutes, lat/lng). Invalid lat/lng rejected.
B2. Set S3 hours (Mon–Fri windows), add a holiday (closed), delete it. Toggle
S3 ONLINE→PAUSED→ONLINE with reason; try PAUSED without reason → record result.
B3. Toggle S3 COD on/off. Assign manager M to S3, then deactivate.
B4. Delete an EMPTY store. Attempt to delete S1 (has inventory/orders) →
record behavior.
B5. Flip a PIN row active/inactive; verify customer checkout serviceability
for that PIN flips accordingly.

ADMIN — OFFERS & DISCOUNTS
C1. Create PERCENT (10%, cap ₹50), FLAT, and FREE_DELIVERY coupons with min
order, per-user/global limits, store scope, 7-day validity.
C2. As customer C: apply each at checkout. Verify math, cap, min-order
rejection, per-user limit on third use.
C3. Edit a coupon: validity + limits + minOrder + deactivate. Verify a
deactivated coupon is rejected clearly. Attempt kind/value change and DELETE
→ record results (expected: impossible by design).
C4. Verify an exhausted global limit blocks further redemptions.

ADMIN — OPERATIONS, MONEY, PEOPLE
D1. Change each OperationalSettings value + fee slabs (add/remove/reorder,
open-ended last). After each save, place a test order and verify fee math.
D2. Toggle EACH of the 9 feature flags. Record which lack a UI toggle (G8);
verify a toggled flag changes app behavior.
D3. Invite workforce users (each role), block/unblock, password-reset,
request + approve a role change, assign/unassign a store. Blocked user cannot
log in anywhere.
D4. Wallet: credit ₹100 promo to C with reason → second admin approves (or
same admin while solo — verify audit flags single-person) → balance + ledger
correct.
D5. Payouts: list → approval → execute → paid → correction → settled on a
test payout. Record any step lacking UI.
D6. Orders: timeline, payments, invoice. Hold, cancel with reason, partial
refund with reason, rider reassign with reason, delivery-code reset,
wrong-address resolve, force-state to CANCELLED. Each writes timeline/audit.
D7. Support: ticket reply, canned response, attachment, ticket refund (raise →
execute as checker). Moderate a rating. Review a fraud signal and a distance
case.
D8. Reports: run each report kind; create an export → download → verify.
D9. Subscriptions: edit plan/slot/holiday; retry a failed run. Attempt to
pause/cancel ONE customer's subscription → record result (G4).
D10. Inventory: post a correction with reason, approve an adjustment, set a
shelf-life rule; verify batches/ledger/report reflect it.
D11. Ops: inspect outbox + failed jobs; replay one dead-letter item; verify.
D12. Rider applications: open list + detail. Attempt direct APPROVE/REJECT →
record result (expected today: read-only; approval flows from document
reviews — G7). As a store manager, approve all required docs for a test rider
→ profile flips APPROVED; reject one doc for another → profile REJECTED.

ADMIN — NOTIFICATIONS
E1. Preview a PROMOTIONAL campaign for the CUSTOMER app: reach estimate shows.
E2. Send to test user C only (USERS mode). C receives (push + in-app);
untargeted user does not. Double-submit same Idempotency-Key → no duplicate.
E3. Send OPERATIONAL vs PROMOTIONAL during quiet hours → promotional held,
operational delivered.
E4. Attempt to schedule for later and to cancel a sent campaign → record
results (G3).

STORE PORTAL (as M, assigned to S1 only)
F1. Dashboard/KPIs/SLA load for S1. Request S2 (unassigned) on every screen →
reads AND writes must fail closed (403/404), never leak S2 data.
F2. Receive stock (new batch), move bin, record quality issue, run a count
session (create → count → complete), post a cycle count, approve an
adjustment. Attempt to approve YOUR OWN count → record result (P2).
F3. Attempt: change a price, create/edit a coupon, open settings/config,
touch wallet/payouts/users/stores → must be absent from UI AND API-rejected.
Record status codes.
F4. Pack → handover with code (wrong code fails; lockout after max attempts),
return flow (draft → QC), pick task full lifecycle incl. short/substitute,
heartbeat, release, reassign.
F5. COD: record a deposit; check rider cash list.
F6. PAUSE S1 with reason → customers see it unserviceable; back ONLINE.
Attempt CLOSED/delete status → impossible.
F7. Rider applications: list S1 applicants, open one, view a document,
approve one doc + reject another with reason. Craft API calls: review an S2
applicant → forbidden; review your own document → forbidden.
F8. Notifications read/unread/read-all work; SEND a campaign → impossible.
F9. Staff page is read-only (no invite/remove/edit).
F10. Repeat one mutation WITHOUT x-store-csrf header → 403.

CROSS-APP CHECKS (after each change above)
G1. Price change → browse, cart, quote, receipt agree.
G2. Coupon change → checkout matches within one refresh.
G3. Store pause → customer + partner reflect it; resume restores.
G4. Campaign → correct apps/users notified exactly once.
G5. Force-state/cancel/refund → order status, wallet ledger, invoice agree.

PERMISSIONS (assert all)
H1. STORE_MANAGER credential on any /v1/admin/* → 401/403 everywhere.
H2. CUSTOMER/RIDER credential on /v1/store/* or /v1/admin/* → denied.
H3. Logged-out portal requests → 401; tampered/expired sessions → 401.
H4. Dual-role user (if creatable) → rejected by single-role rule.
H5. Document the SUPPORT_AGENT login result from S3 for the P1 decision.

REPORT: per case PASS/FAIL + one-line evidence (screenshot, API status, or
observed value). List every FAIL with the exact breaking step.

---

## 6. Suggested build order (when you staff it)

1. G8 + G9 (admin UI coverage: flags + config keys) — pure UI, highest value.
2. G1 + G2 (reject approvals, assortment remove) — small backend + UI.
3. G7 override + P2 decision (approval semantics) — small, needs your call first.
4. G4 (support subscription actions) + G3 (campaign lifecycle, if marketing asks).
5. G5 + G6 (agent templates, referral admin) — new surfaces.
6. P1 only when the first support hire arrives; P3 with any store-settings touch.
