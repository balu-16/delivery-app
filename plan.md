# Detailed Plan: Connect the Store Manager Web Portal to the Backend

## Goal and agreed decisions

- Connect the standalone `milk_store` frontend to the existing backend in `server`.
- Make all nine store sections work with real backend data and operations.
- Add missing backend capabilities where needed to support the existing workflows.
- Keep the store portal separate from the existing `milk_admin` frontend.
- Follow the backend's existing stock, order, cash, and authorization rules when demo behavior conflicts.
- Keep store managers signed in across page refreshes through server-managed sessions.
- Test against the currently configured AWS development environment using isolated test resources.
- Use a dedicated controlled inbox to verify real password-reset emails and codes.
- Keep production deployment outside this task.

## Phase 1: Establish the current contracts

- Inventory every visible control, form, filter, link, and workflow in all nine store sections.
- Map each control to an existing `/v1/store` operation or record the missing backend capability.
- Review `server/store_manager_web` for the existing Cognito, picking, and rider-review integrations.
- Confirm the current OpenAPI schemas against the actual NestJS controllers and domain services.
- Preserve the existing `STORE_MANAGER` role; do not reintroduce the retired `PICKER` role.
- Identify every direct `useDB`, demo seed, fixed clock, and client-side fake mutation in `milk_store`.
- Record differences in status names, IDs, quantities, pagination, and available response fields.
- Create a feature-to-API and feature-to-browser-test matrix to track completion.

## Phase 2: Implement secure store sessions

- Add `/v1/store/auth/login`, `/challenge`, `/session`, `/forgot-password`, `/forgot-password/confirm`, and `/logout`.
- Use the configured Cognito store client for login, password challenges, recovery, and token refresh.
- Verify the store audience, current `STORE_MANAGER` role, account status, and store assignments server-side.
- Store provider tokens in encrypted server-side session records with idle and absolute expiration.
- Issue a separate host-only `HttpOnly` store-session cookie, using `Secure` outside loopback development.
- Keep store and admin cookies, roles, session records, and logout operations independent.
- Require CSRF tokens and allowed-origin checks for cookie-authenticated state-changing requests.
- Preserve bearer-token access for existing store API clients and reject conflicting store credentials.
- Support first-login password changes, generic sign-in failures, reset-code errors, and provider outages.
- Bootstrap the session on refresh without placing passwords or access tokens in browser storage.
- Retain the current 30-minute idle behavior with a warning before expiry and a configurable maximum lifetime.
- Make “Remember me” control browser-close persistence; either option must survive a page refresh.
- Revoke the server session on sign-out and synchronize logout and expiry across open tabs.
- Clear or ignore old demo-session data so it cannot authenticate a real store session.

## Phase 3: Build the shared frontend data layer

- Generate store API types from the backend OpenAPI contract after updating its DTOs and responses.
- Create one typed HTTP client with cookie credentials, CSRF headers, timeout handling, and consistent errors.
- Add a same-origin Vite proxy for `/v1/store` and document the equivalent production routing requirement.
- Prevent the service worker from caching or serving the app shell for authenticated API requests.
- Replace mock `storeApi`, mock mutations, demo timestamps, and direct mock-database selectors.
- Use server-returned IDs, status values, quantities, assignment data, and configured business timezone.
- Scope React Query keys by user, store, filters, and pagination; cancel or ignore stale store responses.
- Clear sensitive queries on logout and when permissions or the active store change.
- Retain stable idempotency keys for retryable operations and avoid duplicate submissions while pending.
- Show real loading, empty, validation, permission, conflict, and retry states without fake success messages.
- Keep theme preferences locally; use the server as the authority for operational and account data.
- Remove demo-only login credentials, hardcoded handover codes, and automatic fallback to seeded data.

## Phase 4: Add the missing backend capabilities

- Add store-scoped dashboard aggregates, store details, operating hours, and status-history reads.
- Add authorized search for relevant orders, customers, and products within assigned stores.
- Add picking-task detail and release operations and extend task lists with required filters and pagination.
- Expose inventory batch, bin, receipt, adjustment, and count-session history needed by the UI.
- Add persistent count drafts and completion through the existing inventory reconciliation rules.
- Provide a filtered inventory CSV export that includes all matching records, not only the visible page.
- Add return list/detail reads and persistent inspection drafts around the existing return and QC services.
- Expose eligible COD riders, deposit history, references, notes, totals, and server-derived discrepancies.
- Add persistent notification mark-unread and the store preference detail required by the current UI.
- Extend rider and profile responses only with fields required for authorized store workflows.
- Check current role and store assignment for every new read and mutation, including nested IDs.
- Reuse transactional domain services, immutable ledgers, audit events, idempotency, and version checks.
- Add forward-only schema migrations and indexes; do not edit previously applied migrations.
- Keep mandatory transactional notifications and existing maker-checker approval rules intact.

## Phase 5: Connect each store section

### Login and store selection

- Connect login, first-login challenge, forgot-password, reset-password, refresh, and sign-out screens.
- Load the manager profile and authorized stores from the authenticated backend session.
- Keep the selected store only while it remains in the manager's current assignment list.
- Show the existing no-store state when a valid manager has no assignments.
- Remove controls and messages that imply the demo password flow is live.

### 1. Dashboard

- Load store-specific KPIs, charts, workload, alerts, and upcoming tasks from real aggregates.
- Calculate dates, deadlines, and today’s metrics using the configured business timezone.
- Connect pause/resume controls, quick actions, alert links, and task deep links.
- Display genuine empty or unavailable values rather than seeded numbers or invented zeros.
- Calculate summary totals across the complete matching dataset, not just the first result page.

### 2. Orders and picking

- Connect queue, all-orders, and my-tasks tabs with search, filters, pagination, and task details.
- Connect claim, start, heartbeat, release, reassignment, and the server's task ownership rules.
- Connect barcode entry, batch selection, picked quantities, shortages, and eligible substitutions.
- Complete picking only after the backend accepts all required item decisions.
- Connect packing and handover to real order and rider state, including the backend-issued code flow.
- Adjust demo controls that conflict with backend rules and never display a generated demo handover code.

### 3. Inventory

- Connect stock, batch, low-stock, expiry, and bin-location views with server-side filters and pagination.
- Connect stock receipts, count drafts, count completion, adjustments, and approval outcomes.
- Submit quantities as backend-compatible integer strings and preserve version and idempotency checks.
- Show real receipt and adjustment history and export the full filtered stock result to CSV.
- Surface insufficient stock, invalid expiry, stale versions, and approval-required results clearly.

### 4. Returns and quality checks

- List eligible failed-delivery orders and actual returned parcels for the active store.
- Connect return recording, inspection drafts, per-item decisions, quarantine, and processing.
- Enforce the backend's returned-quantity and order-state rules instead of generating batch IDs.
- Map saleable, damaged, and expired choices to authorized inventory QC and ledger operations.
- Show persisted inspection outcomes and accurately report partial failures or rejected operations.

### 5. Rider applications

- Connect application lists, search, status filters, pagination, and detailed document review.
- Open private documents through short-lived authorized links without exposing them in logs.
- Connect approval and rejection, including required reasons and backend-driven application status.
- Refresh the list and details after review and prevent access to another store's applications.

### 6. COD cash deposits

- Load eligible riders and show real deposit history, search results, references, notes, and totals.
- Convert entered rupee amounts to integer paise without floating-point rounding errors.
- Submit deposits with stable idempotency keys and the authenticated manager's store context.
- Display settlement and discrepancy outcomes returned by the backend instead of user-invented statuses.
- Handle invalid amounts, duplicate references, concurrent submissions, and unauthorized riders.

### 7. Store status

- Display the backend's actual online, paused, or offline state, hours, reason, and status history.
- Connect pause and resume with the existing reason, authorization, and audit requirements.
- Update dashboard and store views after a successful change; preserve errors without false success.

### 8. Staff and workload

- Connect staff assignments, active and overdue workloads, task details, and reassignment.
- Enforce valid assignees, ownership, capacity, and store boundaries using backend decisions.
- Refresh workload totals and task ownership after each accepted assignment change.

### 9. Notifications and account

- Connect notification inbox filters, search, pagination, read/unread, mark-all-read, and preferences.
- Preserve mandatory transactional notifications and persist user-controlled preferences on the server.
- Connect account details, password recovery, sign-out, top-bar links, and store-scoped search.
- Ensure notification links resolve to authorized records in the correct store after refresh.

## Phase 6: Prepare the AWS development test environment

- Verify that `server/.env` targets the intended non-production AWS account, region, cluster, pool, and buckets.
- Use Node 26.13.0 and pnpm 12.18.0 for the backend and the frontend's npm lockfile for `milk_store`.
- Reuse the repository's AWS helpers to create an isolated test database and cache namespace in the dev environment.
- Use dedicated test queue and storage prefixes; never consume or delete unrelated development resources.
- Apply migrations to the isolated test database and run the backend and workers with test-specific settings.
- Provision synthetic managers, an admin, riders, customers, and at least two stores with different assignments.
- Seed products, batches, stock, eligible orders, picking tasks, returns, deposits, and notifications.
- Use a controlled mailbox and test identities for Cognito password-reset and challenge flows.
- Keep credentials, verification codes, private document URLs, and session tokens out of test logs and traces.
- Fail the setup clearly if AWS permissions, the inbox, or isolated test resources are unavailable.

## Phase 7: Test every section in the browser

- Install Playwright for `milk_store` and run Chromium against the real test frontend and backend.
- Exercise the full interface at desktop and mobile viewport sizes, including keyboard navigation.
- **Login:** test success, failure, first-login challenge, real password reset, refresh, expiry, and logout.
- **Access:** test no assigned store, store switching, cross-store denial, and rejection of admin credentials.
- **Dashboard:** compare metrics with fixture records and test every shortcut, alert link, and status action.
- **Picking:** test tabs, filters, claim/start, scans, short/substitute, completion, packing, and handover.
- **Picking errors:** test competing claims, wrong barcodes, invalid quantities, expired codes, and retries.
- **Inventory:** test all views, receiving, bins, count drafts, adjustments, approvals, history, and CSV export.
- **Inventory errors:** test invalid expiry, insufficient quantities, stale versions, and duplicate submissions.
- **Returns:** test eligible order selection, recording, drafts, each quality outcome, and inventory effects.
- **Rider review:** test list/filter/search, authorized document access, approval, rejection, and cross-store denial.
- **COD:** test eligible riders, exact amounts, submission, history, totals, discrepancy results, and retries.
- **Store status:** test online/paused/offline displays, pause reasons, resume, history, and availability effects.
- **Staff:** test workload filters, task navigation, reassignment, capacity limits, and invalid assignees.
- **Notifications:** test filters, links, read/unread, mark-all-read, preferences, account, and sign-out.
- Test session and store switching across two tabs without exposing the previous user's cached data.
- Verify the same persisted changes are visible after refresh and to another authorized manager.
- Verify every successful browser action against the corresponding authorized API or persisted backend record.
- Exercise empty states, slow responses, disconnected requests, permission failures, and recoverable errors.
- Use real backend requests for happy paths; simulate network failure only in dedicated failure scenarios.
- Track each visible control and scenario in the feature-to-test matrix with pass, fail, or blocked evidence.

## Phase 8: Verification and handoff

- Run backend unit, API, migration, authorization, and concurrency tests against appropriate test resources.
- Run frontend type-check, lint, unit tests, production build, and the complete Playwright suite.
- Verify the existing admin portal and bearer-token store client still authenticate and operate as before.
- Confirm no live store workflow reads demo data, generates fake operational IDs, or reports simulated success.
- Capture sanitized failure traces and a section-by-section report, including any unverified provider behavior.
- Clean up only test-owned Cognito users, queues, objects, cache keys, and temporary database resources.
- Preserve required immutable audit or ledger evidence and explicitly report any cleanup failure.
- Document setup, environment variables, migration steps, test commands, and known limitations.
- Complete the work only when all visible workflows and required checks pass, or report concrete blockers.
