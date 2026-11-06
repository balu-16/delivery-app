# Delivery platform progress

Updated: 6 November 2026.

## Current state

The three current implementation assignments—foundation, identity and stores/serviceability—are implemented, cleaned up and locally verified. They are numbered **P0, P1 and P2** in the source plan. **P3 catalog/search is not implemented.** Three GPT-6.1 Terra agents at xhigh reasoning each owned one different phase; the parent reviewed shared contracts, corrected integration findings and ran the combined acceptance checks independently.

Local acceptance is green. Full production activation is not signed off: no Docker daemon is available for an image build, no hosted CI run has occurred, and no credentialed Cognito or Ola acceptance was performed. Production S3/private media is assigned to P3. These limits do not count as passing checks.

The original [master specification](../delivery-platform-agent-prompt.md) is intact. The [implementation plan](IMPLEMENTATION_PLAN.md), [edge-case register](EDGE_CASES.md), [architecture](ARCHITECTURE.md), [API conventions](API.md) and [manifests](manifests/README.md) distinguish current code from the remaining P3–P13 scope. Git is initialized on `main`; source is recorded in the local implementation commit. No remote is configured or deployment performed.

## Phase acceptance

| Phase | Current state | Evidence and remaining boundary |
|---|---|---|
| P0 Foundation | Implemented; local acceptance passed | All six roles boot with actual dependency probes; transaction/outbox rollback, publish/ack crash, lost Redis jobs, independent consumer obligations, shutdown drain, queue retry/DLQ, idempotency fencing, migration upgrade/rollback and seed replay tests pass. Image build and hosted CI remain unverified. Socket loading belongs to P8. |
| P1 Identity and surfaces | Implemented; local acceptance passed | Local identity and Cognito contract fixtures; audience/client/token/role rules; authoritative account revocation; durable provisioning/synchronization/compensation; append-only audit; typed config/flags; maker-checker; local private KYC capabilities. Live Cognito and production private storage acceptance remain open. Erasure execution is P12; rider availability/task effects are P8. |
| P2 Stores and serviceability | Implemented; local acceptance passed | Entity/city/store/zone administration, schedules/holidays/staff, bounded pagination, PostGIS boundary/priority/version checks, capacity/default-address races, store-signal auto-pause, maps degradation and documented Ola adapter fixtures. Live Ola acceptance remains open. Orders retain snapshots in P6; task contact endpoints integrate the current policy in P8. |
| P3 Catalog and search | Not started | Catalog, search ranking/synonyms, general/private S3 storage, CSV import and zero-stock assortment bridge. |
| P4 Inventory | Not started | Batch/ledger/FEFO, reservations, expiry and 100-way reservation acceptance. |
| P5 Cart, pricing and coupons | Not started | Quote/version gates, totals property tests and 50-way coupon acceptance. |
| P6 Commerce and money | Not started | Wallet, checkout, payments, orders, refunds, invoicing and reconciliation. |
| P7 Store operations | Not started | Picking, substitution, packing, QC, handover and money integration. |
| P8 Last mile | Not started | Rider availability, assignment/custody, GPS/sockets, delivery, COD and earnings. |
| P9 Notifications | Not started | Recipient/channel dedupe, email/push/in-app, locale/preferences and failure handling. |
| P10 Subscriptions | Not started | Calendar/cutoff, dated occurrences, generation and retry recovery. |
| P11 Support, ratings and payouts | Not started | Scoped tickets, ratings, approvals and payout allocation. |
| P12 Admin completeness | Not started | Full permissions/reports/ops, data export and cross-domain erasure execution. |
| P13 Hardening | Not started | Complete edge-case/security/load/resilience audit, runbooks and final handoff. |

## Consolidated verification

The final combined run used Node **26.13.0**, pnpm **12.18.0**, PostgreSQL **16.15** with PostGIS **3.4.2**, and Redis **7.0.15**. Real services ran on temporary loopback endpoints; each test isolated its database and Redis namespace. The pinned Compose/Testcontainers images remain a separate, unexecuted container path in this environment.

| Check | Actual result |
|---|---|
| `pnpm lint` | Passed ESLint, boundaries for 109 source files, and six manifest validators. |
| `pnpm typecheck` | Passed strict TypeScript checks. |
| `pnpm format:check` | Passed for source/tests/tooling/configuration/manifests. |
| `pnpm test:coverage --coverageReporters=text --coverageReporters=json-summary --json --outputFile=artifacts/tests-wrapup.json` | **98 tests passed in 33 suites**, across unit/integration/concurrency/e2e projects; zero failed or skipped tests. Includes populated migration upgrade/development rollback checks. |
| Domain/application line coverage | **97.01% domain (65/67)** and **100% application (39/39)**; combined **98.11% (104/106)**. The threshold is 85% independently for each group. This measures the eight current domain/application files, not all infrastructure, adapters or controllers. |
| `pnpm openapi:export` | Clean build passed; Swagger Parser validated four native OpenAPI 3.1 documents: customer 14, rider 4, store 2, admin 34 operations. |
| `node scripts/verify-manifests.mjs` after export | Passed exact implemented route comparison: 54 implemented and 179 explicitly planned future operations. Permissions were corrected from actual Nest route metadata during review. |
| `pnpm audit --audit-level high --json` | Passed: zero high/critical vulnerabilities. One low and two moderate advisories remain; the high-severity Zod issue was removed by upgrading to 4.6.7. |
| Production dependency smoke | Frozen production-only install passed. Compiled code imports and all four audience surfaces boot with only production dependencies. |
| Native production migration CLI smoke | Passed three SQL migrations, replay as a no-op, and rejection of `--down` in production, against an isolated real database without `tsx` or development dependencies. |
| `docker compose config --quiet` | Passed static Compose validation. |
| Docker image build / hosted CI / live providers | **Not run.** Docker socket/daemon is absent; no Git remote or provider credentials were supplied. |

Generated logs/reports are under ignored `artifacts/`, coverage summaries under `coverage/`, and validated audience contracts under `openapi/`. CI reproduces lint/format/typecheck, all four test projects with coverage and migration checks, dependency audit, build/OpenAPI comparison and Docker build, retaining its logs and API artifacts. Workflow configuration is not a successful hosted run.

The end-to-end tests cover the current customer bootstrap/profile/address/serviceability journey, staff assignment/administrative access, strict DTOs and authentication denial across all 54 routes. P1's explicit permission matrix covers missing tokens, wrong pools and wrong workforce roles across its 22 protected operations. This does not claim every future resource or every permitted-role response is already covered.

## Cleanup and review fixes

- Removed unused `uuid`, `@fastify/helmet`, `@nestjs/testing` and `@jest/globals` dependencies, unused audit wrappers and duplicate surface registries. Native cryptography supplies UUIDv7; synchronous transactional audit writes remain in use.
- Replaced custom OpenAPI schema traversal with native Swagger 3.1 support. Runtime routing and API export share the same audience composition registry. Removed the duplicate Fastify error handler after verifying Nest already maps parser failures to the global problem envelope.
- Removed a duplicated controller role check while retaining route guards and transactional SQL authorization. Corrected manifest permission/phase/rate-limit metadata and removed invented CRUD aliases for already implemented operations; required future operations remain planned.
- Consolidated CI into one run of all four test projects with coverage and migration checks; removed repeated boundary/manifest/build invocations. Builds clean stale compiler output. Production installs do not depend on Git hooks or development packages.
- Fixed in-flight outbox shutdown, provider synchronization/compensation recovery, role revocation/store assignment cleanup, concurrent rider review, updated capacity buckets and the Ola reverse-geocoding response envelope.
- Preserved stable problem codes without exposing vendor/SQL/request secrets; unexpected server failures now produce sanitized correlation logs. Added bounded latency metrics and redaction checks.
- Updated the quickstart, module READMEs, decisions, operation/env/adapter/event manifests and linked edge-case evidence. No source TypeScript file exceeds 300 lines. Local credentials, generated output and machine-specific agent metadata are excluded from Git.

## Remaining acceptance and next phase

Run the existing CI/container path when a Docker daemon and repository remote are available. Validate owner-created Cognito pools/app clients/groups/username aliases and Ola credentials before enabling those providers. Fixtures use real verification/parsing code with generated tokens and published provider envelopes; they are not captured live acceptance responses. Do not silently substitute local storage when production S3 is selected.

P3 is the next implementation phase. It must complete storage/media alongside catalog/search/imports and preserve the existing P0–P2 checks. Continue tracking all 52 source edge cases, 24 additional cases and ten system invariants without claiming later commerce, delivery or subscription behavior from foundation tests. Performance/load budgets and whole-project completion remain unmeasured/unaccepted.
