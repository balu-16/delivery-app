# Delivery platform progress

Updated: 8 November 2026.

## Current state

**P0–P12 implementations are integrated and have passed local phase acceptance in this working tree.** Purchasing, fulfillment/custody, money recovery, invoices and notifications now connect to subscriptions, support, ratings, payout records and compliance operations. The P10–P12 work used GPT-6.1 Terra high subagents, with at most three active, and main-agent integration/review. P13 remains planned. The local gate below is separate from credentialed provider activation and whole-project load/security acceptance.

The original [master specification](../delivery-platform-agent-prompt.md) is unchanged. [Architecture](ARCHITECTURE.md), [domain rules](DOMAIN.md), [API conventions](API.md), [runbook](RUNBOOK.md), [edge-case evidence](EDGE_CASES.md), [implementation plan](IMPLEMENTATION_PLAN.md) and [manifests](manifests/README.md) describe current scope and later dependencies. The current repair is uncommitted working-tree work; no deployment was performed.

Full production activation remains separate. Docker is available for the latest P10–P12 verification using pinned PostGIS and Redis images; the application image, hosted CI and owner-credentialed AWS/CDN/Cognito/Ola acceptance are separate checks. Real S3 adapter code, signing/transport contracts and local emulator coverage do not prove owner-resource configuration.

## Phase acceptance

| Phase | State | Evidence and remaining boundary |
|---|---|---|
| P0 Foundation | Implemented; local acceptance passed | Six runtime roles, real readiness, outbox/consumer recovery, queue retry/DLQ, idempotency fencing, shutdown drain, migrations and seed replay. Docker/hosted CI remain external. |
| P1 Identity and surfaces | Implemented; local acceptance passed | Local/Cognito token contracts, current account/role permissions, durable provisioning/compensation, audit/config/maker-checker and local/S3 private KYC contracts. Live Cognito/S3 activation remains external. Erasure execution is P12; rider task/availability effects are P8. |
| P2 Stores and serviceability | Implemented; local acceptance passed | Entity/store/zone administration, schedules/staff/capacity, owned addresses, PostGIS boundaries/overlaps, default/capacity races, maps degradation and Ola fixtures. Live Ola remains external; order/task integration belongs to P6/P8. |
| P3 Catalog and search | Implemented; local acceptance passed | Catalog CRUD/soft deletion, unique SKU/barcode, guarded publication/history/outbox, temporal prices and distinct-checker approvals; store-scoped search/synonyms/ranking, bounded keyset pages, ETags and revision/time-aware suggestions; immutable local/S3 media, KYC completion and cleanup; streaming validated CSV, BullMQ dispatch with DB recovery, dry-run/replay/checkpoints/approval and persisted private reports. AWS conditional-copy/CDN activation remains external. |
| P4 Inventory | Implemented; local acceptance passed | Receipt/batch/ledger accounting, FEFO, selected-batch consumption, archived reservation generations, expiry/quality shortfall obligations and real compensation; quarantine/QC returns, concurrency and bounded adjustments. |
| P5 Cart, pricing and coupons | Implemented; local acceptance passed | Transactional quote/cart/price/coupon/configuration revalidation, scoped and excluded-line discounts, promo-cap rounding, exact pricing and coupon quota races. |
| P6 Commerce and money | Implemented; local acceptance passed | Frozen orders, wallet buckets/lots/reversal provenance, one order per intent, verified captures, customer retry/verification, source-capped refunds and recovery, cancellation/expiry/reinstatement, address/reorder, invoice/credit-note issuance and maker-checker admin repairs. Provider tests use fixtures. |
| P7 Store operations | Implemented; local acceptance passed | Real order bindings, claim/start/reassign, bins, selected batches, partial/all shorts, substitution charge/tax snapshots, weighted tolerance, packing/handover with key rotation, disconnect recovery and anomaly alerts. |
| P8 Last mile | Implemented; local acceptance passed | Rider shifts/breaks, GEO candidates and bounded scoring, offers/manual assignment, custody/returns, private POD, code locks/reset, adjusted COD expectations/deposits, configured earnings, GPS and cross-instance realtime. |
| P9 Notifications | Implemented; local acceptance passed | Canonical producer events, leases and per-device outcomes, owner-fenced invalidation, retries, localized inbox/pagination and promotional quiet hours/preferences. Provider ambiguity remains at-least-once delivery. |
| P10 Subscriptions | Implemented; local acceptance passed | Scheduled wallet checkout, effective schedules/addresses, cutoff races, leased store-scoped generation/recovery, full short compensation and slot-based fulfillment. Ten-store 10,000-order load/replay passed; single-wallet throughput after fixes remains unmeasured. |
| P11 Support, ratings and payouts | Implemented; local acceptance passed | Scoped tickets/private attachments/internal notes, SLA/reopen recovery, delivered-only ratings, source-capped support refunds, payout allocations/COD offsets, approved corrections and evidence-backed manual settlement. Bank transfers remain outside scope. |
| P12 Admin completeness | Implemented; local acceptance passed | Audited admin review/replay, private bounded reports/exports, all-account erasure with current obligations/holds, provider/media/tracking cleanup recovery, retention and exact route/permission audit. Live cloud activation remains separate. |
| P13 Hardening | In progress; acceptance pending | Error-contract/log privacy fixes, bounded runtime settings, worker/Redis recovery, restricted partition maintenance, container rehearsal, behavioral security inventory and local/staging load harnesses. Final full gates, per-operation criteria and measured local profiles remain open. |

## P13 implementation and open acceptance

[ADR 0014](DECISIONS/0014-p13-local-and-staging-acceptance.md) records the owner's choice of local hardening/smoke acceptance with full-scale staging handoff. Three GPT-6.1 Terra high agents implement security, runtime and load tooling; the main agent integrates and verifies. Existing source specifications and working-tree changes are preserved. No Git commit, deployment or cloud resource creation has been performed.

The first Docker rehearsal built the pinned application image and passed live readiness, audience isolation, non-root/read-only execution, development seed replay and graceful shutdown for all six roles. It used task-owned PostGIS/Redis containers and a named media volume; earlier startup/file-sharing failures remain recorded. The source continued changing afterward, so a final image rebuild/rehearsal is required.

Runtime regression evidence includes bounded pool acquisition, terminated active database transactions, killed producer and worker processes, rollback of uncommitted effects, duplicate suppression after a committed effect, and actual disposable Redis process restart with lost queue contents recovered from PostgreSQL. Forced worker recovery currently uses explicit replay rather than waiting for BullMQ's stalled-job timeout. Runtime-role tests deny public-schema/TEMP DDL and immutable ledger deletion and exercise an idempotent wallet credit. The grant script still gives broad application SELECT/INSERT/UPDATE permissions; it is not a per-module SQL access model.

The security inventory at `test/security/operation-cases.json` distinguishes authentication, authorization, validation and replay. All 315 guarded routes have an actual bearer/auth-audience rejection sweep; the public webhook uses its signed contract. Operation-specific criteria remain partially mapped or unassessed and must not be treated as full acceptance. `scripts/verify-p13-evidence.mjs --results <jest-json> --strict` fails when criteria are incomplete or named cases did not pass.

The initial combined P13 run passed 533 tests and failed one 300 ms Razorpay fixture request under competing test activity. Its logs/JSON remain under `artifacts/p13-acceptance/initial-*`; it is a failed run. A short orchestrated load rehearsal passed all generator steps and wallet/stock reconciliation. Full local five-minute profiles, the ledger-backed 10,000-subscription run and final serial regression remain pending. Historical P10–P12 subscription timings use directly constructed opening balances; P13 adds domain-backed opening credits/receipts and ledger reconciliation.

The first five-minute catalog/search run passed with p95 **40.13/32.13 ms** and no unexpected errors. The first distributed checkout run failed: **118/600 confirmed**, despite p95 **282 ms**. Preserve that result in `artifacts/p13-acceptance/local-load/`. Subsequent diagnostics found inventory-driven quote invalidation and nested pool acquisition during ordinary checkout. Migration 030 and transaction propagation fix those issues; focused regression verifies unchanged-price quotes survive reservations, actual price/tax/publication changes invalidate, real exhaustion rolls back, and two placements work through an application pool of one. The payload/authentication Razorpay fixture now uses a two-second fixture deadline; its dedicated timeout test keeps its explicit deadline, and load latency gates are unchanged.

The post-fix 10/s diagnostics passed both 150-order bursts. Observing a real maintenance tick confirmed the default backlog pause and the declared checkout-only fixture threshold behavior. A new complete local run is active under `artifacts/p13-acceptance/local-load-fixed/`, with resource monitoring; it is not a completed acceptance claim. Two customer instances also passed actual order-room ownership, reconnect snapshots matching HTTP and terminal location/room revocation. New payout, wallet, rider and same-key checkout races passed focused barrier tests. Remaining per-operation criteria and source cases stay open in their evidence inventories.

[Realtime contracts](REALTIME.md), [handoff requirements](HANDOFF.md) and the load README document current behavior and external boundaries. Full-scale staging (100 stores ×20,000 eligible SKUs), owner-credentialed providers, backup/restore rehearsal and actual hosted CI remain external acceptance steps. CI configuration and local emulator/fixture results are not claims those steps ran.

## P10–P12 integrated verification

The final verification on 8 November 2026 uses Node **26.13.0**, pnpm **12.18.0**, and the repository's pinned Docker image digests: PostgreSQL **16.15** with PostGIS **3.6.4**, and Redis **7.4.12**. Each I/O suite has its own database and Redis namespace. Docker reports **12 CPUs and 3,923,619,840 bytes** of memory. The original hotspot measurement overlapped the normal suite; the final distributed run had only a brief overlap with an already-running focused cutoff test at startup, followed by no competing test suite.

| Check | Actual result |
|---|---|
| Full unit/integration/concurrency/e2e coverage run | **514 tests passed across 103 suites**, zero failures, in **328.788 seconds**. Three opt-in load tests in two suites are excluded from this ordinary run; their separate outcomes are recorded below. |
| Coverage scope | **95.85% lines (739/771)** across selected domain/application files: domain **95.63% (700/732)**, application **100% (39/39)**. All configured 85% line thresholds pass. These figures exclude SQL infrastructure, adapters and controllers. |
| Static checks and build | Frozen offline install, TypeScript, ESLint, architectural boundaries, six manifest validators, formatting and clean compiler build passed. |
| API export and permission audit | OpenAPI 3.1 validates **81 customer, 43 rider, 38 store and 154 admin operations**. All **316** manifest operations match exports: 315 decorated runtime routes and one raw payment webhook. The wallet approval operation is documented and explicitly restricted to SUPER_ADMIN. |
| Runtime and migrations | All six application roles pass live readiness, route isolation and shutdown. Empty/latest and populated migration upgrade/round-trip checks pass, including 026–028 and the deliberate 013 downgrade prohibition. |
| Distributed subscription batch | **10,000 wallet-funded orders across ten stores and ten wallets passed in 488.238 seconds** (488.567 seconds including process overhead), within the 900-second generation budget. The application-owned worker and shared connection pool created exactly 10,000 dated occurrences, orders, wallet debits, reserved units and capacity claims; replay added none. |
| Earlier hotspot and holiday measurements | The one-store/one-wallet funded case **failed its 950-second Jest timeout** while the normal suite was running; this is retained as a failed measurement, not replaced by the distributed pass. The separate 10,000-holiday-outcome case passed in **161.650 seconds**. Hotspot throughput after the fixes is unmeasured. |
| Dependency audit | High-severity gate passed; **one low and two moderate** advisories remain. |

Detailed logs, JSON results, coverage, route policies, environment metadata and API documents are retained under ignored `artifacts/p10-p12-final-acceptance/`. Opt-in loads run separately: `distributed-load.json` and `distributed-load-exit.json` record the final distributed pass; `load-contention-baseline.json`, `.log` and `-exit.json` preserve the original hotspot failure and holiday result. The ordinary suite's skipped load cases are not represented as executed by that command.

The two test containers created for this acceptance run were stopped after verification. Existing project work and source specifications were preserved.

The implementation used three GPT-6.1 Terra high phase agents plus main-agent integration, followed by at most three Terra high agents for generation and shared-contract fixes. [ADR 0013](DECISIONS/0013-p10-p12-contracts-and-policies.md) records selected policies and [EDGE_CASES.md](EDGE_CASES.md) links concrete assertions. P13 whole-project hardening, application-image validation, hosted CI and credentialed cloud activation remain separate; no deployment or Git commit was performed.

## P4–P9 repair verification

The final local repair run used Node **26.13.0**, pnpm **12.18.0**, native PostgreSQL **16.15**, PostGIS **3.4.2** and Redis **7.0.15**. Tests used isolated databases and Redis namespaces on these services. The pinned Docker/Testcontainers path was not run in this environment.

| Check | Actual result |
|---|---|
| Four-project Jest run with coverage | **87 suites and 456 tests passed**, zero failures or skips, across unit, integration, concurrency and e2e. |
| Coverage scope | **96.36% lines (689/715)** across the domain and application files selected in `jest.config.cjs`: domain **96.15% (650/676)**, application **100% (39/39)**. Each group exceeds its 85% threshold. These figures do not cover the SQL infrastructure, adapters or controllers. |
| `pnpm lint`, `pnpm format:check`, `pnpm typecheck` | Passed. Lint checked boundaries for **421** source files and validated **6** manifests with **263** operation records. |
| `pnpm install --frozen-lockfile --offline` | Passed with the existing local dependency store. |
| `pnpm audit --audit-level high` | Passed; **1 low and 2 moderate** advisories remain. |
| OpenAPI export and comparison | Fresh validated documents contain **54 customer, 35 rider, 38 store and 99 admin** operations; manifest validation passed. |
| Six application roles | The [real-roles integration suite](../test/integration/runtime/real-roles.spec.ts) booted all, customer, rider, store, admin and worker with live readiness probes and closed each application; route isolation and audience documents were also checked. |

The ignored `artifacts/p4-p9-final-acceptance/` directory contains the Jest JSON and log, coverage JSON, static-check/install/audit logs and the four generated OpenAPI documents. The run includes [commerce journeys](../test/integration/commerce/journeys.spec.ts), [refund dispatch fencing](../test/integration/payments/refund-fencing.spec.ts), [populated repair migrations](../test/integration/platform/migration-integrity.spec.ts) and [worker-to-audience broadcasts](../test/integration/realtime/worker-broadcast.spec.ts). This local evidence does not establish hosted CI, container or credentialed provider acceptance.

## Earlier P0–P4 verification

The earlier P0–P4 combined run used Node **26.13.0**, pnpm **12.18.0**, PostgreSQL **16.15**, PostGIS **3.4.2** and Redis **7.0.15**. Each I/O suite isolated its real database and Redis namespace. Moto **5.2.5** supplied a separate loopback S3-compatible HTTP endpoint. Pinned Docker/Testcontainers images are an unexecuted container path in this environment.

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
- At the P3–P4 gate, migrations **004** and **005** preserved the accepted P0–P2 migrations and their compatible availability view upgraded and downgraded correctly. The source-file size observation at that gate does not describe the later P4–P9 repair.

[ADR 0005](DECISIONS/0005-catalog-media-and-imports.md) records immediate/delayed price activation, cross-admin file dedupe and storage/import design. [ADR 0006](DECISIONS/0006-stock-units-reservations-and-expiry.md) records base units, lock order, QC/shortage policy and minute-level maintenance. Stock approval through an admin route additionally requires a current assigned store-manager role and a checker different from the maker.

## Remaining activation and next phase

Run hosted CI and the actual image/Compose path with Docker available. Before enabling real providers, validate owner-created Cognito pools/clients/groups/alias mode, Ola credentials, distinct S3 buckets, runtime IAM, browser upload CORS, CloudFront origin access and conditional-copy behavior. No cloud resources were created during implementation.

The temporary P6 integration stand-ins described in ADRs 0010 and 0011 have been removed. [ADR 0012](DECISIONS/0012-p4-p9-integrity-and-recovery.md) records the final bindings, recovery policies and local evidence. The 52 source cases, 24 additional cases and ten system invariants remain tracked; compound later-phase requirements and unmeasured load budgets are not declared complete by this local gate.
