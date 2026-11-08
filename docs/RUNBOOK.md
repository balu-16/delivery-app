# Local operations and P3–P4 activation notes

## Start and verify

Follow [README.md](../README.md) for the pinned Node/pnpm toolchain and local PostGIS/Redis/LocalStack/Mailpit setup. Run migrations before starting any role. Seeds are local-only, repeatable and preserve edited records. Catalog assortment starts at zero; the inventory seed uses the same receipt/ledger service as normal stock intake.

`/healthz` is process liveness. `/readyz` checks configured dependencies. `/metrics` requires the configured bearer secret and is unavailable when the secret is empty. Logs use request IDs and sanitized errors; do not put tokens, private URLs, KYC bytes or CSV bodies into log messages.

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
