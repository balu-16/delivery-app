# Delivery platform progress

Updated: 6 November 2026.

## Current state

**P0–P4 are implemented and locally verified.** P3 catalog/search and P4 inventory each had one supervised GPT-6.1 Terra agent at xhigh reasoning. The parent reviewed contracts, corrected integration issues, completed shared API/wiring/seed work, cleaned unused code and ran the combined acceptance checks. P5–P13 remain planned.

The original [master specification](../delivery-platform-agent-prompt.md) is unchanged. [Architecture](ARCHITECTURE.md), [domain rules](DOMAIN.md), [API conventions](API.md), [runbook](RUNBOOK.md), [edge-case evidence](EDGE_CASES.md), [implementation plan](IMPLEMENTATION_PLAN.md) and [manifests](manifests/README.md) describe current scope and later dependencies. Source is recorded in the local implementation commit on `main`; no remote or deployment is configured.

Full production activation remains separate: no Docker daemon is available for a container build, no hosted CI run occurred, and no owner-credentialed AWS/CDN/Cognito/Ola acceptance was performed. Real S3 adapter code, signing/transport contracts and local emulator coverage are implemented; those checks do not prove owner-resource configuration.

## Phase acceptance

| Phase | State | Evidence and remaining boundary |
|---|---|---|
| P0 Foundation | Implemented; local acceptance passed | Six runtime roles, real readiness, outbox/consumer recovery, queue retry/DLQ, idempotency fencing, shutdown drain, migrations and seed replay. Docker/hosted CI remain external. |
| P1 Identity and surfaces | Implemented; local acceptance passed | Local/Cognito token contracts, current account/role permissions, durable provisioning/compensation, audit/config/maker-checker and local/S3 private KYC contracts. Live Cognito/S3 activation remains external. Erasure execution is P12; rider task/availability effects are P8. |
| P2 Stores and serviceability | Implemented; local acceptance passed | Entity/store/zone administration, schedules/staff/capacity, owned addresses, PostGIS boundaries/overlaps, default/capacity races, maps degradation and Ola fixtures. Live Ola remains external; order/task integration belongs to P6/P8. |
| P3 Catalog and search | Implemented; local acceptance passed | Catalog CRUD/soft deletion, unique SKU/barcode, guarded publication/history/outbox, temporal prices and distinct-checker approvals; store-scoped search/synonyms/ranking, bounded keyset pages, ETags and revision/time-aware suggestions; immutable local/S3 media, KYC completion and cleanup; streaming validated CSV, BullMQ dispatch with DB recovery, dry-run/replay/checkpoints/approval and persisted private reports. AWS conditional-copy/CDN activation remains external. |
| P4 Inventory | Implemented; local acceptance passed | Receipt/batch/immutable-ledger stock, FEFO/target shelf life, atomic multi-line reservations, held/committed/resolved lifecycle, expiry and release/pick races; scoped manual/count approvals and small-pool claims; quality/quarantine, bounded QC returns, category policies, reports/ledger, alerts and shortage obligations. Real order/payment/fulfillment compensation integrates in P6/P7. |
| P5 Cart, pricing and coupons | Not started | Quote/version gates, exact totals/allocation properties, cart and coupon concurrency. |
| P6 Commerce and money | Not started | Wallet, checkout, orders, payments, refunds, invoices and reconciliation. |
| P7 Store operations | Implemented; real-database acceptance pending services | Pick-task creation from `ORDER_CONFIRMED` (idempotent consumer, one active task per order), SKIP-LOCKED claim/start/reassign with preserved progress, barcode/quantity/batch validation, FEFO suggestions, shorts and substitutions (atomic reservation swap, charge never above original), completion consuming stock through P4 contracts, packing records, HMAC handover verification with lockout/audited override, SLA breaches and backlog auto-pause signals, store surface for all 15 manifest operations. Money-touching paths (order transitions, short refunds, all-short cancel, store order reads) call consumer-defined P6 ports and fail closed (typed 503) until P6 binds real implementations ([ADR 0010](DECISIONS/0010-p7-picking-and-p6-integration-ports.md)); integration/concurrency suites are written and run with the combined P6 acceptance. |
| P8 Last mile | Not started | Rider availability, dispatch/custody, GPS/sockets, delivery, COD and earnings. |
| P9 Notifications | Not started | Actual channel delivery, dedupe, inbox/preferences/locale and failure handling. |
| P10 Subscriptions | Not started | Calendar/cutoff, dated occurrences, generation and recovery. |
| P11 Support, ratings and payouts | Not started | Tickets, ratings, approvals and payout allocation. |
| P12 Admin completeness | Not started | Full reports/ops/repair, exports and cross-domain erasure execution. |
| P13 Hardening | Not started | Whole-project edge-case/security/load/resilience audit and handoff. |

## Consolidated verification

The final combined run used Node **26.13.0**, pnpm **12.18.0**, PostgreSQL **16.15**, PostGIS **3.4.2** and Redis **7.0.15**. Each I/O suite isolated its real database and Redis namespace. Moto **5.2.5** supplied a separate loopback S3-compatible HTTP endpoint. Pinned Docker/Testcontainers images are an unexecuted container path in this environment.

| Check | Actual result |
|---|---|
| `pnpm lint` | ESLint, boundaries for **183 source files**, and six manifest validators passed. |
| `pnpm typecheck` | Passed strict TypeScript checks. |
| `pnpm format:check` | Passed source/tests/tooling/configuration/manifest formatting. |
| `pnpm test:coverage --coverageReporters=text --coverageReporters=json-summary --json --outputFile=artifacts/p3-p4-final-tests.json` | **146 tests passed in 43 suites**, across unit/integration/concurrency/e2e; zero failures or skips. Includes migration upgrade/rollback and actual HTTP checks. |
| Domain/application line coverage | **98.57% domain (138/140)** and **100% application (39/39)**; combined **98.88% (177/179)**. Threshold is 85% independently per group. These numbers measure the current domain/application files, not all SQL infrastructure, adapters or controllers. |
| `pnpm openapi:export` | Clean build passed and four OpenAPI 3.1 documents validated: customer **19**, rider **4**, store **10**, admin **72** operations. |
| Manifest comparison after export | Exact implemented route set passed: **105 implemented**, **136 planned** future operations. Permissions derive from actual route metadata, with additional store/approval policy documented. |
| Dependency audit at high severity | Passed: **zero high/critical** issues. One low and two moderate transitive advisories remain; no breaking overrides were added to suppress them. |
| Frozen production-only dependency install | Passed with the expanded S3/CSV dependencies and no development packages. |
| Production-only runtime/migration smoke | All **five** native Node SQL migrations, repeat-up no-op, production down rejection, and **all six roles** with actual PostgreSQL/Redis readiness passed. |
| S3 emulator HTTP smoke | Passed constrained presigned multipart POST, HEAD, cross-bucket promotion, staging overwrite isolation, signed GET and object/bucket cleanup. SDK tests assert CopySourceIfMatch; Moto does **not** enforce that condition. |
| `docker compose config --quiet` | Passed static Compose validation. |
| Docker build / hosted CI / credentialed providers | **Not run.** No Docker socket/daemon, Git remote or owner provider resources are available. |

Generated evidence is under ignored `artifacts/`, `coverage/` and `openapi/`. CI runs lint/format/typecheck, all four test projects with coverage/migrations, audit, build/OpenAPI comparison, LocalStack storage smoke and Docker build, retaining logs and API artifacts. Workflow configuration is not a hosted CI pass.

## P3 and P4 evidence highlights

- Catalog tests traverse **205 products across six pages**, test scoped search/suggestion cursors, ranking, synonyms in longer queries, stock placement and time-driven cache expiry. HTTP tests cover invalid publication/media/prices/approvals, duplicate SKU, ownership, strict DTOs and ETag responses. Publication rollback leaves state/history/event unchanged.
- Imports validate UTF-8/BOM, headers, duplicate identifiers, allowed GST, categories, limits and prices before writes. Tests cover dry-run isolation, cross-admin replay, published SKU updates, lost worker lease, checkpoint restart, expired approval replacement, BullMQ enqueue outage/recovery and durable private report write/retry.
- Media tests exercise real metadata transactions with controlled S3 transport/signing, immutable final keys, owner/purpose/type/size/image validation, cleanup claim fencing, ambiguous outcomes and provider retry. Generic storage also has actual emulator HTTP coverage; no live AWS acceptance is claimed.
- The required **100 simultaneous reservations against ten units produce exactly ten successes**, with stock/batch/ledger reconciliation. Other tests cover all-line rollback, opposite lock order, target-time FEFO, committed-stock expiry protection, release/pick/expiry races, quality shortages, bounded QC returns, scoped replay/version checks and twenty count requests on a **two-connection pool**.
- The local journey seeds 200 products/variants and 600 prices/assortment rows. First-store stock comes through **200 idempotent receipts/batches/ledger entries totaling 4,000 units**; the other 400 assortment rows remain zero. Seed replay preserves quantities. HTTP checks load the actual image, browse eligible stock, verify exact-count privacy and deny unauthenticated access across all 105 documented operations.

## Cleanup and decisions

- Removed unused audit wrappers/dependencies from P0–P2, temporary P3 module re-export files, the no-op import-worker stop method and empty application/test folders. Preserved real contracts, tests, source specifications and useful documentation.
- Consolidated P3/P4 expected HTTP/SQL failure translation into one shared interceptor instead of per-controller catch blocks. Added inventory response/error/idempotency schemas and current permission metadata. Runtime/API generation share audience composition.
- Stock/count keys are scoped to actor/store/operation. A short immutable count claim prevents nested-transaction pool exhaustion and freezes direct-versus-approval decisions. Approvals replay their original result and reject changed input; stock writes never bypass current permissions.
- Customer catalog and inventory lists now use bounded scoped opaque keyset cursors. Pages reflect live catalog changes between requests; they are not frozen search snapshots. Suggestion cache keys and ETags include page scope and preserve scheduled time boundaries.
- Storage registration/persisted-report writes fence active cleanup; staging replacement cannot overwrite a final object. Local filesystem deletion ignores missing files while retaining genuine failures for retry. S3 selection never falls back to local storage.
- New migrations **004** and **005** preserve the accepted P0–P2 migrations. Their compatible availability view upgrades/downgrades correctly. Every source TypeScript file remains at or below 300 lines; formatting, native lockfile handling and clean compiler output prevent redundant artifacts.

[ADR 0005](DECISIONS/0005-catalog-media-and-imports.md) records immediate/delayed price activation, cross-admin file dedupe and storage/import design. [ADR 0006](DECISIONS/0006-stock-units-reservations-and-expiry.md) records base units, lock order, QC/shortage policy and minute-level maintenance. Stock approval through an admin route additionally requires a current assigned store-manager role and a checker different from the maker.

## Remaining activation and next phase

Run hosted CI and the actual image/Compose path with Docker available. Before enabling real providers, validate owner-created Cognito pools/clients/groups/alias mode, Ola credentials, distinct S3 buckets, runtime IAM, browser upload CORS, CloudFront origin access and conditional-copy behavior. No cloud resources were created during implementation.

**P7 store fulfillment is implemented in this working tree** (module `src/modules/picking`, migration `008_p7_store_fulfillment.sql`, store surface `src/surfaces/store/picking`), built in parallel with P5/P6 sessions. Its dependency assumptions and fail-closed integration ports are recorded in [ADR 0010](DECISIONS/0010-p7-picking-and-p6-integration-ports.md); unit tests pass, and the real-database integration/concurrency suites run with the combined P5/P6 acceptance once services and the shared build are available. P6 must add real order references and bind the P7 ports (order transitions, short settlement, system cancellation, store order reads); P9 delivers the persisted stock/SLA alerts. All 52 source cases, 24 additional cases and ten system invariants remain tracked; compound later-phase requirements and unmeasured load/performance budgets are not declared complete by this local phase gate.
