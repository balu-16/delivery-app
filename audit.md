# Delivery Platform — Reliability & Security Audit

**Status:** COMPLETE — 27 findings, every one verified against the code with file:line evidence. No code was modified; this is a recommendation-only audit.
**Scope:** `server/` (src, tests, migrations, scripts, infra, configs, docs) + `milk_app/` + root CI.
**Excluded:** `delivery_partner_app/` (in development, per request), node_modules, dist, coverage, artifacts, openapi output, `.expo`, `references/` images, lockfiles (except the milk_app lockfile-duplication observation).
**Method:** line-by-line review of platform/common/config/composition-root, the money-critical modules (checkout, payments, orders, cart, wallet, identity), 35 SQL migrations, the WIP customer-group sync, milk_app auth/api core; two bounded read-only subagent sweeps (20 domain modules; surfaces/adapters/milk_app) with every subagent finding independently re-verified against the code before inclusion.

---

## 1. Executive summary

| Severity | Count |
|---|---|
| Critical | 1 |
| High | 0 |
| Medium | 6 |
| Low | 16 |
| Info | 4 |

(27 findings total. Both sweeps complete; every finding independently re-verified against the code.)

**Top 10 most dangerous issues:**
1. **BUG-008** — floating dispatch promise → unhandled rejection → process crash on rider pre-pickup drop during a transient DB/Redis failure (the only finding that can take an instance down).
2. **BUG-001** — unindexed `metadata->>'checkoutOperationId'` full scan on every checkout placement (hottest endpoint, linear with order history).
3. **BUG-010** — ~135-query config fan-out inside pick completion/substitution transactions that hold order+inventory locks → pool starvation under picker load.
4. **BUG-002** — 30s idempotency lease vs long placement saga → successful orders surfaced as 500s under load.
5. **BUG-009** — dispatch holds order/task row locks across the external maps HTTP call (provider degradation serializes order mutations).
6. **BUG-011** — subscription calendar issues up to ~1.5k sequential pricing transactions per request.
7. **BUG-019** — wallet top-up replay returns 200 with a stored 503 body — clients can misread a failed top-up as success.
8. **BUG-007** — provider-webhook rate-limit bypass regex never matches the real path (reachability invariant silently depends on the ×10 IP envelope).
9. **BUG-013** — invoice rendering has no attempt cap/backoff; poison documents starve the render window forever.
10. **BUG-014** — catalog suggest cache key omits user/favorites — latent cross-user cache IDOR one future caller away.

(Honorable mentions: BUG-022 per-IP limits collapse behind a proxy; BUG-003/004 customer-group observability gap on the WIP feature.)

**Overall health score: 8 / 10.** This is an unusually well-hardened codebase: fail-closed auth guards, idempotency-keyed money mutations with DB-side uniqueness, an outbox with lease-claimed deliveries, bounded retries with backoff nearly everywhere, append-only financial history enforced by triggers, strict env validation that forbids dev providers/secrets in production, and a nightly reconciliation pass that only reports (never moves money). I specifically tried to break the duplicate-capture race, the refund fencing, the wallet split, the placement saga and the realtime gateway — all held. The one Critical is a mechanical async mistake (fire-and-forget without a rejection handler) rather than a design flaw, and the remaining findings are scale-dependent performance issues and edge-case gaps, not correctness holes.

## 2. Architecture overview

- **Runtime:** NestJS 12 on Fastify, Node 26, pnpm 12.18; roles `all|customer|rider|store|admin|worker` via `RoleModule.forRole` (composition root: `server/src/app-roles/roles.ts`).
- **Data:** Postgres/PostGIS via Kysely (`server/src/platform/database/database.ts`, pool max 20, statement timeout 10s, IAM-auth option). 35 forward-only migrations with CHECK constraints, append-only triggers, partial unique indexes.
- **Transport/durability:** Outbox in Postgres (`platform/outbox`), delivered by BullMQ (Redis) or SQS pointers (`platform/queue/*`), consumed exactly-once via `consumeOnce` (processed_events dedupe + lease fencing).
- **Auth:** Cognito JWT verification per audience (`adapters/auth/cognito.ts`), DB-authoritative principal + role intersection with token groups (`identity-policy.ts`), fail-closed `IdentityGuard` requiring a declared `AUTH_POLICY` on every route.
- **Money:** integer-paise `bigint` throughout (`common/money`), pure pricing engine (`modules/pricing`), wallet ledger with per-bucket uniqueness, capture receipts keyed by gateway_payment_id, refunds as capacity-checked commitments.
- **Realtime:** Socket.IO with Redis/sharded adapter, receive-only clients, per-connection token re-validation every 10s, room authorization delegated per namespace.
- **Clients:** `milk_app` Expo/RN customer app (Zustand stores, SecureStore token storage, Cognito direct auth + backend bootstrap).

### Coverage confirmation

- **server/src/platform (23 files), common (13), config (3), app-roles (2), main/bootstrap:** read line-by-line by the auditor.
- **Money-critical modules — checkout, payments, orders, cart, wallet, identity (incl. uncommitted WIP):** read line-by-line by the auditor (core services, consumers, crypto, admin, WIP infra; pure contract/type files read and cross-checked).
- **Remaining 20 domain modules (~215 src files):** read end-to-end by sweep 1; every reported finding re-verified by the auditor against the source.
- **db/migrations (35 SQL):** reviewed by the auditor (schema reviewed in full for the tables the audited code touches; all 35 files opened and checked for risky DDL, constraint/index coverage, and code-vs-schema mismatches).
- **server/src/surfaces (89 files) and adapters (23):** reviewed by sweep 2 (52 controllers + DTOs line-by-line; pure-wiring module files swept and cross-checked); every reported finding re-verified by the auditor.
- **milk_app (~65 files):** core (api client, session, cognito, push, customer store) read by the auditor; full app reviewed by sweep 2.
- **Tests (171 server test files, 8 app suites):** assessed by project — coverage of critical paths, assertion quality, and the missing-test list in §7; not reviewed line-by-line as production code.
- **Scripts/devtools (~30 files), docs (13), CI/Docker/compose/husky/env examples:** reviewed for consistency, claims-vs-code, and env-var alignment.
- **Not reviewed line-by-line:** `server/scripts/*` smoke/seed utilities (invoked manually, not in the request path), `delivery_partner_app/` (excluded per request), generated OpenAPI clients.

### Verification evidence gathered (read-only)

- `pnpm typecheck` — exit 0.
- `pnpm lint` — eslint + boundary check (504 source files) + manifest validation (6 manifests, 328 operation records) — all pass.
- `pnpm test:unit` — 71 suites, 308 tests — all pass.
- `milk_app` `pnpm test` — 8 suites, 49 tests — all pass.
- Integration/concurrency/e2e suites were not executed (no local Docker/DB/Redis; running them requires the paused Aurora/resumed resources and is out of scope for this read-only audit).

## 3. Findings (direct review — verified)

### Medium

---

**ID: BUG-001**
Title: Order placement does an unindexed full-table scan on every call
Severity: Medium
Category: F. Data and performance
Location: server/src/modules/checkout/infrastructure/place-order.ts:64-70; called from server/src/modules/checkout/infrastructure/checkout-service.ts:114
Evidence:
```ts
async findResumable(operationId: string): Promise<OrderView | null> {
  const rows = await sql<{ id: string }>`SELECT id::text AS id FROM orders
    WHERE metadata->>'checkoutOperationId' = ${operationId}
    ORDER BY placed_at LIMIT 1`.execute(this.deps.db);
```
What is wrong: The query filters on the jsonb expression `metadata->>'checkoutOperationId'`. The migrations create a unique expression index for `metadata->>'intentId'` (011_p6_integrity_repair.sql:8) but **no index exists for `checkoutOperationId`** (verified: `grep -rn "checkoutOperationId" server/db/migrations/` returns nothing). `findResumable` is invoked at the start of every `CheckoutService.place()` call, before the saga.
Impact / failure scenario: Every customer checkout performs a sequential scan of the entire `orders` table (most placements find no resumable row, so the scan runs to completion). At 100k+ orders this adds hundreds of milliseconds of DB CPU to the hottest, most latency-sensitive endpoint in the product, and it scales linearly with historical order volume.
Root cause: The resume path was added for crash recovery; the expression index that exists for `intentId` was not mirrored for `checkoutOperationId`.
Recommended fix: Add a forward migration: `CREATE UNIQUE INDEX orders_checkout_operation_unique_idx ON orders ((metadata->>'checkoutOperationId')) WHERE metadata ? 'checkoutOperationId';` (unique is safe: one order per idempotency operation by construction; fall back to a plain index if uniqueness cannot be asserted).
Related findings: —
Confidence: High

---

**ID: BUG-002**
Title: Idempotency lease (30s) can expire mid-placement, converting a successful order into a 500
Severity: Medium
Category: B. Concurrency and async correctness
Location: server/src/surfaces/customer/checkout/customer.controller.ts:150-158; server/src/common/idempotency/idempotency.ts:50 (claim lease default 30s) and 113-122 (execute lease re-check)
Evidence:
```ts
const claim = await this.idem.claim(
  { actor: p.userId, audience: 'customer', method: 'POST', resource, key },
  hashRequest(JSON.stringify(body)),
);
...
const result = await work(claim.owner.operationId);            // placement saga — own transaction, may take > 30s
await this.idem.execute(claim.owner, async () => ({ status: 200, body: result as Json }));
```
```ts
if (
  !row || row.state !== 'PROCESSING' || row.owner_token !== owner.token ||
  row.operation_id !== owner.operationId || !row.lease_until || row.lease_until <= now
)
  throw new Error('IDEMPOTENCY_LEASE_LOST');
```
What is wrong: `claim()` uses the default 30-second lease, but the guarded work (the placement saga: capacity claim, coupon reserve, wallet debit, order insert, inventory reserve) runs in its own transaction afterwards and is not lease-renewed. If the saga takes longer than 30s under contention (row-lock queues, statement timeouts of up to 10s per statement), `execute()` throws `IDEMPOTENCY_LEASE_LOST` **after the order has already committed**. `IDEMPOTENCY_LEASE_LOST` is not present in `DOMAIN_ERROR_STATUS` (server/src/common/http/problem-codes.ts:129-269), so the ProblemFilter maps it to 500 `INTERNAL_ERROR`.
Impact / failure scenario: Client POSTs `/v1/customer/checkout/place`; the order commits; the response is a 500. The client retries with the same key; if within 30s it gets 409 `REQUEST_IN_PROGRESS`, otherwise the retry re-claims the key and the resume path (`findResumable`) returns the already-placed order — so the system self-heals, but the client saw an error for a successful purchase, and the same pattern applies to the other `keyed()` endpoints (reorder, cancel, wallet, subscriptions).
Root cause: The lease duration is fixed at claim time and never renewed during long-running work; no lease extension between claim and execute.
Recommended fix: Either (a) pass a longer leaseSeconds tuned to the longest guarded work (e.g. 120s for placement), or (b) map `IDEMPOTENCY_LEASE_LOST` to 503/409 in `DOMAIN_ERROR_STATUS` so the client retries idempotently instead of surfacing a 500, or (c) add a lease-heartbeat inside `execute` for long work.
Related findings: —
Confidence: High on the mechanism; Medium on production frequency (Needs load data).

---

### Low

---

**ID: BUG-003**
Title: Backend customer-group sync failures are invisible to the EnqueueFailureMetric alarm
Severity: Low
Category: I. Build, config, and infrastructure (observability)
Location: server/infra/customer-group/template.yaml:158-166 (metric filter) vs server/src/modules/identity/identity.module.ts (uncommitted diff — onError callback)
Evidence:
```yaml
EnqueueFailureMetric:
  Type: AWS::Logs::MetricFilter
  Properties:
    LogGroupName: !Ref TriggerLogs          # only the PostConfirmation trigger Lambda's log group
    FilterPattern: '"CUSTOMER_GROUP_ENQUEUE_FAILED"'
```
```ts
return new IdentityService(handle.db, access, referrals, sync, () =>
  Logger.error('CUSTOMER_GROUP_ENQUEUE_FAILED', 'CustomerGroupSync'),   // backend log group, not TriggerLogs
);
```
What is wrong: The CloudWatch metric filter that feeds `EnqueueFailureAlarm` only watches the trigger Lambda's log group. The backend's bootstrap-recovery path (added in the WIP) emits the same marker string to the backend's own log group, which is not scanned. Backend-path enqueue failures therefore never raise the alarm.
Impact / failure scenario: SQS/permission problem on the backend's send path goes unnoticed; verified-customer group assignment silently lags until a customer notices (group membership is informational, so there is no functional break — this is purely an observability gap).
Root cause: The template was written before the backend retry path existed.
Recommended fix: Add a second metric filter on the backend's log group (or emit the backend-side failures through a shared structured logger and filter both groups into the same metric namespace).
Related findings: BUG-004 (logging channel consistency)
Confidence: High

---

**ID: BUG-004**
Title: WIP identity module uses Nest's static Logger, bypassing the structured pino sink
Severity: Low
Category: H. Consistency across the codebase
Location: server/src/modules/identity/identity.module.ts (uncommitted diff, onError callback); compare server/src/common/logging/logger.ts
Evidence:
```ts
import { Logger, Module } from '@nestjs/common';
...
() => Logger.error('CUSTOMER_GROUP_ENQUEUE_FAILED', 'CustomerGroupSync'),
```
What is wrong: Every other module reports operational failures through injected callbacks wired to the pino logger (e.g. `platform.module.ts` uses `logger.error(...)`), which applies the redact rules and JSON structure. The WIP uses the Nest static `Logger`, which prints Nest-formatted plain text to stdout and bypasses the redaction/structured pipeline.
Impact / failure scenario: Log ingest pipelines keyed on JSON (and the metric filter in BUG-003, which matches a plain substring and would still work) see inconsistent formats; future fields added to this message bypass redaction.
Root cause: New code reached for the framework default instead of the established pattern.
Recommended fix: Pass a pino-backed error callback (as `PlatformModule.forRoot` does) into `IdentityService`.
Related findings: BUG-003
Confidence: High

---

**ID: BUG-005**
Title: SQS concern-job failure backoff lacks jitter (retries align in waves)
Severity: Low
Category: C. Connection pools and external dependencies
Location: server/src/platform/queue/sqs-concern-store.ts:174-177; compare server/src/platform/events/consume.ts:44 (has `+ random()`)
Evidence:
```sql
available_at=clock_timestamp()+(LEAST(300,power(2,LEAST(attempts,8))))*interval '1 second',
next_send_at=clock_timestamp()+(LEAST(300,power(2,LEAST(attempts,8))))*interval '1 second',
```
What is wrong: The outbox consumer's `failDeliveryAttempt` adds `+ random()` seconds to the same formula, but `SqsConcernStore.fail` does not. Jobs that fail together (e.g. during a provider blip) retry on synchronized waves every pass.
Impact / failure scenario: A transient outage affecting a batch of jobs produces synchronized retry bursts against the same dependency every backoff interval, amplifying recovery time.
Root cause: Two retry implementations drifted; only one got jitter.
Recommended fix: Add `+ random()*interval '1 second'` to both columns in `SqsConcernStore.fail` (matching `failDeliveryAttempt`).
Related findings: —
Confidence: High

---

**ID: BUG-006**
Title: Root README misdescribes the customer app as demo-only
Severity: Low
Category: H. Consistency (docs vs code)
Location: README.md:30; contradicted by milk_app/README.md ("Current integration and checks" section) and milk_app/src/store/customer.ts (full API wiring)
Evidence:
```md
The shopping screens currently use local demo data. A read-only connected preview is available from Profile; see the [customer app setup](milk_app/README.md).
```
What is wrong: The root README says the milk_app shopping screens use local demo data; the milk_app README and code (AuthGate Cognito sign-in, customer store with cart/quote/checkout/orders/wallet/subscriptions) show the app is fully connected to the backend.
Impact / failure scenario: New contributors trust the stale claim and skip wiring `EXPO_PUBLIC_API_URL`/Cognito, then misdiagnose the app as broken.
Root cause: Root README not updated when the app integration landed.
Recommended fix: Update README.md:30 to match milk_app/README.md.
Related findings: —
Confidence: High

---

**ID: BUG-007**
Title: Provider-webhook rate-limit bypass regex never matches the actual webhook path (dead branch)
Severity: Low
Category: H. Consistency (intent vs code) / D. Error handling and resilience
Location: server/src/common/http/rate-limit.ts:14-19 vs server/src/surfaces/customer/payments/webhook-route.ts:7
Evidence:
```ts
// Health and signed provider webhooks must remain reachable during Redis outages.
if (
  ['/healthz', '/readyz', '/metrics'].includes(path) ||
  /^\/v1\/webhooks\/payments\/[^/]+$/.test(path)
)
  return undefined;
```
```ts
export const WEBHOOK_ROUTE = '/v1/customer/webhooks/payments/:gateway';
```
What is wrong: The bypass regex expects `/v1/webhooks/payments/<gateway>`, but the registered route is `/v1/customer/webhooks/payments/<gateway>` — the regex never matches, so provider webhooks fall into the `default` route class. Today the blast radius is contained by two accidents: the anonymous per-IP envelope for non-auth routes is multiplied ×10 (bootstrap.ts:110-111 → effective 1200/min/IP), and Redis outages fail open for non-location routes. The comment and the bypass branch are dead code, and the webhook's reachability now silently depends on the ×10 envelope.
Impact / failure scenario: If the ×10 IP envelope is ever tightened (a reasonable hardening), a Razorpay webhook burst above 120/min per egress IP starts receiving 429s; Razorpay retries non-2xx deliveries, delaying funding confirmations. The stated invariant ("signed provider webhooks must remain reachable") is not actually enforced by the code that claims to enforce it.
Root cause: The webhook path gained the `/customer` audience segment at some point and the bypass regex was not updated.
Recommended fix: Update the regex to `/^\/v1\/(?:customer|rider|store|admin)?\/?webhooks\/payments\/[^/]+$/` — or, cleaner, `/^\/v1\/[a-z]+\/webhooks\/payments\/[^/]+$/` — so the documented bypass is real again.
Related findings: —
Confidence: High

---

### Info

---

**ID: INFO-001**
Title: Append-only tables grow without bound by design (processed_events, idempotency_keys, outbox_events, gateway_event_inbox)
Severity: Info
Category: A. Resource and memory management
Location: server/src/modules/compliance/infrastructure/retention.ts:4-22 ("Retain notification dedupe tombstones and financial/operation references indefinitely"); server/db/migrations/001_p0_foundation.sql:72-77
Evidence:
```ts
/** Retain notification dedupe tombstones and financial/operation references indefinitely. */
```
What is wrong: Only response bodies (idempotency) and notification payloads are pruned. `processed_events`, completed `outbox_deliveries`/`outbox_events`, `gateway_event_inbox` PROCESSED rows, and `idempotency_keys` rows accumulate forever. This is a documented compliance decision, not a defect, but the tables are the primary long-term growth surface.
Impact / failure scenario: After a year of operation these tables dominate DB size; `outbox_delivery_due_idx` and dedupe lookups stay fast (indexed), but backups/vacuum cost grows.
Recommended fix: Document expected growth in the runbook and add size alarms; if compliance allows, archive completed rows older than N years.
Confidence: High (deliberate design; flagged for ops awareness)

---

**ID: INFO-002**
Title: Two Redis client libraries coexist (ioredis + node-redis cluster)
Severity: Info
Category: H. Consistency across the codebase
Location: server/package.json dependencies (`ioredis` 6.0.0, `redis` 6.3.1); server/src/platform/redis/redis.ts vs server/src/platform/redis/iam-cluster.ts
Evidence: `createRedis`/`createIamRedis` use ioredis; `createIamRedisCluster` (ElastiCache sharded pub/sub for realtime) uses node-redis `createCluster`.
What is wrong: Not a bug — node-redis was evidently chosen for native cluster/sharded-pubsub support with credential providers — but two Redis stacks in one service double the operational surface (pools, timeouts, TLS behavior).
Recommended fix: Document the split in the architecture docs (docs/ARCHITECTURE.md) so future contributors don't "unify" them accidentally.
Confidence: High

---

**ID: INFO-003**
Title: Refund dispatch holds a dedicated pool connection across the external gateway call
Severity: Info
Category: C. Connection pools and external dependencies
Location: server/src/modules/payments/infrastructure/refund-service.ts:167-217
Evidence:
```ts
const result = await this.db.connection().execute(async (connection) => {
  const lock = await sql`SELECT pg_try_advisory_lock(...) ...`.execute(connection);
  ...
  const outcome = await this.gateway.refund({...});   // network call while the connection is checked out
```
What is wrong: A session-level advisory lock requires holding one pool connection for the duration of the provider call. This is deliberate (the comment explains the fencing) and bounded by worker concurrency (default 4 against a pool of 20), but it is the only place a connection is deliberately held across I/O and worth knowing during capacity planning.
Recommended fix: None required; document the invariant "concurrent dispatches ≤ worker concurrency ≪ pool max" in the payments docs.
Confidence: High

---

**ID: INFO-004**
Title: Event `occurredAt` timestamps mix app clock and DB clock
Severity: Info
Category: H. Consistency / F. Data
Location: server/src/modules/checkout/infrastructure/scheduled-order.ts:263 (`new Date().toISOString()`) and several webhook/event emission sites (webhook-service.ts:310, payment-recovery.ts:98, order-consumer.ts via appendEvent callers) vs `databaseTimeAfterLock` used in place-order.ts:79
Evidence: Some `appendEvent` envelopes use the Node process clock, others use the Postgres clock sampled after row locks.
What is wrong: Event ordering and `oldest_pending_seconds` metrics in `OutboxStore.metrics()` are computed from `occurred_at`; mixed clock sources introduce small skew (usually milliseconds; larger if an app host's clock drifts).
Recommended fix: Prefer the DB clock (`databaseTimeAfterLock`) wherever an event is emitted inside a transaction that already holds locks; keep a single convention.
Confidence: High on the inconsistency; Low on practical impact.

---

## 4. Consistency issues (direct-review scope)

| # | What varies | Where | Recommended standard |
|---|---|---|---|
| C-1 | Error-callback style: injected pino callbacks (platform modules) vs Nest static Logger (identity.module WIP) | server/src/modules/identity/identity.module.ts vs server/src/platform/platform.module.ts | Always inject a pino-backed callback |
| C-2 | Retry backoff with/without jitter | consume.ts:44 vs sqs-concern-store.ts:174 | Always jitter |
| C-3 | `occurredAt` clock source | see INFO-004 | DB clock inside transactions |
| C-4 | COD-eligibility logic duplicated | checkout-service.ts:85-112 (`canPayCash`) vs place-order.ts:294-317 (`codVerdict`) | Extract one shared evaluator (the pure `evaluateCod` is already shared; the surrounding queries are duplicated) |
| C-5 | Both `package-lock.json` and `pnpm-lock.yaml` present in milk_app | milk_app/ | Delete the npm lockfile; the repo standard is pnpm (both are tracked in git, verified) |

## 5. Systemic patterns observed (positive)

- Money paths consistently combine: row locks → revalidation against frozen fingerprints → append-only ledger uniqueness → outbox events. The duplicate-capture race I specifically probed (order-consumer.ts:88-124) is handled correctly via the `additionalCapture === true` disjunct.
- Every external call is fenced by a durable operation row claimed before the call, with ambiguity routed to lookup, never speculative retry.
- Input validation is uniform: zod env contract, class-validator DTOs, SQL parameterization everywhere (no string-built SQL found in the audited surface).

## 6. Remediation plan (recommendation-only)

| Priority | Finding | Fix | Effort | Risk |
|---|---|---|---|---|
| 1 | BUG-008 (Critical) | `.catch()` the wired `dispatchNext` callback; add `unhandledRejection` logger | S | Low — behavior only changes on the error path |
| 2 | BUG-001 | Expression index migration on `orders.metadata->>'checkoutOperationId'` | S | Low (additive index; write amplification on placement only) |
| 3 | BUG-010 | Narrow the two picking `snapshot()` call sites; batch `snapshot()` keys | S | Low |
| 4 | BUG-002 | Longer placement lease + map `IDEMPOTENCY_LEASE_LOST` to 409/503 | S | Low |
| 5 | BUG-009 | Pre-compute distance matrix outside the dispatch transaction | M | Medium — changes dispatch sequencing; needs concurrency tests |
| 6 | BUG-011 | Batch subscription price estimates; cap per request | M | Medium — pricing outputs must stay identical |
| 7 | BUG-019 | Replay branch honors the stored status (throw HttpException when ≥400) | S | Low |
| 8 | BUG-007 | Fix webhook bypass regex | S | Low |
| 9 | BUG-013 | Render attempts + backoff + terminal state | M | Low |
| 10 | BUG-014 | Include user/favorites in suggest cache digest | S | Low |
| 11 | BUG-020/021 | Register the code + share `canonical()`; BUG-022 trustProxy decision | S–M | Low |
| 12 | BUG-012/015/016/017/018 | Dead code, batching, lock-order alignment, redundant clause | S–M | Low |
| 13 | BUG-023 | Per-attempt socket `auth` callback in my-dairy | S | Low |
| 14 | BUG-003/004 | Metric filter for backend log group + pino callback | S | Low |
| 15 | BUG-005 | Add jitter to SQS concern backoff | S | Low |
| 16 | BUG-006, C-1..C-5 | Docs/consistency cleanups | S | None |

## 7. Missing tests to add

1. A regression test that a rejecting `dispatchNext` does not propagate an unhandled rejection (BUG-008) — e.g. inject a failing engine double and assert the rider `fail()` endpoint still returns normally with no process-level listener warnings.
2. A unit/integration test asserting `findResumable` uses an indexed plan (`EXPLAIN` assertion or a fixture large enough to fail a timeout without the index).
3. A concurrency test driving `place()` with a delayed saga (> lease seconds) to lock in the expected client-visible behavior chosen for BUG-002.
4. A test that a backend-side customer-group enqueue failure increments the same metric the alarm consumes (once BUG-003 is fixed).
5. An invoicing test that a deterministically-failing render eventually reaches an operator-visible terminal state instead of retrying forever (BUG-013).
6. A catalog test asserting a `suggest+favorites` combination cannot serve one user's favorites from another user's cache entry (BUG-014).
7. A wallet top-up test asserting a replayed failed attempt returns the stored 503, not 200 (BUG-019).
8. A surface test asserting the documented `IDEMPOTENCY_KEY_REQUIRED` code actually appears in a 400 response (BUG-020).
9. An idempotency test asserting the same logical request with reordered JSON keys replays instead of 409-ing (BUG-021).

## 8. Open questions for the developer

1. BUG-002: Is a longer lease acceptable for placement, or do you prefer the status-code mapping? (Both are small; the lease change alters retry semantics under very long locks.)
2. BUG-008: Should the follow-up dispatch round stay fire-and-forget (with a `.catch`) or become an explicit queue obligation? The sweep already guarantees progress, so the immediate round is a latency nicety.
3. INFO-001: What is the operational position on archiving `processed_events`/`outbox_events` after N years — is indefinite retention contractual?
4. INFO-002: Keep node-redis solely for the ElastiCache IAM cluster, or is consolidating on ioredis planned?

---

## 9. Subagent sweep 1 — domain modules (all findings independently re-verified against the code by the auditor)

Coverage: all 20 audited domain modules read end-to-end (addresses, app-config, catalog, compliance, coupons, dispatch, inventory, invoicing, media, notifications, picking, pricing, ratings, referrals, riders, serviceability, stores, subscriptions, support, tracking). Candidates investigated and dropped as non-defects after tracing are listed in §9.1.

### Critical

---

**ID: BUG-008**
Title: Floating dispatch promise can crash the API process (unhandled rejection) on pre-pickup rider drop
Severity: Critical
Category: B. Concurrency and async correctness
Location: server/src/modules/dispatch/infrastructure/postgres-task-actions.ts:425; server/src/modules/dispatch/dispatch.module.ts:292 and 107-120; server/src/modules/dispatch/infrastructure/dispatch-engine.ts:48-115
Evidence:
```ts
// postgres-task-actions.ts:425 (fail() pre-pickup branch — task ASSIGNED/AT_STORE)
return { result: task.id, effects: [() => void this.dispatchNext(task.order_id)] };

// dispatch.module.ts:292 (wiring — no rejection handler)
(orderId) => engine.dispatchOne(orderId).then(() => undefined),

// dispatch.module.ts:107-120 (taskRunner — try/catch only covers synchronous throws)
for (const effect of outcome.effects ?? [])
  try { effect(); } catch { /* emissions never break order flow ... */ }
```
What is wrong: The effect evaluates `void this.dispatchNext(...)` — a floating promise. The wired callback `engine.dispatchOne(orderId).then(() => undefined)` has no rejection handler, `dispatchOne` has no internal try/catch (only the sweep path guards it: `dispatch-engine.ts:126 await this.dispatchOne(row.order_id).catch(() => 'RETRY')`), and `taskRunner`'s try/catch cannot catch an async rejection because the effect returns before the promise settles. There is no `process.on('unhandledRejection')` anywhere in `src` (verified by grep), and Node ≥15 (this repo requires Node 26) terminates the process on unhandled rejection by default. `dispatchOne` rejects on: `transactionWithRetry` exhaustion (deadlock/serialization after 3 attempts or any DB error), `RedisRiderGeo.candidatesNear` (redis.call with no catch, redis-geo.ts:28-48), or `DispatchSettings.number` (`INVALID_CONFIG_TYPE`).
Impact / failure scenario: A rider calls `fail()` pre-pickup ("can't make it") at the moment of a transient DB or Redis failure → unhandled rejection → the API process exits. On a `role=all` or single-instance deployment this is an outage of every surface hosted by that process until the orchestrator restarts it; on multi-instance deployments it repeatedly kills instances as riders retry.
Root cause: The follow-up-dispatch effect was wired fire-and-forget without a rejection handler, while the sweep path that shares the same engine does guard it.
Recommended fix: Wire `dispatchNext` as `(orderId) => engine.dispatchOne(orderId).catch(() => undefined)`; optionally add a top-level `process.on('unhandledRejection')` logger as defense in depth.
Related findings: BUG-012 (dead sibling statement with the same latent hazard)
Confidence: High

---

### Medium

---

**ID: BUG-009**
Title: Dispatch transaction holds order+task row locks across the external maps HTTP call
Severity: Medium
Category: C. Connection pools and external dependencies
Location: server/src/modules/dispatch/infrastructure/dispatch-engine.ts:52-103 (transaction) and 289-299 (scoreInputs → maps.distanceMatrix)
Evidence:
```ts
const result = await transactionWithRetry(this.db, async (tx) => {
  const order = await txSelectOrder(tx, orderId);        // orders FOR UPDATE
  const tasks = await sql<TaskRow>`... FOR UPDATE` ...;
  ...
  const scored = scoreCandidates(
    await this.scoreInputs(candidates, store),           // → this.maps.distanceMatrix(...) — external HTTP, retried
```
What is wrong: `dispatchOne` holds `FOR UPDATE` locks on the order row and delivery-task rows while awaiting the maps provider (up to `OLA_MAPS_MAX_ATTEMPTS` attempts × `OLA_MAPS_TIMEOUT_MS` each, behind the ResilientMaps breaker).
Impact / failure scenario: A degraded maps provider makes every dispatch round for an order block all customer actions on that order (cancel, address change, custody transitions) and hold a pool connection for the full provider duration; the sequential sweep (`dispatchDue` limit 20) compounds lock wait times across orders. Only manifests when `MAPS_PROVIDER=ola` (the fake adapters are local).
Root cause: Candidate scoring requires rider distances, computed inside the locking transaction.
Recommended fix: Pre-compute the distance matrix before opening the transaction (candidate ids can be selected first), or fall back to the local haversine estimate inside the lock and reconcile after.
Related findings: INFO-003 (deliberate connection-hold pattern in refund dispatch)
Confidence: High

---

**ID: BUG-010**
Title: `ConfigService.snapshot()` fans out ~135 version-check SELECTs per call, inside pick hot paths that hold locks
Severity: Medium
Category: F. Data and performance / A. Resource management
Location: server/src/modules/app-config/infrastructure/config-service.ts:331-336 (snapshot), 260-277 (getMany — one SELECT per call); callers server/src/modules/picking/infrastructure/postgres-pick-actions.ts:263 and :342
Evidence:
```ts
async snapshot(): Promise<{ config: ConfigValues; flags: ... }> {
  const config = Object.fromEntries(
    await Promise.all(
      (Object.keys(definitions) as ConfigKey[]).map(async (key) => [key, await this.get(key)]),
    ),
  ) as unknown as ConfigValues;
```
```ts
// pick-actions substituteItem: needs only flags
const { flags } = await this.admin.snapshot();
// pick-actions complete: needs one key
const tolerance = (await this.admin.snapshot()).config.pickingWeightToleranceBps;
```
What is wrong: `snapshot()` issues one `SELECT ... FROM app_config WHERE key IN (<single key>)` per definition key (~135 total, `Promise.all`). The value cache is version-validated (so values are cheap) but the version check itself always hits the database. Both call sites run inside transactions that already hold the order row, the `inventory-order` advisory lock, store_inventory row locks and the `picking-task` advisory lock; the fan-out queries contend for the remaining pool connections (max 20).
Impact / failure scenario: Under picker load, each substitution/weight-checked completion queues ~135 statements against a 20-connection pool while holding critical locks → pool starvation and latency spikes across the whole API.
Root cause: `snapshot()` predates `getMany`; the two picking call sites need 0 config keys and 1 config key respectively, not all of them.
Recommended fix: Read only what is needed (`flags` via the existing single flags query; `pickingWeightToleranceBps` via `getMany`) and add a batched all-keys SELECT to `snapshot()` for genuine full-snapshot consumers.
Related findings: —
Confidence: High

---

**ID: BUG-011**
Title: Subscription calendar/upcoming prices one scheduled day per transaction (N+1, up to ~1.5k pricing transactions per request)
Severity: Medium
Category: F. Data and performance
Location: server/src/modules/subscriptions/infrastructure/subscriptions-service.ts:253-275 (upcoming), 314-319 (calendar)
Evidence:
```ts
if (amount === null && r.status === 'ACTIVE' && ...) {
  const estimate = await this.db.transaction().execute((tx) =>
    this.checkout.priceScheduled({ ... }, tx));       // full pricing pipeline per day row
  amount = estimate.totalPaise;
}
...
for (const s of subscriptions.rows.slice(0, page.limit))
  result.push({ subscriptionId: s.id, deliveries: await this.upcoming(userId, s.id, from, to) });
```
What is wrong: `upcoming()` opens a fresh transaction per scheduled day lacking a stored amount; each `priceScheduled` runs the full `prepare()` pipeline (flags, address, serviceability, product, ~9 config keys, surge flag, referral entitlement ≈ 15+ queries). `calendar()` loops over up to 50 subscriptions × up to 31 month-days.
Impact / failure scenario: A customer loading the subscription calendar for a month with 50 subscriptions and no cached amounts issues ~1,500 sequential pricing transactions (~20k+ queries) — multi-second responses and sustained pool pressure.
Root cause: Price estimates were bolted onto a per-day renderer.
Recommended fix: Batch-estimate in one read-only transaction (one variant/store/quantity dominates most subscriptions), cache per (variant, store, week), and cap estimates per request.
Related findings: —
Confidence: High

---

### Low

---

**ID: BUG-012**
Title: `void this.dispatchDue;` never invokes the post-commit dispatch round (dead statement)
Severity: Low
Category: B/G. Dead code contradicting its comment
Location: server/src/modules/dispatch/infrastructure/consumers.ts:114-116
Evidence:
```ts
// Post-commit best effort; the sweep guarantees progress either way.
void this.dispatchDue;
```
What is wrong: The statement evaluates the callback reference and discards it — the immediate post-commit dispatch round never happens (the 10s sweep covers it). It also plants the same floating-promise hazard as BUG-008 for whoever later "fixes" it into a real call.
Impact: Dispatch latency after pick-start/pack is bounded by the sweep interval, not instant as the comment claims; latent crash hazard if converted to a real call without a catch.
Root cause: Incomplete edit.
Recommended fix: Delete the statement, or call it with explicit error handling: `void this.dispatchDue(orderId).catch(() => undefined);`
Related findings: BUG-008
Confidence: High

---

**ID: BUG-013**
Title: Invoice rendering retries permanently-failing documents forever with no attempt cap or backoff; oldest-50 window can starve
Severity: Low
Category: B/D. Poison-job handling
Location: server/src/modules/invoicing/infrastructure/invoice-issuer.ts:172-208; scheduler at invoicing-worker.module.ts (renderDue(50) every 60s)
Evidence:
```ts
const due = await sql<DocumentRow>`SELECT ${sql.raw(COLUMNS)} FROM invoice_documents
  WHERE renderer_state IN ('PENDING','FAILED') ORDER BY created_at LIMIT ${limit}`.execute(this.db);
...
} catch {
  await sql`UPDATE invoice_documents SET renderer_state='FAILED',updated_at=clock_timestamp()
    WHERE id=${row.id}::uuid AND renderer_state <> 'RENDERED'`.execute(this.db);
}
```
What is wrong: FAILED documents are re-selected every sweep with no attempts counter, backoff, or dead-letter state; the `ORDER BY created_at LIMIT 50` window stays occupied by the oldest failures.
Impact / failure scenario: A deterministically-failing payload (or a long storage outage accumulating >50 failures) is retried every 60s indefinitely, and PENDING documents beyond the oldest 50 never render — those orders have numbered invoices that never become retrievable.
Root cause: Rendering retry policy lacks the attempt budget every other worker in this codebase has.
Recommended fix: Add a `render_attempts` counter + exponential backoff (mirroring `failDeliveryAttempt`), suspending to an operator-visible state after the cap.
Related findings: —
Confidence: High (mechanism); impact needs volume to matter

---

**ID: BUG-014**
Title: Catalog suggest cache digest omits user/favorites — latent cross-user cache reuse (currently unreachable)
Severity: Low
Category: E. Security (cache scoping)
Location: server/src/modules/catalog/infrastructure/catalog-query.ts:160-193 (digest) vs :238 (favorites filter)
Evidence:
```ts
const digest = createHash('sha256').update(JSON.stringify([
  store, q, options.category ?? null, options.product ?? null,
  meta.revision, threshold, maxPerOrder, this.cdnBase ?? null,
  options.cursor ?? null, limit,        // ← no user, no options.favorites
])).digest('hex');
cacheKey = `delivery:catalog:suggest:${digest}`;
...
AND (${options.favorites !== true} OR EXISTS(SELECT 1 FROM customer_favorites f WHERE f.user_id=${user}::uuid ...))
```
What is wrong: When `suggest` caching is active, the cache key does not include the caller, while the underlying SQL applies a per-user favorites filter. Verified today the only HTTP paths are `favorites/products` (no query string → `suggest` false) and `search/suggest` (never sets `favorites`), so no current path combines them — but `list()` is exported on the `CATALOG_QUERY` port.
Impact / failure scenario: Any future caller combining `suggest + favorites` serves user A's favorites to user B (IDOR via shared cache).
Root cause: Cache key built before the favorites filter existed.
Recommended fix: Include `(options.favorites ?? false, favorites ? user : null)` in the digest, or skip caching when `options.favorites` is set.
Related findings: —
Confidence: High (gap), reachability closed today

---

**ID: BUG-015**
Title: `PostgresCoupons.available()` runs one quota query per coupon (bounded N+1)
Severity: Low
Category: F. Data and performance
Location: server/src/modules/coupons/infrastructure/postgres-coupons.ts:56-68
Evidence:
```ts
for (const row of found.rows) {                 // LIMIT 100
  ...
  if (row.per_user_limit !== null) {
    const quota = await sql<{ used: number }>`SELECT reserved_count + committed_count AS used
      FROM coupon_user_quota WHERE coupon_id=${row.id}::uuid AND user_id=${input.userId}::uuid`.execute(this.db);
```
What is wrong: Sequential per-coupon quota lookup, up to 100 queries per "available coupons" call.
Impact: Endpoint latency scales with the active coupon count.
Root cause: Convenience loop.
Recommended fix: One grouped query `WHERE (coupon_id,user_id) IN (SELECT id, ${userId} FROM coupons ...)`.
Related findings: —
Confidence: High

---

**ID: BUG-016**
Title: FraudReviewScanner opens one transaction per signal row (up to ~3,000 per pass)
Severity: Low
Category: A/F. Resource churn
Location: server/src/modules/compliance/infrastructure/fraud-review.ts:58-98
Evidence:
```ts
for (let index = 0; index < scans.length; index++) {
  const result = await scans[index]!.execute(this.db);
  for (const row of result.rows) await this.record(kinds[index]!, row.user_id, row.n);
}
// record(): db.transaction() with advisory lock + 2 SELECTs + INSERT + outbox event, per row
```
What is wrong: Up to 500 rows × 6 scans sequential transactions per 5-minute pass; correct (advisory-lock dedupe) but heavy.
Impact: Long scans hold pool connections and generate thousands of small commits; overlapping passes on multi-instance deployments duplicate the work harmlessly.
Root cause: Per-row record() convenience.
Recommended fix: Batch insert per scan kind; keep dedupe with `ON CONFLICT`-style guards.
Related findings: —
Confidence: High

---

**ID: BUG-017**
Title: Picking claim/start vs item actions take the same locks in opposite order (AB-BA deadlock, self-healing via retry)
Severity: Low
Category: B. Concurrency
Location: server/src/modules/picking/infrastructure/postgres-pick-tasks.ts:71-85 (lockTask: task advisory → orders FOR UPDATE) vs server/src/modules/picking/infrastructure/postgres-pick-actions.ts:67-100 (guard: orders FOR UPDATE → inventory advisory → rows → task advisory)
Evidence:
```ts
// lockTask (claim/start/reassign)
await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`picking-task:${taskId}`},0))`.execute(tx);
const order = await sql`SELECT on_hold FROM orders WHERE id=... FOR UPDATE`.execute(tx);
// guard (pick/short/substitute/complete)
const order = await sql`SELECT on_hold FROM orders WHERE id=... FOR UPDATE`.execute(tx);
...
await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`picking-task:${taskId}`},0))`.execute(tx);
```
What is wrong: Opposite acquisition order of the order row lock and the picking-task advisory lock can deadlock a claim racing an item action.
Impact: Both paths run in `transactionWithRetry`, which retries 40P01 with jitter (database.ts:162-181) — occasional failed-then-retried operations and warning noise, no corruption.
Root cause: The two paths were written with different lock strategies.
Recommended fix: Align `guard` to take the picking-task advisory lock first (or drop it from lockTask where the order lock suffices).
Related findings: —
Confidence: High

---

**ID: BUG-018**
Title: `dispatchDue`'s `FOR UPDATE SKIP LOCKED` claim is ineffective (autocommit releases locks immediately)
Severity: Low
Category: B. Concurrency (misleading guard)
Location: server/src/modules/dispatch/infrastructure/dispatch-engine.ts:118-123
Evidence:
```ts
const due = await sql<{ order_id: string }>`SELECT order_id FROM delivery_tasks
  WHERE status='UNASSIGNED' AND ... LIMIT ${limit}
  FOR UPDATE SKIP LOCKED`.execute(this.db);      // no transaction → locks released at statement end
```
What is wrong: The statement runs outside a transaction, so the row locks vanish when it returns; two concurrent sweeps can select the same task set. Harmless today because `dispatchOne` re-validates under `FOR UPDATE` inside its own transaction, but the clause suggests a claim it does not perform.
Impact: None today; future code relying on the apparent claim would race.
Root cause: Guard copied from transactional claim patterns.
Recommended fix: Remove the clause or wrap the claim in a transaction that spans the dispatch round.
Related findings: —
Confidence: High

---

### 9.1 Sweep-1 candidates investigated and dropped as non-defects (verified)

- Catalog suggest cache does not leak across users via any current HTTP path (BUG-014 documents the latent gap only).
- `manual-adjustment` read-modify-write is protected by the store_inventory `version` check (CONCURRENT_MODIFICATION).
- `codCollect`'s `dispatch_operations.result` column exists (migration 021).
- Coupon reserve/commit/release serialized by coupon-row `FOR UPDATE` with deterministic order.
- Erasure processor double-pick fenced by the 701002 advisory lock + status re-check.
- LocalStorage path regex blocks traversal; money math is integer paise everywhere except exact BigInt rounding helpers.

## 10. Subagent sweep 2 — surfaces / adapters / milk_app (all findings independently re-verified against the code by the auditor)

Coverage: all 52 surface controllers + DTO/view files read (pure `@Module`-wiring files swept by grep); all 23 adapters read with callers traced; milk_app fully reviewed (all `src/*`, all 5 stores, live screens, hooks; demo-only components verified dead). Trust-boundary sweep: every Nest controller carries `@AuthPolicy` + `IdentityGuard` except four deliberately unguarded dev/public routes, each verified fail-closed in production; Razorpay webhook HMAC verified timing-safe over exact raw bytes; no duplicate Swagger operationIds.

---

**ID: BUG-019**
Title: Wallet top-up replay returns HTTP 200 carrying a stored 503 error body
Severity: Medium
Category: H. Consistency (API contract) / D. Error handling
Location: server/src/surfaces/customer/wallet/wallet.controller.ts:108 and 125-133; server/src/common/idempotency/idempotency.ts:76-84
Evidence:
```ts
if (claim.kind === 'replay') return claim.body as unknown as WalletTopupIntent;   // claim.status discarded
...
if (code === 'ExternalServiceUnavailable' || code === 'ExternalServiceTimeout') {
  await this.idempotency.execute(claim.owner, async () => ({
    status: 503,
    body: { code: 'ExternalServiceUnavailable' } as unknown as Json,
  }))
```
What is wrong: On a gateway outage the controller deliberately persists the 503 response as the idempotent replay, but the replay branch returns only `claim.body` — the stored `status` is discarded, so Nest responds 200.
Impact / failure scenario: Client retries a failed top-up with the same Idempotency-Key → HTTP 200 whose body is `{ code: 'ExternalServiceUnavailable' }` (no `intentId`). A client treating 2xx as success misreports the failed top-up as succeeded. This is the only controller in the codebase that stores a non-200 idempotent response (checkout/cart/subscriptions `keyed` helpers store 200 only).
Root cause: Replay branch predates the store-the-503 behavior.
Recommended fix: In the replay branch, when `claim.status >= 400`, throw `new HttpException(claim.body, claim.status)`; otherwise return the body.
Related findings: BUG-002 (same store-response machinery, opposite direction)
Confidence: High

---

**ID: BUG-020**
Title: `IDEMPOTENCY_KEY_REQUIRED` can never reach a client; 7 throw sites in 2 different styles
Severity: Low
Category: H. Consistency (Problem+JSON contract)
Location: server/src/surfaces/customer/checkout/payments.controller.ts:50; server/src/surfaces/admin/orders/p6.module.ts:109; server/src/surfaces/admin/dispatch/p8.module.ts:66,79; server/src/surfaces/customer/privacy/p12.module.ts:69; server/src/surfaces/admin/reports/p12.module.ts:86; server/src/surfaces/store/dispatch/cash.controller.ts:39; server/src/common/http/problem-codes.ts (absent)
Evidence:
```ts
throw new HttpException('IDEMPOTENCY_KEY_REQUIRED', 400);            // 5 sites — string form
throw new HttpException({ code: 'IDEMPOTENCY_KEY_REQUIRED' }, 400);  // 2 sites — object form
```
What is wrong: The code is in neither `PROBLEM_CODES[400]` nor `DOMAIN_ERROR_STATUS`, so `ProblemFilter` falls back to `BAD_REQUEST` for both forms (the string form never carries a code at all). Clients cannot distinguish a missing idempotency key from any other 400, and the same condition is thrown as `INVALID_INPUT` elsewhere.
Impact: Client error handling cannot branch on the documented code; the Swagger Problem400 enum disagrees with real responses.
Root cause: The code was never registered in the allowlist, and two throw styles coexist.
Recommended fix: Add `IDEMPOTENCY_KEY_REQUIRED` to `PROBLEM_CODES[400]` and standardize the object-form throw at all 7 sites.
Related findings: —
Confidence: High

---

**ID: BUG-021**
Title: Checkout/subscription idempotency request hashes are not canonically normalized (inconsistent with cart/coupons)
Severity: Low
Category: H. Consistency / B. Idempotency correctness
Location: server/src/surfaces/customer/checkout/customer.controller.ts:152,138; server/src/surfaces/customer/subscriptions/subscriptions.controller.ts:95; server/src/surfaces/admin/subscriptions/subscriptions.controller.ts:67 — vs server/src/surfaces/customer/cart/customer.controller.ts:72-82,235
Evidence:
```ts
hashRequest(JSON.stringify(body)),                       // checkout/subscriptions — key-order sensitive
const hash = hashRequest(JSON.stringify([method, resource, canonical(input)]));  // cart — canonical
```
What is wrong: `JSON.stringify` preserves the client's JSON key order, so the same logical request re-serialized with reordered keys under the same Idempotency-Key hashes differently and hits `key_reused` (409) instead of replaying. A `canonical()` helper already exists in the cart controller (duplicated, not shared).
Impact: Non-app clients (proxies/retry wrappers with unordered JSON serialization) get spurious `409 IDEMPOTENCY_KEY_REUSED` on money-moving endpoints. The app's own client serializes deterministically, so today's impact is limited to third-party clients.
Root cause: The canonical helper was written per-controller instead of shared in `common/idempotency`.
Recommended fix: Move `canonical()` into `common/idempotency/idempotency.ts` and use it in all `keyed` implementations.
Related findings: —
Confidence: High

---

**ID: BUG-022**
Title: Per-IP rate limiter keyed on TCP peer address with no `trustProxy` configured
Severity: Low (Needs Verification — deployment-dependent)
Category: E. Security (rate limiting under proxying)
Location: server/src/bootstrap.ts:25-38 (adapter creation — no `trustProxy`), 102-117 (limiter keyed on `request.ip`)
Evidence:
```ts
const adapter = new FastifyAdapter({ loggerInstance: logger, bodyLimit: ..., requestTimeout: ..., ... });  // no trustProxy
...
const result = await checkRateLimit(redis, request.ip, `${audience}:${route.name}`, ipLimit);
```
What is wrong: Fastify defaults `trustProxy: false`, so `request.ip` is the socket peer. Behind any reverse proxy/LB, all clients share one IP and every per-IP limit collapses into one global bucket — most critically `RATE_LIMIT_AUTH_PER_MIN` (default 20/min) for `/…/auth|places` routes.
Impact / failure scenario: In a proxied deployment, 20 logins per minute globally → mass 429s; conversely a single abuser exhausts the shared bucket for everyone. Nothing in the repo (docs, Dockerfile, compose) establishes direct exposure, so this is deployment-dependent.
Root cause: Deployment topology not encoded in the app contract.
Recommended fix: Configure `trustProxy` explicitly (with a fixed proxy allowlist) or key the limiter on a validated forwarded-IP header, and document the expected topology in the runbook.
Related findings: BUG-007 (same limiter, dead webhook exemption)
Confidence: High on the code fact; Needs Verification on the production topology

---

**ID: BUG-023**
Title: Customer socket reconnects forever with a stale access token (client never refreshes credentials)
Severity: Low
Category: G. Frontend specifics (socket lifecycle)
Location: milk_app/app/(tabs)/my-dairy.tsx:38-48 (client); server/src/platform/realtime/realtime.ts:66-89,133-142 (server behavior, correct)
Evidence:
```ts
void accessToken().then(token => {
  socket = io(`${apiBaseUrl()}/customer`, { auth: { token }, transports:['websocket'], reconnection:true });
```
What is wrong: The token is captured once when the effect runs. After the access token expires (~1h), the server force-disconnects (expiry timer) and every subsequent handshake re-presents the same expired token and is rejected; socket.io's default reconnection retries indefinitely.
Impact / failure scenario: Live order tracking silently degrades to the 30s polling fallback after an hour, and the sheet generates a steady failed-handshake loop until closed. No data exposure (the server correctly rejects); availability/UX only.
Root cause: `auth` passed as a static object instead of socket.io's per-attempt `auth` callback.
Recommended fix: `auth: (cb) => accessToken().then(t => cb({ token: t }))` so each attempt uses a fresh token; cap reconnection attempts while the view is inactive.
Related findings: —
Confidence: High

---

### 10.1 Sweep-2 candidates investigated and dropped as non-defects (verified)

18 candidates were traced and dismissed, including: DTO fields validated server-side (media `contentType`/`size`); page limits rejected in `decodePage`; concurrent duplicate `place` blocked by intent consumption + advisory locks; dev routes fail closed in production; Razorpay webhook HMAC timing-safe over exact raw bytes; FCM calls wrapped in `withTimeout`; local-storage file keys adapter-generated UUIDs; demo-only stores/components dead with no live importers; `x-request-id` reflection sanitized; push listener registration race-free. (Sweep 2 also flagged the checkout/wallet 30s idempotency lease as self-healing and dismissed it — the auditor keeps it as BUG-002 Medium because the dismissed self-heal still surfaces a 500 to the first client after a successful placement.)
