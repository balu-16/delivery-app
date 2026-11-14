# Local operations and P3–P4 activation notes

## Start and verify

Follow [README.md](../README.md) for the pinned Node/pnpm toolchain and local PostGIS/Redis/LocalStack/Mailpit setup. Run migrations before starting any role. Seeds are local-only, repeatable and preserve edited records. Catalog assortment starts at zero; the inventory seed uses the same receipt/ledger service as normal stock intake.

`/healthz` is process liveness. `/readyz` checks configured dependencies. `/metrics` requires the configured bearer secret and is unavailable when the secret is empty. Logs use request IDs and sanitized errors; do not put tokens, private URLs, KYC bytes or CSV bodies into log messages.

The rate limiter uses the socket peer unless `TRUSTED_PROXY_CIDRS` explicitly lists the IP addresses or CIDR ranges of the reverse proxies that connect to this service. Set it to a comma-separated list only after checking the deployed network topology; the proxies must replace or sanitize forwarded headers. Leave it empty for direct access. Do not trust all clients. Verify both the client address forwarded by a trusted proxy and rejection of spoofed headers from an untrusted peer. Provider webhooks use the separate `RATE_LIMIT_WEBHOOK_PER_MIN` limit, in addition to their signature verification.

Use `pnpm test:coverage` for all four test projects. With existing test-only real services, set both `TEST_DATABASE_URL` and `TEST_REDIS_URL`; otherwise Testcontainers needs Docker. `pnpm openapi:export` builds and validates all audience contracts. Generated test/coverage/API artifacts are ignored by Git.

## Storage

Local storage uses `LOCAL_PRIVATE_STORAGE_DIR` for KYC and `LOCAL_CATALOG_STORAGE_DIR` for catalog/import objects. Use absolute directory overrides when running from different working directories. Local capability URLs are intended only for local development; never put these directories on an unauthenticated static file server.

For S3, configure distinct `S3_MEDIA_BUCKET` and `S3_PRIVATE_BUCKET`, `AWS_REGION` and `CDN_BASE_URL`. Use runtime IAM credentials. The server needs GetObject (including HEAD/copy source), PutObject (upload/copy target) and DeleteObject only on the intended prefixes. The image bucket can remain private behind the owner's CloudFront origin access policy. KYC/import prefixes must never be exposed through the public CDN. Browser POST uploads require owner-configured bucket CORS for approved application origins.

S3 targets write staging objects. The server promotes verified objects to separate immutable final keys and records delayed cleanup intents. Cleanup checks metadata before removing abandoned objects and retries failures. Provider failures must not switch the selected S3 adapter to local storage.

For a local S3-compatible emulator, run `TEST_S3_ENDPOINT=http://127.0.0.1:4566 pnpm test:storage`. This creates uniquely named test buckets and deletes its objects/buckets afterward; the script rejects non-loopback endpoints. The current session also exercised this flow with Moto 5.2.5. That emulator does not enforce conditional-copy preconditions; SDK contract assertions verify the requested condition, and live AWS semantics remain a separate activation check.

## Imports and inventory maintenance

Catalog import endpoints return a durable job ID. Read the job and its authenticated CSV report to distinguish validation errors, pending approval and a terminal retry failure. Dry runs do not change products, prices or stock. Real jobs resume their last committed batch after worker restart; repeated files with the same store/mode return the same job. Do not repair checkpoints or approval payloads with direct SQL.

Import, media cleanup, identity sync and inventory maintenance run only in `APP_ROLE=all|worker`. Multiple workers coordinate through database leases/locks and retained operation references. Shutdown drains active maintenance before closing database resources.

Inventory maintains held reservations, batches, immutable stock ledger and shortage obligations. Payment-confirmed reservations do not expire with payment holds. Quarantine/expiry may leave physical allocated stock with an explicit shortage obligation; do not free confirmed allocations or alter ledger rows by hand. The inventory-shortfalls consumer resolves the order/payment/fulfillment consequences through shared compensation.

Production migration rollback uses a reviewed forward migration. Development `migrate:down` is destructive and refuses `NODE_ENV=production`. No deployment, production database or cloud resources have been created by these local checks. Hosted CI, an actual container build and owner-credentialed AWS/CDN/Cognito/Ola activation are separately recorded in [PROGRESS.md](PROGRESS.md).


## Commerce recovery

Use the admin payment reconciliation read to inspect findings. Preserve UNKNOWN gateway operations and refunds: they reserve capacity until provider lookup produces a definitive result or an operator reviews the finding. Do not issue a second gateway create, clear the operation reference, or credit the wallet speculatively. Pending/ambiguous refunds are fenced before external I/O; exhausted automatic recovery records a finding.

Refund dispatch deliberately retains one database connection and a session advisory lock during its gateway request. Keep concurrent refund dispatches bounded by worker concurrency and comfortably below the database pool maximum; monitor waiting connections and provider latency before changing either limit.

Invoice rendering retries with backoff and suspends after five attempts without changing the issued number. Alert on `delivery_invoice_render_suspended > 0` and inspect `GET /v1/admin/invoices/render-failures`. After fixing the renderer or storage cause, an authorized administrator can call `POST /v1/admin/invoices/{id}/render-retry` with an `Idempotency-Key` header and a JSON `reason`; the retry is audited and does not issue a new invoice number. Workers lease each attempt for two minutes. When rolling out migrations 040–041, stop old invoice workers before starting the new worker version: older code does not respect render leases or suspension. Concurrent indexes 038 and 041 are created outside migration transactions; if creation fails, rerun the migration after checking database health and invalid indexes.

Apply migration 039 before deploying servers that use canonical idempotency hashes. The original request hash is retained for older servers. A key created before this migration can accept reordered JSON on new servers only after the original serialization has matched once and its canonical hash has been populated; old servers still require the original serialization during a mixed-version rollout. Clients should continue to retry with the same key and request body.

Refunds and supported order cancellation/expiry repairs use maker-checker approval. An administrator can hold or resume a `CONFIRMED`, `PICKING` or `PACKED` order before pickup, with a reason; the hold blocks picking, packing, handover, dispatch and pickup. Admin order detail shows the current hold; changes are recorded in order history and audit. Before-pickup cancellation returns any already picked, unreturned goods to quarantine in the cancellation transaction before releasing remaining obligations. QC approval/write-off is separate from receipt.

A delivery-code reset requires an active administrator, a reason, an `OUT_FOR_DELIVERY` order and an assigned rider with unreleased `PICKED_UP` or `ARRIVED` custody. It clears the attempt lock; the rider must still provide delivery proof. Manual assignment is limited to before pickup.

For a customer-unreachable failure, the assigned rider records contact attempts after arrival. The configured wait and minimum attempts must both be satisfied for the current rider and delivery attempt. For a wrong address, the rider flags the task and an administrator resolves the flag as a failure after the same checks; resolution is audited. After pickup, retain the rider and parcel custody until a full store return enters quarantine.

COD expected amount is independent of collected cash. After a picking short, collect the adjusted expectation shown on the task. A mismatch blocks completion; correcting the cash entry and recording a store deposit produce durable ledger records. Deposits cannot make held cash negative.

For fulfillment key rotation, add the new secret under its version in PICKING_CODE_KEYS_JSON and select PICKING_CODE_KEY_VERSION. Retain historical keys until all orders/verifiers referencing them have completed. Version 1 can use PICKING_HANDOVER_SECRET. Never rotate by deleting a key still referenced by active orders.

Working-tree migrations now include 026–028 for subscriptions, support/payouts and compliance. Migration 013 deliberately forbids down migration to preserve notification delivery history. Production corrections use reviewed forward migrations. The latest P10–P12 gate uses pinned PostGIS and Redis container images; earlier native-service results remain recorded separately in PROGRESS.md.

## Subscription, support and privacy recovery

P13 adds bounded connection acquisition (`DB_ACQUIRE_TIMEOUT_MS`), HTTP request/header receive deadlines, per-concern queue concurrency and outbox polling. Defaults are 5,000 ms for pool acquisition, 15,000/10,000 ms for request/headers, four jobs per concern and 500 ms polling. A timeout is a failed operation, not permission to retry an ambiguous external payment. Inspect metrics and durable status before replay. Socket caps are per process and require matching replica/ingress budgets.

The runtime SQL login is separate from the migration owner. After migrations, the owner runs `pnpm grant:runtime` with the migrator URL and pre-provisioned `RUNTIME_DATABASE_ROLE`; review the grants and test the actual application workflow before activation. Runtime must not own schema/functions or inherit elevated grants. Partition maintenance uses restricted SECURITY DEFINER functions whose search path and retention boundary are fixed by migration 029.

Subscription generation records per-date outcomes and retries the same insufficient-balance occurrence. Inspect the admin generation run and reason before retrying; terminal skips are not revived. Enable wallets before subscriptions. The seed supplies a subscribable variant and morning slots but does not enable either feature. Cutoff is 21:00 IST by default; morning pick/dispatch release times are independent of nighttime generation. Replay must not create a new wallet debit or order. A short subscription parcel is cancelled and compensated through the standard inventory/refund path.

Store-scoped generation claims at most 25 subscriptions in a short `SKIP LOCKED` transaction and then processes them with bounded concurrency. Claims expire after 120 seconds; a crashed worker's unprocessed claims become eligible again. Business transactions revalidate the lease token after taking the account and subscription locks. Let recovery reclaim expired work instead of clearing claims or changing occurrence state with SQL. Scheduled pricing and serviceability reads share that business transaction, so they do not require a second database connection.

Support recovery scans create deduplicated incident tickets and per-cycle SLA alerts. Reopening starts a new cycle. Customer/rider ticket responses must exclude internal notes and their attachments. Refund requests remain subject to current agent limits, source capacity and maker-checker. A manual refund is pending until a payment reference and private evidence are recorded.

Payout approval rechecks the draft against current COD dues. If deposits make it stale, cancel the draft and rebuild it before a new approval. Payout offsets reduce outstanding COD liability and are never recorded as store deposits. Approved amounts are immutable; use approved compensating correction records for later changes. A zero-net payout settles internally; positive amounts require actual manual payment evidence. No bank transfer is performed by this backend.

Export jobs write bounded private CSV attempts. Recover lost leases through the existing worker; failed attempts keep cleanup obligations rather than appending to a partially published file. Expired exports and orphan attempt objects are removed after their retention/lease boundary. Personal exports omit support internal notes. CSV text is quoted and formula-neutralized.

Erasure reports typed blockers and is retried after the underlying order, subscription, balance, custody, payout or legal hold is resolved. It never moves money to force eligibility. After local revocation, provider disable and object cleanup continue durably; the account cannot log back in or bootstrap from its old identity. Do not mark a request complete while cleanup is pending. Financial/legal records and compact dedupe references are retained by default. Privacy, tax and retention policy configuration still require owner review before production activation.

Completed idempotency keys, processed-event tombstones, gateway inbox entries and outbox history are retained for deduplication and financial traceability. Track their table and index sizes, disk growth, vacuum and backup duration, and set capacity alerts appropriate to the deployment. Any archive or removal policy requires compliance review and must preserve deduplication guarantees. For a size baseline, run `SELECT relname, pg_total_relation_size(relid) FROM pg_stat_user_tables WHERE relname IN ('idempotency_keys','processed_events','outbox_events','outbox_deliveries','gateway_event_inbox') ORDER BY 2 DESC;` on a monitoring connection.

Most Redis operations and queues use ioredis; the IAM cluster realtime adapter uses node-redis for sharded pub/sub and credential refresh. Monitor the two connection pools and their TLS/timeout settings independently. Event timestamps are not yet universally sourced from one clock: transaction-sensitive transitions should use PostgreSQL time sampled after locks; provider event timestamps retain provider meaning. Keep host and database clocks synchronized and account for skew when interpreting event age or ordering.

## Admin portal sessions (P14)

The admin web portal authenticates with server-side sessions. Configure `ADMIN_SESSION_KEYS_JSON` as a JSON object mapping key versions to base64-encoded 32-byte AES-256 secrets (required in production; the active `ADMIN_SESSION_KEY_VERSION` must exist in the ring), plus `ADMIN_SESSION_IDLE_SECONDS` (default 28800) and `ADMIN_SESSION_ABSOLUTE_SECONDS` (default 604800, the cookie Max-Age). Rotate keys by adding a new version to the ring, moving `ADMIN_SESSION_KEY_VERSION` and keeping the previous version until existing sessions re-seal on their next token refresh; then remove the old version after the absolute window has passed.

Sessions live in the `admin_sessions` table (migration 045): SHA-256 session-id hashes, sealed provider tokens, hashed CSRF tokens and idle/absolute deadlines. Stale rows are deleted opportunistically in bounded batches; `admin_sessions` is on the runtime grant's deletable list, so run `pnpm grant:runtime` after migrating production. The cookie is `admin_session` (host-only, HttpOnly, SameSite=Lax, Secure outside loopback HTTP development). Idle expiry slides on every cookie-authenticated request; absolute expiry forces re-login. Concurrent refreshes elect one winner atomically — the loser receives `SESSION_REPLACED` and re-logs in. Revoking a role blocks the very next request (403) because cookie sessions re-authorize on every call.

With `AUTH_PROVIDER=local`, local directory users sign in only after an operator sets their scrypt password: run `node --env-file-if-exists=.env --import tsx scripts/set-local-admin-password.ts <email> <newPassword>` (12+ characters with a letter and a digit; local development only — the script refuses production). Seed users first with `pnpm seed`, then issue portal logins through `POST /v1/admin/auth/login`. With `AUTH_PROVIDER=cognito`, the portal uses `ADMIN_USER_PASSWORD_AUTH`, `NEW_PASSWORD_REQUIRED` challenge completion and `ForgotPassword` flows against `COGNITO_ADMIN_CLIENT_ID` on the workforce pool; Cognito reuses the refresh token and the server rotates only its own session rows. Anonymous portal authentication routes are rate limited under the `admin-auth` route class using `RATE_LIMIT_AUTH_PER_MIN`. Never log session cookies, CSRF tokens or provider credentials; the auth endpoints answer generic problem codes by design (`INVALID_CREDENTIALS`, `INVALID_CHALLENGE`, `INVALID_RESET`, `SESSION_EXPIRED`, `SESSION_REPLACED`, `CSRF_TOKEN_INVALID`, `CONFLICTING_CREDENTIALS`).
