# Detailed Plan: Connect the Admin Web Portal to the Backend

## 1. Goal and scope

- Connect all 14 existing sections of milk_admin_web to the NestJS backend.
- Preserve the existing portal design, navigation, responsive layout, and user journeys where the backend supports them.
- Replace demo login, seeded records, simulated actions, client-side reports, and fabricated success messages.
- Treat Admin and Superadmin as one role: show “Admin” in the portal and use the existing SUPER_ADMIN backend role.
- Restrict this portal to active admins; keep the separate store-manager portal and existing support APIs intact.
- Add backend endpoints and database migrations where existing APIs cannot support the portal.
- Do not deploy to production, provision credentials, or run production migrations as part of this work.

## 2. Establish the integration baseline

- Inventory each route, modal, filter, table, action, and field in the existing portal against current backend controllers.
- Use the actual controllers and freshly generated OpenAPI contract as the source of truth; existing generated manifests may be stale.
- Record which controls map to an existing API, need a new read endpoint, or must be adapted to a real workflow.
- Replace every direct dependency on the mock database, including page-level useDB selectors, not only the shared API module.
- Preserve existing changes in both the root repository and the nested milk_admin_web repository.
- Keep the portal’s npm lockfile and the server’s existing pnpm workflow.

## 3. Authentication and session security

- Implement email-and-password login against the configured Cognito workforce pool using a server-side authentication adapter.
- Remove prefilled demo credentials, fake account buttons, mock authentication, and any fallback that logs in an unknown user.
- Support required new-password and configured verification challenges, plus forgot-password and confirm-reset flows.
- Keep temporary challenge state on the server; never expose provider refresh tokens or client secrets to the browser.
- Return generic authentication and reset errors that do not disclose whether an account exists.
- Rate-limit login, challenge, and reset endpoints and apply origin checks to their browser requests.
- Verify the provider token’s issuer, audience, token use, group, and active database identity before creating a session.
- Accept only the existing SUPER_ADMIN role for this portal, including on routes otherwise available to support agents.
- Add a server-side session record with a hashed, cryptographically random session identifier.
- Encrypt provider tokens at rest with a versioned server-held encryption key and authenticated encryption.
- Set a host-only, HTTP-only, SameSite=Lax cookie; require Secure over HTTPS and permit HTTP only for explicit loopback development.
- Default to an eight-hour inactivity limit and seven-day absolute limit, configurable and capped by provider refresh validity.
- Provide session bootstrap, login, challenge, password-reset, and logout endpoints under /v1/admin/auth.
- Return only a sanitized admin profile and per-session CSRF token from the session bootstrap endpoint.
- Require a CSRF token and trusted Origin for session-backed mutations, including session termination.
- Resolve browser sessions through an admin-only adapter that invokes the existing token verifier and identity authorization.
- Recheck the current database account and role for every protected request; revoke access promptly when either changes.
- Preserve existing bearer-token authentication and authorization for mobile apps and other API clients.
- Reject requests presenting conflicting cookie and bearer credentials rather than guessing which identity to use.
- Refresh expired access tokens server-side and atomically save rotated refresh tokens.
- Coordinate concurrent refreshes across server instances without holding a database transaction open during provider calls.
- Treat a provider outage as retryable; revoke the session and require login when refresh is invalid or irrecoverably ambiguous.
- Revoke the session, clear the cookie and in-memory queries on logout; synchronize logout across browser tabs.
- Create the session table with a forward-only migration, expiration cleanup, least-privilege grants, and no token logging.
- Follow the provider’s documented rotation behavior: https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html.

## 4. Browser transport and data foundation

- Proxy /v1 requests and required local upload/download paths through Vite during development.
- Serve the production SPA and proxy the API under the same origin; document SPA fallback and proxy configuration.
- Regenerate the admin OpenAPI contract and generate TypeScript API types from the fresh contract.
- Implement one typed HTTP client for credentials, CSRF headers, structured errors, and Retry-After handling.
- Build domain adapters that map real UUIDs, backend enums, pagination, and nullable fields into the existing UI.
- Preserve currency as integer paise or decimal strings; do not pass arbitrary values through unsafe floating-point conversions.
- Interpret dashboard business dates in Asia/Kolkata and retain UTC timestamps for storage and API boundaries.
- Use React Query for server data with user-scoped query keys and targeted invalidation after confirmed mutations.
- Make filters, search, sorting, and pagination server-side; reset cursors when filters change.
- Show next/previous cursor navigation and avoid claiming an exact total when the server does not provide one.
- Send stable idempotency keys for sensitive operations and retain the same key when retrying the same user intent.
- Do not automatically retry non-idempotent mutations; add backend idempotency where existing critical writes lack it.
- Show loading, empty, validation, permission, conflict, rate-limit, offline, and server-error states.
- Disable a control when the backend says an action is unavailable and explain the applicable reason when provided.
- Do not invent values, synthesize missing records, or report success before the server confirms a change.
- Replace persisted sensitive React Query data with in-memory state and clear queries on logout or session change.
- Remove legacy mock auth, journal, query-cache, and subscription-config keys while retaining unrelated browser settings.
- Ensure the service worker does not cache authenticated API responses, private documents, or exports.
- Remove unused public mock/Supabase configuration and secrets from the frontend environment example.

## 5. Backend interfaces and database work

- Add GET /v1/admin/dashboard for bounded date-range and optional store-level aggregates.
- Add GET /v1/admin/delivery/fleet for actual rider locations, availability, and last-update timestamps.
- Add GET /v1/admin/orders/:id/rider-candidates using the existing assignment eligibility rules.
- Add GET /v1/admin/orders/:id/invoice for an authorized, audited download of the already-issued document.
- Add paginated global payment-attempt, refund, and wallet-ledger reads with appropriate finance filters.
- Add a bounded cross-store inventory summary and extend existing stock, customer, workforce, and catalog filters as needed.
- Add paginated rating-moderation and legal-hold lists, plus bounded global search across supported entities.
- Expose action eligibility where existing screens cannot safely determine it from current backend responses.
- Validate filter values, UUIDs, cursor limits, date ranges, and monetary inputs at the API boundary.
- Require admin authorization for every new endpoint and return only fields needed by the portal.
- Use stable keyset pagination and indexed, set-based queries; avoid loading entire tables to filter in memory.
- Add forward-only indexes only where query plans justify them, using the repository’s safe migration conventions.
- Stream the existing invoice as a private attachment with safe content headers; indicate when it is not yet rendered.
- Audit sensitive reads and writes according to existing domain conventions and never log credentials or private URLs.
- Update OpenAPI schemas, operation manifests, runtime grants, and contract tests alongside each new endpoint.

## 6. Connect the 14 portal sections

### 6.1 Dashboard

- Load real summary cards and charts for today, 7, 30, and 90 days, optionally filtered by store.
- Calculate invoiced sales as issued invoice totals minus issued credit-note totals within the selected period.
- Show processed refunds separately and do not subtract them twice from invoiced sales.
- Show global wallet top-ups separately; indicate that a store-specific top-up figure is unavailable.
- Label snapshot counts, period totals, report timestamps, and partial or unavailable metrics clearly.

### 6.2 Stores

- Connect city, legal-entity, store, and service-zone lists and their supported create, edit, and delete actions.
- Connect store status, COD settings, operating hours, holidays, and manager/staff assignments.
- Save real zone polygons and display server-side validation or overlap errors.
- Confirm consequential changes, submit required fields, and refresh the affected store and zone data.

### 6.3 Products

- Connect categories, brands, products, variants, publication, assortment, and store pricing.
- Require real product identifiers and prices; remove generated SKU, barcode, and mock pricing values.
- Use the existing upload-target and registration flow for product media.
- Connect catalog CSV import, validation/reporting, job status, and any required approval actions.

### 6.4 Inventory

- Load store stock, batches or expiry information, and inventory ledger from the applicable APIs.
- Add the cross-store view through the new paginated inventory summary rather than local aggregation.
- Connect existing shelf-life configuration and approval flows where the current interface exposes them.
- Show the real quantity, unit, store, transaction reason, and timestamp; do not create unsupported adjustments.

### 6.5 Orders

- Connect order lists, filters, details, timeline, payment attempts, and current delivery information.
- Represent order status and hold state separately, using the backend’s authoritative state.
- Connect supported cancellation, hold, release, refund-request, and force-state workflows with required reasons.
- Limit force-state controls to the backend-supported CANCELLED and EXPIRED outcomes.
- Connect eligible rider reassignment, wrong-address resolution, and delivery-code reset using current policy checks.
- Provide the existing issued invoice as a protected download; never fabricate an invoice or reveal a fake delivery OTP.

### 6.6 People

- Connect paginated customer and workforce lists, customer details, and rider-application lists and details.
- Support existing workforce invitation, account block, password reset, role-change request, and store-assignment flows.
- Display current role and account status from the backend and surface any approval or last-admin restrictions.
- Keep rider document review and approval in the existing assigned store-manager workflow.

### 6.7 Payments

- Connect global payment attempts, refunds, wallet ledger, reconciliation findings, and invoice-render failures.
- Apply store, status, date, and search filters on the server and show actual provider and processing states.
- Connect authorized wallet adjustments, refund requests, manual settlement with evidence, and invoice-render retries.
- Display requested, approved, processed, and failed states accurately; remove mock force-status actions.
- Use the real approval and idempotency rules for every money movement.

### 6.8 Payouts

- Connect payout lists, detail, approvals, corrections, cancellation, and settlement records.
- Upload and register evidence through the existing private-media flow before marking a payout paid.
- Show pending, approved, cancelled, and paid states only when returned by the backend.
- Explain that recording an external settlement does not itself transfer money.

### 6.9 Offers

- Connect coupon creation and updates using the backend’s actual coupon types and validation rules.
- Connect push-campaign preview, creation, list, and detail using supported audience selectors.
- Show real delivery or processing results and preserve server-side validation errors.
- Remove or disable scheduled campaigns, drafts, and audience types that have no backend workflow.

### 6.10 Subscriptions

- Connect plan, slot, holiday, and subscription-run lists and supported edits to the backend.
- Connect eligible run retries and display actual run status and errors.
- Remove the local subscription configuration fallback and reload saved settings from the server.
- Respect server-side feature flags, store scope, and date validation.

### 6.11 Support

- Connect ticket lists, details, assignment/status changes, customer messages, and internal notes.
- Connect private attachment upload and authorized download, canned responses, and ticket refund requests.
- Add the rating-moderation list and connect moderation actions to their existing backend endpoint.
- Preserve the distinction between customer-visible messages and internal notes.

### 6.12 Reports

- Connect real previews for catalog, stock, financial, picking, rider, subscription, and support reports.
- Apply date and store filters on the server and retain them when creating an export.
- Create idempotent export jobs, poll actual job status, and download the authorized server-generated CSV.
- Replace simulated timers, partial client-side exports, and fake Excel output with real job outcomes.

### 6.13 Approvals

- Connect approval queues, detail, rejection, and the action-specific execution endpoints.
- Show the real requester, required role, status, expiry, and permitted actions from backend data.
- Follow the backend’s maker/checker policy, including permitted single-admin approval where supported.
- Connect fraud reviews, reconciliation reviews, erasure requests, and legal-hold create/release/list workflows.
- Require reasons and confirmation where the existing backend workflow requires them.

### 6.14 Settings

- Load real configuration keys and feature flags, respecting their types, validation, and versions.
- Connect supported updates and surface conflicts rather than overwriting a newer configuration.
- Connect real notifications, unread state, failed jobs, outbox records, and supported replay actions.
- Remove fake settings, flags, job states, and operations the backend does not implement.

## 7. Shared search, notifications, and fleet map

- Connect top-bar search to the bounded admin search endpoint with debounce and server-side authorization.
- Connect notification list, unread count, and read actions to the existing notification endpoints.
- Plot only real rider coordinates and show their last-update time and availability.
- Poll the fleet endpoint every 15 seconds while the relevant view is visible; stop polling when hidden.
- Mark or omit stale positions using the backend’s configured location freshness threshold.
- Remove simulated movement, fabricated destinations, and route lines presented as actual navigation.
- Revalidate rider eligibility on the server when an assignment is submitted.

## 8. Testing and acceptance

- Add frontend tests for each of the 14 sections: loading, populated, empty, forbidden, and failed requests.
- Test representative create/update actions, validation messages, server filters, pagination, and query invalidation.
- Test money conversion, IST date boundaries, invoice/credit-note totals, refunds, and unattributed wallet top-ups.
- Test login, password reset, required challenges, browser restart, logout across tabs, and expired sessions.
- Test wrong role, wrong token audience, disabled account, revoked role, CSRF failure, and conflicting credentials.
- Test token refresh concurrency, refresh-token rotation, provider outages, session cleanup, and encryption.
- Test that existing bearer-token clients and separate store-manager and support access remain compatible.
- Test idempotent retries, duplicate submissions, stale state conflicts, evidence uploads, and private downloads.
- Test rider location freshness, real candidate eligibility, and assignment changes during an open dialog.
- Test every new API for authorization, input validation, pagination, query bounds, and audit behavior.
- Add isolated end-to-end journeys for store/catalog setup, orders, refund approval, payout evidence, and subscriptions.
- Test report creation, polling, CSV download, invoice availability, and removal of all demo export behavior.
- Check that private API responses, tokens, and sensitive query results do not appear in persistent browser storage.
- Run server unit, integration, concurrency, migration, and relevant end-to-end tests with isolated dependencies.
- Run frontend tests, typecheck, and production build; regenerate and validate OpenAPI and operation manifests.

## 9. Delivery sequence and handoff

- Phase 1: document the screen/API mapping and complete authentication, session storage, and same-origin proxying.
- Phase 2: add the shared client, generated types, error states, pagination, and missing backend read endpoints.
- Phase 3: connect stores, products, inventory, orders, people, and the dashboard.
- Phase 4: connect payments, payouts, offers, subscriptions, support, reports, approvals, and settings.
- Phase 5: complete shared search and fleet data, remove remaining mocks, and run the full acceptance suite.
- Update CI for both the server and nested admin application and document environment variables and local startup.
- Document proxy rules, session-key management, database grants, migration order, and operational recovery.
- Use a configured Cognito development pool for real local login; use an injected provider only in tests.
- Treat production deployment, real credentials, and production migration execution as separate follow-up work.
