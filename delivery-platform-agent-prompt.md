# DELIVERY PLATFORM — MASTER BUILD PROMPT FOR THE CODING AGENT

> Give this whole file to the agent as its task prompt. Keywords MUST / MUST NOT / SHOULD are binding.
> Version 1.0 · Target: hyperlocal quick-commerce backend (Instamart / Blinkit / BigBasket style) with Country Delight style subscriptions.

---

## 0. How this document is organised

| Part | Sections | Purpose |
|---|---|---|
| A | 1–4 | Who you are, how to work, what to build, fixed technical decisions |
| B | 5–9 | Architecture, repo layout, configuration, conventions |
| C | 10–12 | Data model and state machines |
| D | 13–25 | Feature modules with business rules and edge cases |
| E | 26–31 | Security, reliability, observability, testing, docs |
| F | 32–34 | Delivery phases, definition of done, consolidated edge-case checklist |

Read everything once before writing code. Then execute phase by phase (Section 32).

---

## 1. Your role

Operate as a **principal engineer with 20+ years of experience** building high-scale delivery and marketplace platforms (Swiggy, Zomato, Uber, Ola class systems). That means:

- You design for **correctness under concurrency first**, then performance, then elegance.
- You assume every network call can fail, every webhook can arrive twice or out of order, every client can retry, every clock can drift, every rider can lose signal, and every user can click twice.
- You prefer **boring, proven patterns** (modular monolith, state machines, outbox, idempotency keys, row-level locking) over clever ones.
- You write code that a new engineer can read, extend and safely change in a week: **modular, explicit, small, documented, tested**.
- You never silently guess. When something is ambiguous you **decide, write the decision down (Section 3), and continue.**

---

## 2. Mission and scope

### 2.1 What you are building

A production-grade **backend** (HTTP API + background workers + realtime gateway) for a hyperlocal delivery platform that serves:

- **Quick-commerce**: groceries and daily essentials fulfilled from **dark stores** within a delivery zone, target delivery in minutes.
- **Subscriptions**: recurring scheduled deliveries (milk, bread, eggs, etc.), paid from a wallet.

### 2.2 Actors and client surfaces

One codebase exposes **four surfaces**, each with its own routes, DTOs, guards and rate limits:

| Surface | Users | Prefix | Auth pool |
|---|---|---|---|
| `customer` | Customers | `/v1/customer` | Customer pool |
| `rider` | Delivery partners | `/v1/rider` | Workforce pool |
| `store` | Pickers, store managers | `/v1/store` | Workforce pool |
| `admin` | Admins, support agents | `/v1/admin` | Workforce pool |

System actors: scheduler (cron jobs), payment gateway (webhooks), outbox relay, notification workers.

### 2.3 In scope

Everything in Sections 13–25, plus tests, migrations, seeds, Docker, CI, OpenAPI and documentation.

### 2.4 Out of scope (do NOT build)

- Mobile apps and web frontends (you only produce the API contract: OpenAPI + WebSocket event spec).
- Provisioning AWS resources (the owner does this). You build against **ports** with local adapters (Section 7).
- Restaurant/food marketplace flows (menus, prep-time, merchant onboarding). **Design for extension**: keep `store` and `catalog` generic, but do not build restaurant features.
- ML models. Use rule-based v1 for ETA, ranking and dispatch, behind interfaces so ML can replace them later.
- Phone/SMS OTP login. **Login is email + password only** (Cognito). Keep an `SmsPort` with a disabled adapter for future use.

### 2.5 Design scale (design for it, do not over-build for it)

Single city at launch. Design assumptions: 50k orders/day, 5k concurrently online riders, one location update per rider every 5 seconds (~1k writes/s), catalog of 20k SKUs per store, 100 stores. Everything must be **horizontally scalable at the application layer** (stateless processes, state in Postgres/Redis).

---

## 3. Operating rules (read carefully)

1. **Work autonomously. Do not ask the owner questions.** If something is unspecified, choose the most conventional, safest option, record it in `docs/DECISIONS/NNNN-title.md` (ADR: context, decision, consequences) and move on.
2. **Environment variables will be provided later.** Develop and finish the *complete application now* without any real credentials:
   - Create `.env.example` containing **every** variable (Section 8) with values `PLACEHOLDER` or sane local defaults.
   - The app MUST boot and pass all tests locally with only `docker compose up` and `pnpm start:dev`, using **local/fake adapters** selected by env flags.
   - Real adapters (Cognito, S3, SES, FCM, Razorpay, Ola Maps) MUST be **fully implemented** against their official SDKs/APIs and activate only when their env vars are set. Unit-test them with mocks/LocalStack/fixtures.
   - In `NODE_ENV=production` the app MUST **fail fast at boot** if any required variable is missing, still `PLACEHOLDER`, or if a fake adapter is selected.
3. **Never hardcode** secrets, URLs, IDs, thresholds or business numbers. Business numbers live in `app_config` (Section 24.4) with typed accessors.
4. **No TODOs that break a flow.** A stub means a fully working fake adapter with the same interface, not a `throw new Error('not implemented')`.
5. **Do not invent third-party API details.** Implement from official documentation. Where you cannot verify an endpoint or field, make it configurable, isolate it in one adapter file, add a contract test with a recorded fixture, and mark the line `// VERIFY-AGAINST-DOCS`. List every such line in `docs/HANDOFF.md`.
6. **Small, reviewable commits.** Conventional Commits (`feat(orders): ...`). Commit after each vertical slice. Each phase ends green: lint, typecheck, unit, integration tests.
7. **Files stay small** (aim < 300 lines), functions short, one responsibility each, names explicit (`reserveStockForOrder`, not `process`).
8. **New dependencies need a reason** in an ADR. Prefer the standard library and already-chosen libraries.
9. **Update `docs/PROGRESS.md` after every phase** (done, in progress, assumptions, known gaps).
10. **At the very end produce `docs/HANDOFF.md`**: env vars needed per real adapter, AWS resources the owner must create, `VERIFY-AGAINST-DOCS` list, manual steps, known limitations.

---

## 4. Fixed technical decisions (do not re-litigate; deviate only via ADR with strong reason)

| Concern | Decision |
|---|---|
| Language/runtime | TypeScript (`strict`, `noUncheckedIndexedAccess`), Node.js latest Active LTS (pin in `.nvmrc` and `engines`) |
| Framework | NestJS (latest stable major) with the **Fastify** adapter |
| Package manager | pnpm |
| Database | PostgreSQL 16+ with **PostGIS**, `pg_trgm`, `pgcrypto` extensions |
| DB access | **Kysely** (typed SQL builder) + plain SQL migrations (`node-pg-migrate`). No heavy ORM. Raw SQL via Kysely `sql` tag for PostGIS and locking |
| Cache / queue / pubsub | Redis 7+: BullMQ (jobs and cron), cache, rate limits, Socket.IO adapter, rider GEO index |
| Auth | Amazon Cognito (email + password). Backend only **verifies** JWTs (`aws-jwt-verify`) and manages users via admin APIs |
| Realtime | Socket.IO with `@socket.io/redis-adapter` |
| Payments | Razorpay behind `PaymentGatewayPort` (Cashfree-ready), plus fake gateway |
| Maps | Ola Maps behind `MapsPort`, plus fake (haversine) adapter |
| Push | Firebase Cloud Messaging (`firebase-admin`) behind `PushPort` |
| Email | SES behind `EmailPort`, SMTP (Mailpit) locally |
| Object storage | S3 (presigned POST/PUT) behind `StoragePort`, LocalStack/disk locally |
| Search | Postgres FTS + `pg_trgm` behind `SearchPort` (OpenSearch/Typesense later) |
| Validation | `class-validator` + `class-transformer` for DTOs; `zod` for env and config |
| API docs | `@nestjs/swagger` → OpenAPI 3.1 per surface |
| Logging | `pino` JSON logs with correlation IDs and redaction |
| Metrics/tracing | Prometheus-format `/metrics`; OpenTelemetry hooks (no-op unless configured) |
| Tests | Jest, supertest, **Testcontainers** (Postgres+PostGIS, Redis), k6 for load scripts |
| Quality | ESLint + `eslint-plugin-boundaries` (or dependency-cruiser), Prettier, strict TS, Husky + lint-staged |
| Containers | Multi-stage Dockerfile (non-root, one image for all roles), `docker-compose.yml` for local |
| CI | GitHub Actions: install, lint, typecheck, unit, integration (Testcontainers), build image |
| IDs | UUIDv7 (time-sortable) generated in app; human-facing `order_number` separate |
| Money | Integer **paise** (`bigint`), fields suffixed `_paise`, currency fixed `INR`. Never floats |
| Time | `timestamptz` UTC in DB. Business timezone `Asia/Kolkata` for cutoffs and schedules. Inject a `Clock`; never call `new Date()` in domain code |
| Style | Conventional Commits, ADRs in `docs/DECISIONS`, OpenAPI as the API source of truth |

---

## 5. Architecture: modular monolith with hard boundaries

### 5.1 Principles

- **One deployable image, many runtime roles.** `APP_ROLE` ∈ `all | customer | rider | store | admin | worker`. `main.ts` boots only the modules for that role. Local dev uses `all`. Later each role can be its own service with **zero code change**.
- **Domain modules own their data and rules.** Surfaces are thin: they authenticate, authorise, validate, call module use-cases, and shape the response. **A controller MUST NOT contain business logic and MUST NOT be shared between audiences.**
- **Ports and adapters.** Every external dependency (auth, payments, maps, storage, email, push, sms, search, clock, id generator) is an interface (port) with a real adapter and a fake/local adapter, chosen at boot by config.
- **Dependency rule.** `domain` ← `application` ← `infrastructure`/`surfaces`. Domain code is pure TypeScript: no Nest, no Kysely, no I/O. State machines and pricing math live here and are unit-tested exhaustively.
- **Modules talk only through each other's `contracts/`** (exported interfaces, DTO types, domain events). No importing another module's repositories or internals. Enforce with lint boundaries; CI fails on violations.
- **Cross-module side effects go through domain events + transactional outbox** (5.4), not direct calls, unless a synchronous answer is required (then call the other module's contract interface).

### 5.2 Module anatomy (every module follows this exactly)

```
modules/<name>/
  contracts/        # public: interfaces, types, events, tokens (the ONLY importable folder from outside)
  domain/           # entities, value objects, state machine, pure functions, domain errors
  application/      # use-cases (commands/queries), orchestration, transaction boundaries
  infrastructure/   # repositories (Kysely), mappers, adapters specific to this module
  <name>.module.ts
  README.md         # 10-20 lines: purpose, invariants, events emitted/consumed, edge cases
```

### 5.3 Repository layout

```
delivery-platform/
├─ README.md
├─ .env.example
├─ docker-compose.yml            # postgres+postgis, redis, localstack(s3,ses), mailpit
├─ Dockerfile
├─ docs/
│  ├─ ARCHITECTURE.md  DOMAIN.md  API.md  REALTIME.md  RUNBOOK.md
│  ├─ EDGE_CASES.md  PROGRESS.md  HANDOFF.md
│  └─ DECISIONS/0001-*.md
├─ db/
│  ├─ migrations/*.sql           # forward-only, numbered, reviewed
│  └─ seeds/                     # dev seed: city, stores, zones, catalog, users per role
├─ src/
│  ├─ main.ts                    # role-based bootstrap
│  ├─ app-roles/                 # all.module.ts customer.module.ts rider.module.ts store.module.ts admin.module.ts worker.module.ts
│  ├─ config/                    # env.schema.ts (zod), config.module.ts, app-config (DB-backed typed settings)
│  ├─ common/                    # errors, http (filters, interceptors, pagination), idempotency, money, time(Clock), geo, ids, logging, security, testing utils
│  ├─ platform/                  # database, redis, queue, outbox, events, realtime, health, metrics
│  ├─ adapters/
│  │  ├─ auth/{cognito,local-dev}   payments/{razorpay,fake}   maps/{ola,fake}
│  │  ├─ storage/{s3,local}         email/{ses,smtp}           push/{fcm,fake}
│  │  └─ sms/{disabled}             search/{postgres}
│  ├─ modules/
│  │  identity  addresses  stores  serviceability  catalog  pricing  inventory
│  │  cart  coupons  wallet  checkout  orders  payments  invoicing  picking
│  │  dispatch  riders  tracking  earnings  subscriptions  notifications
│  │  support  ratings  audit  app-config  compliance
│  └─ surfaces/{customer,rider,store,admin}/   # controllers, dto, guards, gateways per audience
└─ test/{unit-helpers,integration,concurrency,e2e,load}
```

### 5.4 Cross-cutting platform primitives (build in Phase 0, reuse everywhere)

1. **Transaction helper** `withTransaction(fn)` giving use-cases a transaction-scoped DB handle. Repositories accept it explicitly.
2. **Transactional outbox**: table `outbox_events(id, aggregate_type, aggregate_id, event_type, payload, created_at, published_at, attempts)`. Domain events are inserted **in the same DB transaction** as the state change. A relay (worker role) polls with `FOR UPDATE SKIP LOCKED`, publishes to BullMQ, marks published. Consumers are **idempotent** via `processed_events(consumer, event_id)` unique key.
3. **Idempotency**: `Idempotency-Key` header on every mutating customer/rider/store endpoint with money or stock effects. Table `idempotency_keys(key, actor_id, route, request_hash, response_status, response_body, locked_at, expires_at)`. Same key + same hash → replay stored response; same key + different hash → `409 IDEMPOTENCY_KEY_REUSED`; in-flight → `409 REQUEST_IN_PROGRESS`.
4. **Optimistic concurrency**: aggregates have `version int`; updates use `WHERE id=$1 AND version=$2`; zero rows → `409 CONCURRENT_MODIFICATION`.
5. **Pessimistic locks** where invariants demand it: `SELECT … FOR UPDATE` (inventory rows, wallet account, order during transitions), `FOR UPDATE SKIP LOCKED` (work queues: outbox, dispatch, schedulers). **Always lock rows in a deterministic order** (sorted by id) to prevent deadlocks. Retry on serialization/deadlock errors with jittered backoff (max 3).
6. **State machine kit**: a tiny reusable class where each transition declares `from`, `to`, allowed actors, guard, side-effect events. Illegal transitions throw `ILLEGAL_STATE_TRANSITION`. Every transition writes a `*_status_history` row (who, when, why, metadata).
7. **Job framework**: BullMQ queues per concern (`outbox`, `notifications`, `dispatch`, `payments`, `subscriptions`, `imports`, `maintenance`), retries with exponential backoff + jitter, dead-letter handling with an admin-visible failed-jobs list, cron via BullMQ job schedulers in `Asia/Kolkata`.
8. **Clock, IdGenerator, Random ports** so time, IDs and randomness are injectable and testable.

---

## 6. Runtime roles and bootstrap

| `APP_ROLE` | Loads | Notes |
|---|---|---|
| `customer` | customer surface + needed modules | HTTP, read-heavy |
| `rider` | rider surface + dispatch/tracking | HTTP + Socket.IO, write-heavy location ingest |
| `store` | store surface | HTTP |
| `admin` | admin surface | HTTP, strictest guards |
| `worker` | outbox relay, queues, cron | No HTTP except `/healthz` |
| `all` | everything | Local dev and first deploy |

Rules: a role MUST NOT expose another audience's routes. Health endpoints `/healthz` (liveness) and `/readyz` (DB, Redis, queue reachable) on every role. Graceful shutdown (SIGTERM): stop accepting traffic, drain in-flight requests and jobs (timeout from config), close DB/Redis, then exit.

---

## 7. Ports and adapters (complete list)

| Port | Methods (minimum) | Real adapter | Local/fake adapter |
|---|---|---|---|
| `AuthVerifierPort` | `verify(token, surface)` → `{sub, groups, clientId, ...}` | Cognito JWKS via `aws-jwt-verify` (one verifier per pool/client) | `local-dev` HS256 tokens signed with `LOCAL_JWT_SECRET`; `/dev/auth/token` endpoint (disabled in prod) |
| `IdentityAdminPort` | `createUser, addToGroup, removeFromGroup, disableUser, enableUser, resetPassword, deleteUser, getUser` | Cognito admin APIs | In-memory/DB-backed fake |
| `PaymentGatewayPort` | `createOrder, verifyCheckoutSignature, verifyWebhook(rawBody, headers), fetchPayment, refund, fetchSettlements` | Razorpay | Fake gateway with controllable outcomes and a simulated webhook sender |
| `MapsPort` | `autocomplete, geocode, reverseGeocode, directions, distanceMatrix` | Ola Maps | Haversine + average-speed fake |
| `StoragePort` | `createUploadTarget(constraints), getReadUrl, delete, head` | S3 presigned POST | Local disk or LocalStack S3 |
| `EmailPort` | `send(template, to, data)` | SES | SMTP to Mailpit / console |
| `PushPort` | `send(tokens[], payload)` → per-token results | FCM | Console + in-memory log |
| `SmsPort` | `send(to, template, data)` | none (disabled adapter that throws `FEATURE_DISABLED`) | same |
| `SearchPort` | `indexProduct, searchProducts, suggest` | Postgres FTS/trigram | same |
| `Clock`, `IdGenerator` | `now()`, `newId()` | system | controllable in tests |

Rules: adapters contain **no business logic**; they translate to/from the port's types and map vendor errors to typed errors (`ExternalServiceUnavailable`, `ExternalServiceRejected`, `ExternalServiceTimeout`). Every adapter call has a **timeout, bounded retries with jitter (only for idempotent calls), and a circuit breaker**. Never log secrets or full PII.

### 7.1 Ola Maps adapter notes
Base URL, API key and all endpoint paths come from env/config. Implement autocomplete, geocode, reverse-geocode, directions and distance matrix per Ola's current official docs and mark any uncertain path `VERIFY-AGAINST-DOCS`. **Cost control is a hard requirement**: cache geocodes (Redis, long TTL, normalised key), debounce is the client's job but enforce server-side rate limits on autocomplete, never call Directions/Matrix per GPS ping, and never send a large origins×destinations matrix (pairs are billed): pre-filter with PostGIS and request only the top-K candidates (K from config, default 5).

### 7.2 Razorpay adapter notes
Amounts in paise. Verify checkout signature as HMAC-SHA256 of `razorpay_order_id|razorpay_payment_id` with the key secret (constant-time compare). Verify webhooks as HMAC-SHA256 over the **raw request body** with the webhook secret, from the `X-Razorpay-Signature` header. Therefore Fastify MUST expose the raw body for the webhook route only. Dedupe webhooks by event id. Mark uncertain fields `VERIFY-AGAINST-DOCS`.

### 7.3 Cognito adapter notes
Clients sign up/sign in directly with Cognito and send the **access token** as `Authorization: Bearer`. The backend verifies: signature (JWKS cached), `iss`, `exp`, `token_use=access`, and `client_id` ∈ allowed app clients **for that surface**. Roles come from the `cognito:groups` claim and are mapped to internal roles. A customer-pool token MUST be rejected on rider/store/admin surfaces and vice versa. Email/name are not in access tokens, so a one-time `POST /v1/customer/auth/bootstrap` accepts the **ID token** to create/sync the local profile (verify it the same way, `token_use=id`). Workforce users are created by admins through `IdentityAdminPort` (self-signup disabled) and get a local profile at the same time.

### 7.4 Local development without any real credentials
`AUTH_PROVIDER=local`, `PAYMENTS_PROVIDER=fake`, `MAPS_PROVIDER=fake`, `STORAGE_PROVIDER=local`, `EMAIL_PROVIDER=smtp`, `PUSH_PROVIDER=fake`. A startup guard refuses `*_PROVIDER` fake/local values when `NODE_ENV=production`. The seed script creates one user per role with known dev tokens printed to the console.

---

## 8. Configuration and environment contract

All config is read once at boot, validated with **zod** in `config/env.schema.ts`, and exposed through a typed `ConfigService`. Unknown required variable → boot fails with a clear list of what is missing. Provide `.env.example` with exactly these keys (values `PLACEHOLDER` unless a local default is shown).

```dotenv
# ── Core ─────────────────────────────────────────
NODE_ENV=development
APP_ROLE=all
PORT=3000
LOG_LEVEL=info
APP_BASE_URL=http://localhost:3000
CORS_ALLOWED_ORIGINS=http://localhost:5173
SHUTDOWN_TIMEOUT_MS=15000
BUSINESS_TIMEZONE=Asia/Kolkata

# ── Provider switches (fake/local forbidden when NODE_ENV=production) ──
AUTH_PROVIDER=local            # local | cognito
PAYMENTS_PROVIDER=fake         # fake | razorpay
MAPS_PROVIDER=fake             # fake | ola
STORAGE_PROVIDER=local         # local | s3
EMAIL_PROVIDER=smtp            # smtp | ses
PUSH_PROVIDER=fake             # fake | fcm

# ── Data stores ──────────────────────────────────
DATABASE_URL=postgres://app:app@localhost:5432/delivery
DATABASE_POOL_MAX=20
DATABASE_STATEMENT_TIMEOUT_MS=10000
REDIS_URL=redis://localhost:6379

# ── Auth ─────────────────────────────────────────
LOCAL_JWT_SECRET=local-dev-only-change-me
AWS_REGION=ap-south-1
COGNITO_CUSTOMER_POOL_ID=PLACEHOLDER
COGNITO_CUSTOMER_CLIENT_ID=PLACEHOLDER
COGNITO_WORKFORCE_POOL_ID=PLACEHOLDER
COGNITO_RIDER_CLIENT_ID=PLACEHOLDER
COGNITO_STORE_CLIENT_ID=PLACEHOLDER
COGNITO_ADMIN_CLIENT_ID=PLACEHOLDER

# ── Storage / email / push ───────────────────────
S3_MEDIA_BUCKET=PLACEHOLDER
S3_PRIVATE_BUCKET=PLACEHOLDER          # KYC docs, invoices
S3_ENDPOINT=http://localhost:4566      # LocalStack only
CDN_BASE_URL=PLACEHOLDER
SES_FROM_ADDRESS=PLACEHOLDER
SMTP_URL=smtp://localhost:1025
FCM_SERVICE_ACCOUNT_JSON_SECRET=PLACEHOLDER

# ── Payments ─────────────────────────────────────
RAZORPAY_KEY_ID=PLACEHOLDER
RAZORPAY_KEY_SECRET=PLACEHOLDER
RAZORPAY_WEBHOOK_SECRET=PLACEHOLDER

# ── Maps ─────────────────────────────────────────
OLA_MAPS_API_KEY=PLACEHOLDER
OLA_MAPS_BASE_URL=PLACEHOLDER
MAPS_CACHE_TTL_SECONDS=2592000
MAPS_MATRIX_TOP_K=5

# ── Limits (defaults; DB app_config overrides at runtime) ──
RATE_LIMIT_DEFAULT_PER_MIN=120
RATE_LIMIT_AUTH_PER_MIN=20
RATE_LIMIT_LOCATION_PER_MIN=30
```

Rules:
- Secrets-like values are never logged; the config dump at boot shows only keys and `set/unset`.
- Business tunables (fees, thresholds, timeouts) are **not** env vars; they live in `app_config` (24.4) so admins can change them without redeploys.
- Every env var is documented in `docs/HANDOFF.md` with: purpose, who provides it, which AWS/third-party resource creates it.

---

## 9. API and code conventions

### 9.1 HTTP
- REST + JSON, versioned `/v1`, surface prefix, plural nouns, `kebab-case` paths, `camelCase` JSON, `snake_case` columns.
- **OpenAPI** generated per surface (`/v1/customer/docs`, etc.; docs disabled or auth-protected in production). Every DTO documented with examples. Every endpoint declares its error codes.
- **Errors**: RFC 7807 `application/problem+json`: `type`, `title`, `status`, `code` (stable machine code like `INVENTORY_INSUFFICIENT`), `detail`, `traceId`, optional `errors[]` (field-level). Never leak stack traces, SQL or vendor messages. Domain errors map to 4xx; unexpected errors to 500 with only `traceId`.
- **Pagination**: cursor-based (opaque base64 of `(sort_key, id)`), `limit` max 100, response `{ items, nextCursor }`. No offset pagination on large tables.
- **Idempotency** per 5.4 (header `Idempotency-Key`, 24h retention).
- **Request IDs**: accept/generate `X-Request-Id`, attach to every log line, return in response and in problem+json `traceId`.
- **Validation**: whitelist-only DTOs (`forbidNonWhitelisted`), strict types, max lengths on every string, bounded arrays, sane numeric ranges. Reject unknown fields.
- **Rate limits** per surface and per route class (auth/bootstrap, search/autocomplete, location ingest, payments), keyed by user id when authenticated else IP; Redis-backed; `429` with `Retry-After`.
- **Caching**: `ETag`/`If-None-Match` for catalog reads; `Cache-Control: no-store` on anything personal.
- **Localisation**: `Accept-Language` ∈ `en, hi, te` for notification templates and error `title`s; machine `code`s never translate.

### 9.2 Authentication and authorisation
- Guard stack per request: `AuthGuard` (verify token for this surface) → `ActiveAccountGuard` (account exists, not blocked/deleted; riders approved) → `RolesGuard` (RBAC) → **resource guards** (ownership/ABAC).
- Roles: `CUSTOMER`; `RIDER`; `PICKER`, `STORE_MANAGER`; `SUPPORT_AGENT`, `ADMIN`, `SUPER_ADMIN`.
- **ABAC**: store staff may only touch data of **stores they are assigned to**; a customer may only access their own resources (**always filter by owner in the query itself**, never fetch-then-check, to prevent IDOR); riders only their own tasks.
- Admin sensitive actions need elevated role and write to `audit_log`; selected actions are **maker-checker** (24.5).

### 9.3 Code style
- Use-cases are classes/functions named by intent, one public method, typed input/output. Controllers map DTO ↔ use-case input.
- No `any`. No `console.log`. No magic strings for statuses or error codes (enums/constants in `contracts`).
- Domain errors extend a base `DomainError(code, httpStatus)`; define them next to the rule that raises them.
- Public functions have TSDoc; module `README.md` stays current.

---

## 10. Data model (PostgreSQL)

General rules: UUIDv7 PKs; `created_at`, `updated_at` (trigger-maintained) on every table; `version` on aggregates; `CHECK` constraints for every invariant that can be expressed in SQL (non-negative quantities, valid enums, `reserved_qty <= on_hand_qty`); FKs everywhere with deliberate `ON DELETE`; **no hard deletes** for orders, payments, ledgers, audit; soft delete (`deleted_at`) only for catalog and user-owned convenience data; indexes justified in migration comments; enums as `text` + `CHECK` (easier to evolve) unless performance demands otherwise.

| Domain | Tables (key columns / constraints) |
|---|---|
| Identity | `users(id, cognito_sub UNIQUE, pool, email UNIQUE, name, status[active,blocked,deleted], locale)`, `user_roles(user_id, role)`, `customer_profiles`, `staff_profiles(user_id, employee_code)`, `store_staff(user_id, store_id, role)`, `consents(user_id, type, version, accepted_at, ip)` |
| Addresses | `addresses(id, user_id, label, line1, line2, landmark, pincode, location geography(Point), geocode_source, is_default, deleted_at)` |
| Stores/zones | `stores(id, code, name, legal_entity_id, gstin, fssai_no, location, status[online,paused,offline], accepts_cod, capacity_per_hour)`, `store_hours(store_id, dow, open, close)`, `store_holidays`, `delivery_zones(id, store_id, polygon geography(Polygon), priority, active)` (GiST on polygon), `legal_entities(gstin, state_code, address, invoice_prefix)` |
| Catalog | `categories(tree via parent_id)`, `brands`, `products(id, name, brand_id, category_id, hsn_code, gst_rate_bps, is_perishable, status)`, `variants(id, product_id, sku UNIQUE, barcode UNIQUE, unit_label, unit_qty, mrp_paise, max_per_order)`, `product_media`, `search_synonyms` |
| Pricing | `store_variant_prices(store_id, variant_id, selling_price_paise, valid_from, valid_to)` + `price_history`; **CHECK selling ≤ MRP** |
| Inventory | `store_inventory(store_id, variant_id, on_hand_qty, reserved_qty, reorder_level, bin_location, PK(store_id,variant_id), CHECK(on_hand_qty>=0 AND reserved_qty>=0 AND reserved_qty<=on_hand_qty))`, `inventory_batches(store_id, variant_id, batch_no, expiry_date, qty)`, `inventory_ledger(append-only: store_id, variant_id, delta, reason, ref_type, ref_id, balance_after)`, `stock_reservations(id, order_id, store_id, variant_id, qty, status[held,committed,released], expires_at)`, `goods_receipts`, `stock_adjustments(maker, checker, status)` |
| Cart | `carts(id, user_id UNIQUE active, store_id, address_id, version)`, `cart_items(cart_id, variant_id, qty)` |
| Promotions | `coupons(code UNIQUE, type[percent,flat,free_delivery], value, max_discount_paise, min_order_paise, per_user_limit, global_limit, valid_from/to, scope_json, stackable)`, `coupon_redemptions(coupon_id, user_id, order_id UNIQUE, status)` |
| Wallet | `wallet_accounts(user_id UNIQUE, cash_balance_paise, promo_balance_paise, CHECK >=0, version)`, `wallet_ledger(append-only: account_id, delta_paise, bucket[cash,promo], reason, ref_type, ref_id UNIQUE per (ref_type,ref_id,reason), balance_after)` |
| Orders | `orders(id, order_number UNIQUE, user_id, store_id, address_snapshot jsonb, status, payment_status, subtotal/discount/tax/delivery_fee/handling_fee/tip/total/wallet_used/amount_due (all *_paise), placed_at, expires_at, cancel_reason, cancelled_by, version)`, `order_items(order_id, variant_id, name_snapshot, qty, mrp_paise, unit_price_paise, discount_paise, tax_paise, hsn, gst_rate_bps, fulfilled_qty, status)`, `order_status_history`, `order_fee_breakdown`, `order_notes` |
| Payments | `payments(id, order_id, gateway, gateway_order_id UNIQUE, gateway_payment_id UNIQUE NULL, method, amount_paise, status, failure_code, captured_at)`, `payment_events(gateway_event_id UNIQUE, raw jsonb)`, `refunds(id, payment_id|wallet, order_id, amount_paise, status, reason, gateway_refund_id UNIQUE, initiated_by)`, `reconciliation_runs/items`, `cod_collections(order_id UNIQUE, rider_id, amount_paise, collected_at, settlement_id)`, `cod_settlements` |
| Invoicing | `invoice_sequences(legal_entity_id, fy, last_no)`, `invoices(id, order_id, invoice_no UNIQUE, type[tax_invoice,credit_note], payload jsonb, immutable)` |
| Picking | `pick_tasks(id, order_id, store_id, status, assigned_to, started_at, completed_at, sla_due_at)`, `pick_items(task_id, order_item_id, expected_qty, picked_qty, status[pending,picked,short,substituted], substitute_variant_id, batch_id)` |
| Dispatch | `delivery_tasks(id, order_id UNIQUE, store_id, status, rider_id, attempt_no, delivery_code_hash, pickup_at, delivered_at, pod_media_id, failure_reason, version)`, `rider_offers(id, task_id, rider_id, status[sent,accepted,declined,expired], sent_at, responded_at)`, `task_assignment_history` |
| Riders | `rider_profiles(user_id, status[pending,under_review,approved,rejected,suspended], vehicle_type, vehicle_no, home_store_id)`, `rider_documents(rider_id, type, media_id, status, reviewed_by)`, `rider_shifts(rider_id, started_at, ended_at, store_id)`, `rider_status(rider_id, online, last_seen_at, active_tasks)`, `rider_location_history(rider_id, ts, point)` **partitioned by day**, `rider_earnings(rider_id, task_id UNIQUE, base, distance, incentive, tip, total)`, `rider_payouts(...)` |
| Subscriptions | `subscription_plans`, `subscriptions(id, user_id, variant_id, qty, frequency_rule jsonb, start_date, end_date, slot, address_id, store_id, status[active,paused,cancelled], next_delivery_date)`, `subscription_skips(subscription_id, date)`, `subscription_pauses(from,to)`, `subscription_orders(subscription_id, delivery_date, order_id, status) UNIQUE(subscription_id, delivery_date)` |
| Notifications | `device_tokens(user_id, token UNIQUE, platform, app, last_seen_at, active)`, `notification_templates(key, locale, channel, subject, body)`, `notifications(id, user_id, channel, template_key, payload, status, dedupe_key UNIQUE, read_at)`, `notification_preferences` |
| Support/Ratings | `tickets(id, order_id, user_id, category, status, assignee)`, `ticket_messages`, `ratings(order_id, rater, target_type, target_id, stars, comment)` |
| Platform | `outbox_events`, `processed_events`, `idempotency_keys`, `audit_log(append-only)`, `app_config(key, value jsonb, schema, updated_by)`, `feature_flags`, `maker_checker_requests`, `import_jobs(type, status, file_media_id, report_media_id)` |

---

## 11. State machines (implement with the state machine kit; unit-test every legal and illegal transition)

### 11.1 Order (`orders.status`)
`PENDING_PAYMENT → CONFIRMED → PICKING → PACKED → OUT_FOR_DELIVERY → DELIVERED`
Terminal alternatives: `PAYMENT_FAILED`, `EXPIRED` (payment window elapsed), `CANCELLED`, `DELIVERY_FAILED` (→ `RETURNED_TO_STORE`).

| From | To | Actor | Guard / effect |
|---|---|---|---|
| (new) | PENDING_PAYMENT | customer | stock reserved, totals frozen, `expires_at` set |
| PENDING_PAYMENT | CONFIRMED | system (payment capture / COD / wallet-covers-all) | payment valid, reservation committed, pick task created, invoice drafted |
| PENDING_PAYMENT | PAYMENT_FAILED / EXPIRED | system | reservation released, coupon/wallet reverted |
| CONFIRMED | PICKING | picker | pick task started |
| PICKING | PACKED | picker | all items resolved (picked/short/substituted); totals re-computed if shorts |
| PACKED | OUT_FOR_DELIVERY | rider | store handover verified (code/QR) |
| OUT_FOR_DELIVERY | DELIVERED | rider | delivery code verified or admin override; COD collected if applicable |
| OUT_FOR_DELIVERY | DELIVERY_FAILED | rider/admin | reason required, evidence |
| any pre-pickup | CANCELLED | customer/admin/system | stage-based rules (Section 21) |

### 11.2 Payment (`payments.status`)
`INITIATED → CAPTURED | FAILED`; `CAPTURED → REFUND_PENDING → REFUNDED | PARTIALLY_REFUNDED`. COD path: `COD_PENDING → COD_COLLECTED → COD_SETTLED`. Order-level `payment_status` is derived: `UNPAID, PAID, PARTIALLY_REFUNDED, REFUNDED, COD_PENDING, COD_COLLECTED`.

### 11.3 Delivery task (`delivery_tasks.status`)
`UNASSIGNED → OFFERED → ASSIGNED → AT_STORE → PICKED_UP → ARRIVED → DELIVERED`; side exits `FAILED`, `CANCELLED`; `ASSIGNED/AT_STORE → UNASSIGNED` on rider drop/timeout (new `attempt_no`, history row).

### 11.4 Pick task (`PENDING → ASSIGNED → IN_PROGRESS → COMPLETED | CANCELLED`) and Subscription (`ACTIVE ⇄ PAUSED → CANCELLED`) and Rider profile (`PENDING → UNDER_REVIEW → APPROVED | REJECTED`, `APPROVED ⇄ SUSPENDED`).

---

## 12. System invariants (must always hold; each has a test, several have concurrency tests)

1. `0 ≤ reserved_qty ≤ on_hand_qty` for every stock row; **never oversell**.
2. Inventory ledger sums match `on_hand_qty`; wallet ledger sums match balances.
3. An order total equals the sum of its frozen line items, fees, taxes and discounts, **to the paisa**.
4. A payment is captured **at most once** per order for the same amount; a refund never exceeds captured minus already refunded.
5. A delivery task has **at most one active rider**; a rider has at most `max_concurrent_tasks` (config).
6. An order has at most one active delivery task and one pick task.
7. A coupon redemption count never exceeds its limits, even under concurrent checkouts.
8. Every state change has a history row and an outbox event in the same transaction.
9. Invoice numbers are gapless and unique per (legal entity, financial year); issued invoices are immutable (corrections are credit notes).
10. Subscription order generation is idempotent per `(subscription_id, delivery_date)`.

---

## 13. Identity and access module

**Endpoints**
- customer: `POST /auth/bootstrap` (ID token → create/sync profile, idempotent), `GET/PATCH /me`, `POST /me/consents`, `DELETE /me` (erasure request)
- rider: `POST /onboarding/profile`, `POST /onboarding/documents/upload-url`, `POST /onboarding/documents`, `GET /me`, `POST /status/online`, `POST /status/offline`
- store: `GET /me` (assigned stores and role)
- admin: list/search users, create workforce user (calls `IdentityAdminPort`), assign/remove roles and store assignments, block/unblock, force password reset, rider document review (approve/reject with reason)

**Rules and edge cases**
- Local profile is created just-in-time on `bootstrap`; bootstrap is idempotent; calling any other customer endpoint before it returns `403 PROFILE_NOT_INITIALIZED`.
- Customers must have `email_verified=true` to place orders.
- **Blocked/deleted user with a still-valid token**: `ActiveAccountGuard` checks status via a Redis cache (TTL ≤ 30 s), invalidated immediately on block/role change. Tokens remain cryptographically valid until expiry, so the guard is the enforcement point.
- Same email may exist in both pools; uniqueness is `(pool, email)`.
- Token edge cases to unit-test: expired, wrong `token_use`, wrong `client_id` for the surface, wrong issuer, tampered signature, missing `cognito:groups`, JWKS key rotation (refetch once on unknown `kid`), clock skew (60 s leeway), token for a user that no longer exists locally.
- **Workforce user creation is a saga**: create in Cognito → create local profile/roles in one DB transaction → on DB failure delete the Cognito user (compensate). Idempotent by email: re-running resumes rather than duplicates.
- An admin cannot disable themselves, cannot demote or delete the last `SUPER_ADMIN`, and every role/store-assignment change is audited.
- **Rider onboarding**: required document types come from `app_config` (e.g. licence, vehicle RC, ID proof, bank proof). Status flow in 11.4. A rider can go online only when `APPROVED`. Suspension while on a task triggers reassignment of active tasks (Section 23). Rejected riders can resubmit; every review stores reviewer and reason.
- KYC documents live in the **private bucket**; reviewers get short-lived signed read URLs; document URLs are never returned to other roles.
- **Account erasure (DPDP-style)**: refuse while the user has active orders or an active subscription (explain which); otherwise anonymise PII (name, email, phone, addresses, device tokens) but keep order/invoice/ledger rows (legal retention) pointing at the anonymised user; disable the Cognito user; wallet balance must be zero or refunded first (policy in `app_config`). Record consent and erasure events.
- Consents (terms, privacy) are versioned; endpoints that need consent return `403 CONSENT_REQUIRED` when the latest version isn't accepted.

---

## 14. Addresses, stores, zones and serviceability

**Endpoints**
- customer: `GET /places/autocomplete`, `GET /places/details`, `GET /places/reverse` (proxy `MapsPort`, rate-limited), `GET /serviceability?lat&lng`, address CRUD (`/addresses`)
- store: `POST /store/status` (online/paused with reason)
- admin: stores CRUD, hours/holidays, zone CRUD with validation, pause/resume store, capacity settings

**Rules and edge cases**
- **Serviceability is computed from PostGIS only, never from an external maps call**, so it keeps working when Ola is down. Algorithm: find active zones where `ST_Covers(polygon, point)`; if several, pick by `priority`, then nearest store (straight-line); then check store `status`, open hours (including overnight windows past midnight and holiday overrides in `Asia/Kolkata`), a "last order time" buffer before closing, and hourly capacity. Return `{serviceable, storeId, etaRange, reasons[]}` with reasons from a fixed enum: `OUTSIDE_ZONE, STORE_CLOSED, STORE_PAUSED, STORE_AT_CAPACITY, NO_RIDERS_AVAILABLE`.
- Points exactly on a zone boundary count as inside (`ST_Covers`). Cache zones in Redis with a version key invalidated on zone edits.
- **Zone validation** (admin): `ST_IsValid`, no self-intersection, minimum/maximum area from config, must be inside the store's city bounding box. Overlaps allowed only with explicit priority. Editing a zone never affects in-flight orders (they hold a snapshot).
- **Address validation**: 6-digit pincode, coordinates inside India's bounding box, required `contact_name` and `contact_phone` (E.164) per address (delivery needs a phone; login is email-only), landmark optional, max addresses per user from config (default 10), exactly one default (partial unique index), soft delete (an address used by an active order/subscription keeps working via snapshot). If the geocoded text address and the dropped pin differ by more than a configured distance, return `needsConfirmation=true`.
- **Contact privacy**: the customer's phone is exposed to the rider only while the delivery task is `ASSIGNED…ARRIVED`, via a rider-only endpoint, and hidden after delivery. Add a `CallMaskingPort` (disabled adapter now) so masked calling can replace raw numbers later.
- **Store auto-pause** when pick backlog exceeds a threshold or no riders are available for N minutes (config); manual pause requires a reason; pausing never cancels existing orders.
- **Address change after placing an order**: allowed only before `PICKING`, only if the new point is in the same zone and the delivery fee is unchanged; otherwise reject with `ADDRESS_CHANGE_NOT_ALLOWED` and suggest cancel/reorder.
- **Maps degraded mode**: if `MapsPort` fails, use cached geocodes or haversine estimates and flag the response `degraded=true`. Order placement must never be blocked by maps being down.

---

## 15. Catalog, search and media

**Endpoints**
- customer: `GET /catalog/home`, `GET /catalog/categories/:id/products`, `GET /catalog/products/:id`, `GET /search?q=`, `GET /search/suggest?q=`
- admin: categories/brands/products/variants CRUD, publish/unpublish, per-store price upsert, bulk import (CSV) with dry-run, media upload target + register, search synonyms

**Rules and edge cases**
- **Every customer catalog read is store-scoped** (store resolved from the selected address). A product appears only if the store has an inventory row **and** a valid price. Response includes price, MRP, discount %, availability (`IN_STOCK | LOW_STOCK | OUT_OF_STOCK`) and `maxPerOrder`; expose exact counts only when below the low-stock threshold ("Only N left").
- **Search**: normalise (lowercase, strip diacritics, collapse whitespace), expand synonyms (Hinglish/regional, e.g. `doodh → milk`, `atta → wheat flour`), then combine `tsvector` rank and `pg_trgm` similarity. Ranking: exact name > prefix > FTS > trigram; boost in-stock and popular items; out-of-stock last. Bound query length (e.g. ≤ 64), reject control characters, parameterise everything, cache `suggest` briefly, rate-limit both endpoints. Handle empty/whitespace/very short queries gracefully.
- **Publishing rules**: a product cannot be published without `hsn_code`, `gst_rate_bps`, at least one variant, one image, and `selling ≤ MRP` everywhere. Perishables require expiry tracking.
- Catalog entities with order history are **soft-deleted only**; barcodes and SKUs are unique.
- **Media upload** (no arbitrary URLs, to avoid SSRF): `createUploadTarget` returns a presigned POST with conditions (content-type ∈ jpeg/png/webp, max size, key prefix); `register` verifies the object exists (`head`), type and size match, then links it. Serve via CDN URL.
- **Bulk import** (async job): upload CSV to the private bucket → `import_jobs` row → worker streams and validates every row (unique SKU, MRP ≥ selling, allowed GST rate, category exists, UTF-8 with BOM handled, row and size limits) → `dryRun=true` returns a report without writing → real run upserts by SKU in batches (each batch transactional) → produces an error-report CSV. Re-running the same file is idempotent.
- **Bulk price updates** above a configured size or % change require maker-checker approval (24.5). Price history is kept; prices apply from `valid_from` and are read with `valid_from ≤ now < valid_to`.

---

## 16. Pricing engine, fees, taxes and invoicing

Implement `computeQuote(input): Quote` as a **pure, deterministic domain function** with exhaustive unit and property-based tests (totals always reconcile; no negative amounts; rounding never loses or creates paise).

**Pipeline**: (1) line subtotals from frozen unit prices → (2) coupon discount allocated pro-rata across eligible lines using the **largest-remainder method** so allocations sum exactly → (3) fees: delivery fee by distance/order-value slabs (config), free-delivery threshold, handling fee, small-cart fee, surge/rain fee (config flag, capped) → (4) tax → (5) tip (rider-only, never discounted or taxed) → (6) total → (7) wallet application → (8) `amount_due`.

**Tax**: product prices are **GST-inclusive**. Per line: `tax = round_half_up(taxableInclusive × rate / (10000 + rate))` in basis points, computed **after** discount allocation. Fee taxation rate and place-of-supply rules (CGST+SGST vs IGST based on store state vs delivery state) are **configuration, not code**. Flag clearly in `HANDOFF.md`: *tax treatment must be confirmed by a chartered accountant; rates and rules are configurable.*

**Rules and edge cases**
- A quote has `quoteId`, `priceVersion`, and an expiry; checkout compares the client's expected total with a fresh server quote. Mismatch → `409 PRICE_CHANGED` with the new quote (client must confirm).
- Enforce minimum order value, maximum order value and COD cap (config). A zero-total order (fully covered by coupon/wallet) skips the payment gateway.
- Coupon invalid at checkout time, item went out of stock, fee config changed, distance = 0, fractional paise, tip changes, shorts after picking (recompute and issue refund + credit note) must all be covered by tests.
- **Invoicing**: `invoice_sequences` row-locked increment per `(legal_entity, financial_year)`; **financial year April–March in IST**; gapless numbering with entity prefix. Tax invoice is issued when the order is `DELIVERED`, from **fulfilled** quantities and final amounts. Issued invoices are immutable; post-invoice refunds produce **credit notes** (same sequence rules). Invoice payload stored as JSON (store GSTIN, FSSAI number, HSN, tax split, MRP, selling price). Rendering is behind `InvoiceRendererPort` (HTML template now, PDF adapter later).

---

## 17. Inventory

**Endpoints**
- store: `GET /inventory` (search/barcode), `POST /inventory/receipts` (goods receipt with batch + expiry), `POST /inventory/adjustments`, `POST /inventory/cycle-counts`, `GET /inventory/low-stock`, `GET /inventory/expiring`
- admin: inventory reports, approve adjustments, stock-ledger viewer

**Rules and edge cases**
- `available = on_hand − reserved`. Quantities are **integers in the base unit** (e.g. grams, pieces, ml) for every variant including loose items (decide and record in an ADR).
- **Reservation** is a single atomic statement per row: `UPDATE store_inventory SET reserved_qty = reserved_qty + $q WHERE store_id=$s AND variant_id=$v AND on_hand_qty - reserved_qty >= $q` and check the row count. Multi-item reservations run in one transaction, **rows touched in sorted `variant_id` order** (deadlock avoidance), all-or-nothing, returning every shortfall `{variantId, requested, available}` in `409 INVENTORY_INSUFFICIENT`.
- Reservations have a TTL equal to the order payment window; a worker sweeps expired holds every minute (`SKIP LOCKED`, idempotent) and releases them. Reservation rows are unique by `(order_id, variant_id)` so retries never double-reserve.
- **At pick completion**: decrement `on_hand_qty` and `reserved_qty` by picked quantities, release the rest (shorts), write ledger rows. Ledger reasons: `RECEIPT, RESERVE_COMMIT_PICK, ADJUSTMENT, EXPIRY_WRITEOFF, DAMAGE, RETURN_TO_STOCK, CYCLE_COUNT`.
- **FEFO** for perishables: pick suggestions use the earliest-expiry batch first; never offer batches inside the minimum remaining shelf-life (config per category); a nightly job writes off expired batches.
- Returned-to-store items go back to stock only after picker QC marks them resellable; damaged goes to `DAMAGE`.
- Adjustments can't push `on_hand` below `reserved` (explicit error). Adjustments above a variance threshold require manager approval (maker-checker). Cycle counts compare system vs counted and create adjustments.
- Low-stock and expiry-soon events notify store managers; items at zero available show `OUT_OF_STOCK` automatically.
- **Mandatory concurrency tests**: 100 parallel reservations against stock of 10 → exactly 10 units reserved in total and zero negative rows; reserve/release/pick interleavings keep invariants.

---

## 18. Cart and coupons

**Cart endpoints (customer)**: `GET /cart`, `PUT /cart/items/:variantId` (absolute quantity, idempotent), `DELETE /cart/items/:variantId`, `DELETE /cart`, `POST /cart/coupon`, `DELETE /cart/coupon`, `POST /cart/validate` (returns quote + `issues[]`), `GET /coupons/available`.

**Cart rules and edge cases**
- One active cart per user, bound to the store of the selected address. **The cart never reserves stock.**
- Setting quantity is *absolute* (safe to retry); clamp to `maxPerOrder` and availability with explicit errors; `0` removes the line; max distinct lines (config, e.g. 50).
- **Switching address to a different store** re-evaluates the whole cart: unavailable items are *flagged*, not silently dropped; prices refresh; the client must confirm.
- Unpublished or out-of-stock lines are flagged in `issues[]` (`ITEM_UNAVAILABLE`, `PRICE_CHANGED`, `QTY_REDUCED`); cart carries a `version` for optimistic concurrency across two devices.
- Abandoned carts are cleaned up after a configured age.

**Coupon rules and edge cases**
- Types: percent (with max cap), flat, free-delivery. Constraints: min order, first-order-only (derived from completed orders, not a flag the client sends), per-user limit, global limit, validity window (IST), store/category/product scope, excluded items, stackability.
- Codes are trimmed and case-insensitive; validation attempts are rate-limited per user to stop code guessing.
- **Atomic redemption** under concurrency: `UPDATE coupons SET redeemed_count = redeemed_count + 1 WHERE id=$1 AND (global_limit IS NULL OR redeemed_count < global_limit)` plus a per-user count check inside the same transaction; redemption row `reserved` at order creation, `committed` at confirmation, `released` on failure/expiry/cancel (counter decremented). Tests: 50 parallel redemptions of a 10-use coupon → exactly 10 succeed.
- A coupon is re-validated on **every** quote, not only when applied.

---

## 19. Wallet (feature-flagged: `wallet_enabled`)

> Holding customer money in a wallet can be regulated in India (prepaid payment instruments). Keep this module behind the flag and list it in `HANDOFF.md` for legal review before enabling in production.

**Endpoints**: customer `GET /wallet`, `GET /wallet/ledger`, `POST /wallet/topups`; admin manual credit/debit (maker-checker) and ledger viewer.

**Rules and edge cases**
- Two buckets: **cash** (from top-ups/refunds) and **promo** (cashback). Spend order: promo first (subject to a per-order cap %), then cash. Record this in an ADR.
- Ledger is **append-only** with a unique key `(ref_type, ref_id, reason)` that gives natural idempotency. Balance changes happen in the same transaction as the ledger insert under a row lock on the account (+ `version`); `CHECK` constraints keep balances ≥ 0.
- Top-ups: create a gateway order → credit **only after a verified captured webhook** (never from the client callback). Min/max per transaction and per-month caps from config. Duplicate webhooks credit once.
- Wallet spend at checkout is a debit with reason `ORDER_PAYMENT`; it is **reversed** (`ORDER_PAYMENT_REVERSAL`) if the order fails, expires, or is cancelled. Partial wallet + gateway payments must reverse the wallet portion if the gateway portion fails.
- Edge cases: top-up webhook arrives after user abandoned the screen; top-up chargeback; concurrent spends from two devices (row lock serialises); refund destination choice (source vs wallet, config); promo expiry job; account deletion with balance (refund first); subscription auto-debit failures.

---

## 20. Checkout, payments and refunds

**Customer endpoints**: `POST /checkout/quote`, `POST /checkout/place` (requires `Idempotency-Key`), `POST /payments/:orderId/verify`, `POST /payments/:orderId/retry`, `GET /orders/:id/payment`. **Webhook**: `POST /v1/webhooks/payments/:gateway` (public, signature-verified). **Admin**: `POST /orders/:id/refunds`, reconciliation reports.

### 20.1 Place-order flow (never trust the client for prices or totals)
1. Idempotency check (5.4).
2. Load cart; **recompute the quote server-side**; compare with the client's `quoteId`/expected total; mismatch → `409 PRICE_CHANGED`.
3. Re-check serviceability (store open, zone, capacity), user not blocked, fraud/velocity limits (orders per hour per user and per device, from config).
4. **In one DB transaction**: reserve stock → reserve coupon redemption → debit wallet portion → insert order (`PENDING_PAYMENT`, `expires_at`) + items + fee breakdown + status history + outbox `ORDER_CREATED`.
5. **After commit** (never inside the DB transaction) call `PaymentGatewayPort.createOrder`. If it fails: keep the order `PENDING_PAYMENT`, return a retryable error; the client may call `/payments/:orderId/retry` until `expires_at`; the sweeper cleans up otherwise.
6. Response: order summary + payment intent (gateway order id, public key id, amount).

**COD**: allowed only if store `accepts_cod`, amount ≤ COD cap, user eligibility rules from config (e.g. minimum completed prepaid orders, not flagged), never for subscriptions. COD orders go straight to `CONFIRMED` with payment status `COD_PENDING`; the rider collects cash (Section 23).
**Zero `amount_due`** orders go straight to `CONFIRMED`.

### 20.2 Webhooks and payment confirmation
- Verify the signature over the **raw body**; persist the event first (unique `gateway_event_id`), return `200` quickly, process in a job.
- Handle `payment.captured`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`. Tolerate duplicates, out-of-order delivery, and "captured after failed" retries on the same gateway order.
- Map events to our payment by unique `gateway_order_id`. **Webhook-before-response race**: if the payment row isn't visible yet, retry the job with short backoff.
- Validate **amount and currency** equal what we expect; mismatch → mark `AMOUNT_MISMATCH`, do not confirm the order, alert admins.
- The client `verify` call only validates the signature as a hint and triggers a server-side `fetchPayment`; **the source of truth is the webhook or a server fetch**.
- A **poller job** checks gateway status for `PENDING_PAYMENT` orders nearing expiry (covers missed webhooks).
- **Late success** (captured after order `EXPIRED`/`CANCELLED`): default is auto-refund to the original method; optionally reinstate if stock is still available and `reinstate_expired_orders=true`. Log and notify either way.
- **Duplicate payments** (two gateway orders for one order): confirm on the first capture, auto-refund the second.
- **Refuse test-mode keys in production** (e.g. `rzp_test_` prefix) at boot.

### 20.3 Refunds
- Types: full, partial, item-level (shorts, damaged, missing), delivery-failed, goodwill (support). Destinations: original payment method (async state machine `REFUND_PENDING → REFUNDED/FAILED`) or wallet (instant).
- Compute max refundable under a row lock (`captured − already refunded`); idempotent by `(order_id, reason, item-set hash)`.
- Refund failures retry with backoff and alert; after N failures an admin can switch to wallet credit.
- Refund above a threshold or goodwill refunds beyond a per-agent limit require maker-checker. Every refund writes a credit note when an invoice exists.
- COD orders refund to wallet (or manual payout record).

### 20.4 Reconciliation (nightly worker)
Fetch gateway payments/refunds/settlements for the day, compare with `payments`/`refunds`, write `reconciliation_items` for mismatches (missing capture, missing refund, amount difference, orphan gateway payment). Admins review; **no automatic money fixes** except pre-approved safe cases.

### 20.5 Edge cases to cover with tests
Double-click and double-tab (idempotency); app killed after paying; webhook delayed or duplicated; user pays twice; gateway outage (circuit open → only COD/wallet offered with a clear message); partial wallet + gateway; payment succeeded but DB transaction failed (outbox/poller recovers); amount tampering by client; expired order paid late; refund exceeding captured; webhook replay with changed body; concurrent cancel and capture.

---

## 21. Orders and cancellations

**Customer endpoints**: `GET /orders`, `GET /orders/:id`, `GET /orders/:id/timeline`, `POST /orders/:id/cancel`, `POST /orders/:id/reorder`, `GET /orders/:id/invoice`, `POST /orders/:id/rate`, `GET /orders/:id/tracking`.
**Admin endpoints**: search orders, `POST /orders/:id/cancel`, `/hold`, `/reassign-rider`, `/refund`, `/force-state` (**SUPER_ADMIN only**, reason required, audited), full timeline with actors.

**Cancellation matrix** (defaults live in `app_config`; every cell is configurable):

| Stage | Customer | Admin | Effects |
|---|---|---|---|
| `PENDING_PAYMENT` | free, instant | yes | release stock, revert coupon/wallet |
| `CONFIRMED` (pick not started) | free | yes | release stock, revert coupon, refund per method |
| `PICKING` / `PACKED` | not allowed (contact support) | yes, with reason | restock path or write-off, refund, notify store |
| `OUT_FOR_DELIVERY` | not allowed | converts to delivery failure/RTO flow | rider instructions, RTO, refund policy |
System-initiated cancels: payment expiry, all items short, no rider found after N minutes (escalate to admin first, then auto-cancel + refund per config), store closed unexpectedly, fraud flag.

**Rules and edge cases**
- All order transitions run under `SELECT … FOR UPDATE` on the order row plus the state-machine guard; **cancel vs pick-complete vs payment-capture races** are serialised and the loser receives `409` with the current state. Cancelling an already cancelled order returns the current state (idempotent).
- Cancellation effects are one idempotent routine: cancel pick/delivery tasks, release reservations or restock, revert coupon and wallet, refund, notify, audit, emit events.
- If a rider was already assigned (not yet picked up): release the rider and pay a configured compensation.
- **Reorder** builds a new cart with current prices/availability and lists unavailable items; it never places an order.
- Delivery instructions: max length, sanitised, no contact data exposure beyond 14.
- Customer-visible statuses are friendly mappings of internal statuses; the timeline hides internal-only transitions.
- Rating is allowed once, only after `DELIVERED`, within a configured window.

---

## 22. Store operations (picking, packing, handover)

**Store endpoints**: `GET /orders`, `GET /pick-tasks` (queue), `POST /pick-tasks/:id/claim`, `/start`, `POST /pick-tasks/:id/items/:itemId/pick` (`scannedBarcode, qty, batchId`), `/short`, `/substitute`, `POST /pick-tasks/:id/complete`, `POST /orders/:id/pack` (`bags, sealCode`), `POST /orders/:id/handover` (`handoverCode`). Manager: reassign picker, SLA board, store KPIs, pause/resume store, staff list.

**Rules and edge cases**
- A pick task is created by an idempotent consumer of `ORDER_CONFIRMED` (unique per order).
- **Assignment**: pickers self-claim (`FOR UPDATE SKIP LOCKED`, so two pickers never claim the same task) or auto-assign round-robin among on-shift pickers; max active tasks per picker from config.
- The pick list is **sorted by `bin_location`** (walk order). Scanning a barcode that doesn't match the expected variant → `WRONG_ITEM`; picked qty may not exceed expected; FEFO batch suggestion shown for perishables; weight-based loose items accept a configured tolerance and re-price at pick if configured.
- **Short items**: reason required (`OUT_OF_STOCK, DAMAGED, EXPIRED, NOT_FOUND`) → inventory ledger entry (`DAMAGE`/`EXPIRY_WRITEOFF`, or a cycle-count flag for `NOT_FOUND`) → on completion the order totals are recomputed and a **partial refund + credit note** is triggered. All items short → system cancel.
- **Substitution** (v1, rule-based): only when `auto_substitution` is on and the candidate satisfies the rule (same brand family and size class, listed in `substitute_candidates`); the customer **never pays more than the original item's price** (cap enforced in code). No approval flow in v1; otherwise the item is treated as short.
- **Pack**: bag count, seal code, cold-chain flag; timestamps recorded. `sla_due_at` per task with breach events and a manager alert.
- **Handover to rider**: the rider shows a handover code/QR (generated when the rider is assigned); wrong code → `HANDOVER_CODE_INVALID` (attempt-limited); manager override requires a reason and is audited. If the rider hasn't arrived, the order waits in `PACKED` with a configurable "waiting too long" alert.
- Picker disconnects or shift ends mid-task → task returns to the pool with progress preserved; manager can reassign.
- Every pick/pack action is **idempotent** (double submit, duplicate scan).
- Store paused mid-task: in-flight orders continue. Anomaly report: pickers with unusually high short rates.
- Returned-to-store (RTO) intake: QC each item `RESELLABLE | DAMAGED` → inventory updated accordingly.

---

## 23. Dispatch, riders, tracking, ETA, earnings and COD

### 23.1 Rider endpoints and realtime
- HTTP: `POST /status/online|offline` (starts/ends a shift), `POST /heartbeat`, `POST /location` (batched points: `ts, lat, lng, accuracy, speed, isMock, battery`), `GET /offers` (poll fallback), `POST /offers/:id/accept|decline`, `GET /tasks/current`, `POST /tasks/:id/arrived-at-store`, `/picked-up` (`handoverCode`), `/arrived`, `/deliver` (`deliveryCode` or `podMediaId`), `/fail` (`reason, evidence`), `/cod-collect`, `GET /earnings`, `GET /cash-in-hand`.
- Socket.IO namespace `/rider`: `offer.created`, `offer.revoked`, `task.updated`, `task.cancelled`. Everything also works via polling so a socket drop never loses an offer.

### 23.2 Dispatch algorithm v1 (all weights/thresholds in `app_config`)
1. **Trigger** (config `dispatch_trigger`): `ON_PICK_START` (default, overlaps rider travel with picking using predicted pack time) or `ON_PACKED`. The delivery task is created `UNASSIGNED` at order confirmation.
2. **Candidates**: riders `APPROVED`, online, not on break, last location fresher than `rider_stale_location_seconds`, within radius R of the store (Redis `GEOSEARCH`), `active_tasks < rider_max_concurrent_tasks`, not in a decline cooldown for this task, cash-in-hand below limit when the order is COD.
3. **Scoring** as a pure domain function: ETA to store (matrix for the top-K by straight-line distance only; fall back to haversine), idle time (fairness), acceptance rate. Weights from config. Unit-test with fixed fixtures.
4. **Offer**: send to the best rider by push + socket with an accept window `T` seconds (config). On accept, assign with an **atomic conditional update** (`… WHERE id=$t AND status IN ('UNASSIGNED','OFFERED') AND rider_id IS NULL`) and a concurrency check under a lock on the rider's status row. On decline/expiry → next candidate. After `dispatch_max_attempts`, widen the radius by configured steps; then alert admins ("no rider available") and keep retrying with backoff until the auto-cancel threshold.
5. **Exactly-once assignment** is guaranteed by the atomic update; losers receive `OFFER_NO_LONGER_AVAILABLE`. Sequential offers are the default; optional broadcast-to-top-K mode.
6. Admin can manually assign/reassign; every reassignment writes `task_assignment_history`.

### 23.3 Rider edge cases (all need tests)
- Accept after offer expiry (reject); two riders accepting simultaneously (one wins); offer revoked because the order was cancelled (revoke over socket + push).
- Rider goes silent with an active task: no heartbeat for X s → `UNREACHABLE`; after Y minutes **before pickup** → unassign and re-dispatch (`attempt_no+1`); **after pickup** → never auto-reassign; escalate to admin.
- App crash/reinstall: `GET /tasks/current` fully restores state.
- Rider drops before pickup (config penalty) → re-dispatch. Rider suspended mid-task → tasks reassigned. Store paused/closed after assignment → hold or reassign per config.
- **Geofence checks** on `arrived-at-store` / `arrived`: if the reported GPS is farther than the configured distance, accept but **flag** (do not hard-block; GPS is noisy) and store the distance.
- **GPS integrity**: reject/flag `isMock=true`, impossible speeds/teleports, poor accuracy; dedupe points by `ts`; drop points older than the current stored one; cap batch size and payload bytes.
- **Delivery code**: 4 digits generated at confirmation; only an **HMAC hash** is stored; constant-time comparison; max attempts (e.g. 5) then require support/admin override; contactless drop allowed with a proof-of-delivery photo.
- **Customer unreachable / wrong address**: wait timer, contact attempts, then `FAILED` → return-to-store flow; rider can flag a wrong address and admin resolves (address correction or failure).
- Detention (long waits at store) and late-delivery compensation rules from config; rider detention is tracked from `arrived-at-store` to `picked-up`.

### 23.4 Location ingest and tracking
- Ingest path: validate → update Redis GEO index + per-rider hash (with TTL) → persist history to Postgres **only when ≥ 15 s or ≥ 50 m since the last stored point** (config) → publish to the order room if the rider has an active task. History table is **partitioned by day**; a maintenance job drops partitions older than the retention config.
- Customer namespace `/customer`: join `order:{id}` only if the user owns the order and it is active. Events: `order.status`, `rider.location` (throttled to ≥ 3 s, smoothed), `eta.updated`. **On connect, send a snapshot** (status, last location, ETA) so reconnects resume instantly. `GET /orders/:id/tracking` returns the same snapshot for polling fallback.
- Visibility rule: rider location is visible to the customer **only between `ASSIGNED` and `DELIVERED`**.
- Socket hygiene: auth at handshake (same verifier as HTTP), per-socket rate limits, ping/heartbeat, WebSocket transport preferred, room authorisation re-checked on join, disconnect cleanup, Redis adapter for multi-instance.

### 23.5 ETA (v1, behind `EtaProvider` interface)
`eta = remaining_prep + rider_to_store (if not picked up) + store_to_customer`. Travel time = haversine × road-factor ÷ average speed (config) or cached `MapsPort.directions` per task, refreshed at most every N minutes or on large deviation. Publish ETA as a **range** and only when it changes by ≥ 1 minute (anti-jitter); ETA never counts down below 1 minute until `ARRIVED`. ML can replace the provider later.

### 23.6 Earnings, COD cash and payouts
- Per-task earnings computed once at `DELIVERED` (unique per task): base + distance slab + detention + incentive/surge + tip ± adjustments; pure function with config; fully unit-tested.
- **COD**: rider records collected cash; amount must equal `amount_due` (mismatch flagged). Maintain a **cash-in-hand ledger** per rider; exceeding `cash_in_hand_limit_paise` blocks COD offers (and optionally going online) until deposit. Store managers record deposits (rider, amount, date) in `cod_settlements`; discrepancies are flagged for admin.
- **Payouts**: a weekly batch job aggregates earnings minus cash dues into `rider_payouts` (draft → approved by maker-checker → marked paid). Actual bank transfer sits behind a future `PayoutPort`; v1 is manual mark-paid.
- Shifts: rider auto-offline after inactivity; maximum continuous online hours per config for safety.

---

## 24. Platform services

### 24.1 Notifications
- Pipeline: domain event → notification use-case → template render (locale-aware, fallback `en`) → channel adapters (push, email, in-app inbox; SMS disabled) via BullMQ with retry + backoff + DLQ. Failures **never** affect order flow.
- **Dedupe** with unique `dedupe_key` such as `order:{id}:status:{status}`; transactional vs promotional categories (preferences and **quiet hours in IST** apply to promotional only).
- **Device tokens**: register/unregister/refresh; the same token moving to another user on login is reassigned; invalid-token errors from FCM deactivate the token; multicast in batches ≤ 500; per-token results recorded.
- Payloads carry IDs and deep links, not sensitive data. Rider offers use high-priority push.
- Minimum event matrix: order confirmed / packed / out for delivery / delivered / cancelled; payment failed; refund initiated/processed; item short/substituted; low wallet balance; subscription reminders and skips; rider offer; rider document approved/rejected; store: new order, low stock, expiring batch; admin: no riders available, reconciliation mismatch, failed jobs.
- Inbox endpoints: list (cursor), mark read, mark all read, unread count.

### 24.2 Support tickets
Customers/riders create tickets (category, optional order link, attachments via upload targets); statuses `OPEN → IN_PROGRESS → RESOLVED → CLOSED` (+ reopen window); assignment, internal notes, canned responses, SLA timers with breach alerts; tickets auto-created for failed deliveries and payment mismatches; creation rate-limited; refunds from tickets obey agent limits and maker-checker.

### 24.3 Ratings
Order, rider and product ratings (1–5, sanitised comment ≤ configured length); one per target per order; edit window; rider aggregate uses a minimum-count rule before display; low ratings auto-open a support ticket; ratings can't be created before `DELIVERED`.

### 24.4 `app_config` and feature flags
Typed catalogue in code: `{key, zodSchema, default, description, editableBy}`. Stored in DB, read through a cache (in-process TTL + Redis pub/sub invalidation), **every change audited**, admin endpoints validate against the schema. Mandatory keys include: `reservation_ttl_seconds`, `payment_window_seconds`, `delivery_fee_slabs`, `free_delivery_threshold_paise`, `handling_fee_paise`, `small_cart_threshold_paise`, `small_cart_fee_paise`, `surge_*`, `min_order_paise`, `max_order_paise`, `max_cod_paise`, `cod_eligibility`, `max_addresses`, `max_cart_lines`, `cancellation_matrix`, `dispatch_trigger`, `dispatch_radius_m` + widening steps, `offer_timeout_seconds`, `dispatch_max_attempts`, `rider_max_concurrent_tasks`, `rider_stale_location_seconds`, `cash_in_hand_limit_paise`, `rating_window_hours`, `low_stock_threshold`, `subscription_cutoff_time`, `subscription_generation_time`, `required_rider_documents`, `maker_checker_thresholds`, `data_retention_days`.
Feature flags: `wallet_enabled`, `cod_enabled`, `subscriptions_enabled`, `auto_substitution`, `reinstate_expired_orders`, `surge_enabled`.

### 24.5 Audit log and maker-checker
- `audit_log` is **append-only** (actor, role, action, entity, before/after diff, IP, request id); revoke `UPDATE/DELETE` on it from the application DB role in a migration.
- **Maker-checker**: a request is created by the maker; a *different* user with the required role approves within an expiry window; approval executes the same use-case as a direct action would. Required for: bulk price updates over threshold, stock adjustments over threshold, refunds over threshold, manual wallet credits/debits, admin role changes, rider payouts, `force-state`.

---

## 25. Subscriptions (Country Delight style)

**Customer endpoints**: `POST /subscriptions` (`variantId, qty, frequencyRule, startDate, slot, addressId`), `GET /subscriptions`, `GET/PATCH /subscriptions/:id` (quantity change), `POST /:id/pause` (`from, to`), `POST /:id/resume`, `POST /:id/skip` (`date`), `DELETE /:id/skip/:date`, `POST /:id/cancel`, `GET /:id/upcoming` (next N deliveries with status and amount), `GET /subscriptions/calendar?month=`.
**Admin**: manage subscribable products, delivery slots, holiday calendar, view/retry generation runs.

**Rules and edge cases**
- `frequencyRule` JSON: `DAILY | ALTERNATE_DAYS | WEEKDAYS(days[]) | EVERY_N_DAYS(n)`. Next-delivery computation is a **pure function** (test month ends, leap years, start dates after cutoff). All schedule logic uses **IST calendar dates** (`date`, not timestamps).
- **Cutoff**: changes/skips for the next day are accepted until `subscription_cutoff_time` (IST, e.g. 21:00 the previous day); later changes apply from the following delivery. Check the cutoff **inside the same transaction** that holds a row lock on the subscription so it can't race the generator.
- **Generation job** (worker, cron at `subscription_generation_time`): for each active subscription due the next day and not skipped/paused/holiday, create the order with `INSERT … ON CONFLICT (subscription_id, delivery_date) DO NOTHING`; batched with `SKIP LOCKED`, resumable after a crash, **failure-isolated per subscription**, partitioned by store for volume.
- **Payment**: wallet debit at generation (`ORDER_PAYMENT`, reversible). Insufficient balance → grace retry at a configured time; low-balance warnings before projected shortfall; if still short → mark `SKIPPED_INSUFFICIENT_BALANCE`, notify; after N consecutive failures auto-pause. Never go negative. No COD for subscriptions.
- **Stock shortage**: reserve at generation; if short at pick → `SKIPPED_OOS`, refund wallet, notify.
- **Price changes**: price is taken at generation; notify on increases above a configured %.
- **Address/zone problems**: zone no longer serviceable or address removed → auto-pause + notify; resume requires a valid address.
- **Holidays/store closed**: skip with notification; optionally extend the end date (config).
- Orders carry `source=SUBSCRIPTION` and a morning slot; dispatch trigger is scheduled from slot start minus lead time; pick tasks are prioritised by slot.
- **Cancel/pause/resume**: cancellation is immediate for future dates and refunds already-generated future orders before cutoff; pause dates validated (not in the past, max pause length from config); `endDate` reached → `COMPLETED`.
- Edge cases to test: start today after cutoff → first delivery tomorrow; quantity change vs already-generated order; modify-vs-generator race; user deletion; job crash and rerun (no duplicates); thousands of subscriptions per store.

---

## 26. Security requirements

- **Authorisation on every route**: authenticated, role-checked, and resource-scoped. Filter by owner/store **inside the SQL query** (prevents IDOR). Write a test per endpoint proving another user's resource returns `404` (not `403`, to avoid leaking existence) and a wrong-role token returns `403`.
- **Input**: whitelist DTOs, length/range limits, strict enums, reject unknown fields, parameterised SQL only (Kysely), no string-built queries, sanitise free text stored for display (support messages, comments, delivery instructions).
- **Transport/headers**: `helmet` equivalents, strict CORS allowlist from env, HSTS at the edge, no wildcard origins in production, body size limits per route, request timeouts.
- **Secrets and PII**: secrets only via env/secret store; pino **redaction** for `authorization`, tokens, emails, phones, addresses, delivery codes, webhook bodies; never log full payment payloads; encrypt sensitive fields at rest where noted (delivery code stored only as HMAC).
- **Abuse controls**: per-route Redis rate limits (Section 9), velocity limits on orders/coupon attempts/ticket creation, account lockout is Cognito's job but bootstrap and auth-adjacent endpoints are throttled.
- **Webhooks**: signature verification on the raw body, constant-time compare, replay protection (event id dedupe), IP allowlisting hook (config, off by default).
- **Uploads**: presigned POST with content-type and size conditions, private bucket for KYC/invoices, short-lived signed URLs, never fetch user-supplied URLs (SSRF).
- **Admin hardening**: separate pool/clients, MFA enforced in Cognito, optional IP allowlist hook, every sensitive action audited, maker-checker where defined, `force-state` limited to `SUPER_ADMIN`.
- **Dependencies/supply chain**: lockfile committed, `pnpm audit` in CI (fail on high), Dependabot/Renovate config, no postinstall scripts from unknown packages, minimal Docker image, non-root user, read-only filesystem where possible.
- **Privacy (DPDP-style)**: consent records, data export and erasure flows (Section 13), retention windows from `app_config` (location history, notifications, idempotency keys, logs), PII minimisation in push/email, purpose limitation documented in `docs/DOMAIN.md`.
- **Fraud signals v1** (rule-based, logged and adjustable): many failed payments, many cancellations, COD refusals, coupon hoarding, impossible rider GPS, picker short-rate anomalies. Flags surface to admins; they do not silently block users.

---

## 27. Reliability patterns

- **Timeouts everywhere**: HTTP clients, DB statements (`statement_timeout`), Redis commands, jobs. Nothing waits forever.
- **Retries** only for idempotent operations, exponential backoff **with jitter**, bounded attempts. Non-idempotent external calls (create payment order, refund) use vendor idempotency keys where available, else a local dedupe record.
- **Circuit breakers** around every external adapter with sensible half-open probing; when open, return typed errors and degrade (Section 14 maps; Section 20 payments).
- **Outbox + idempotent consumers** for all cross-module effects; failed jobs go to DLQ with an admin endpoint to inspect and replay.
- **Never call external services inside a DB transaction.** Transaction → commit → external call → compensating transaction if needed (saga). Keep transactions short.
- **Graceful degradation**: search falls back to simple prefix query; maps falls back to haversine; push/email failures don't block orders; Redis outage → cart/catalog reads still work from Postgres (slower), rate limiting fails **open** with an alert, location ingest returns `503` with `Retry-After`.
- **Graceful shutdown** and readiness probes (Section 6). A pod being killed mid-job must not lose or duplicate work: jobs are acknowledged after completion, handlers idempotent.
- **Time**: all schedulers and cutoffs use the injected `Clock` and `BUSINESS_TIMEZONE`; every cron is idempotent and safe to run twice or late.
- **Backpressure**: bounded queue concurrency per queue, per-rider location ingest limits, max Socket.IO connections per user, request size caps.
- **Data safety**: forward-only migrations, each tested against a copy of the previous schema; destructive changes done in expand/contract steps; documented rollback notes in each migration header.

---

## 28. Observability

- **Logs**: pino JSON; every line carries `requestId`, `userId` (hashed or id only), `surface`, `role`, `orderId`/`taskId` where relevant; levels used consistently; no PII (Section 26).
- **Metrics** (`/metrics`, Prometheus format): HTTP latency/error rate per route class, DB pool usage and slow queries, queue depth/latency/failures per queue, outbox lag, reservation conflicts, payment success rate, webhook lag, dispatch time-to-assign, offer accept/decline/expire rates, orders by status, picking SLA breaches, rider online count, socket connections, circuit-breaker state per adapter.
- **Tracing**: OpenTelemetry hooks (no-op without config) with spans around DB, Redis, adapters, and jobs; propagate `traceId` from HTTP into jobs via job metadata.
- **Business alerts** (emit as events + admin notifications): no riders available, outbox lag high, payment webhook failures, reconciliation mismatches, refund failures, DLQ growth, subscription generation incomplete, store capacity breaches.
- **Admin ops endpoints**: failed jobs list/replay, outbox stats, current config snapshot (no secrets), feature flags, reconciliation results.
- Write `docs/RUNBOOK.md`: for each alert, what it means, how to inspect, and how to remediate (replay a job, manually assign a rider, unstick an order via audited `force-state`, re-run reconciliation).

---

## 29. Performance and data management

- **Indexes**: define for every foreign key and every query path in a migration with a comment explaining the query it serves. GiST on geography columns; partial unique indexes for "one default"/"one active"; composite indexes matching keyset pagination `(sort_key, id)`; `pg_trgm` GIN on searchable names.
- **No N+1**: batch loaders or joins; add a test helper that fails when a request exceeds a query-count budget.
- **Caching** (explicit and invalidated): zones, store hours, app_config, catalog home per store (short TTL + ETag), geocodes (long TTL). Never cache per-user money/stock state beyond a few seconds.
- **Connection pooling**: `DATABASE_POOL_MAX` per process; code is PgBouncer-compatible (no session-level state, no advisory locks held across requests without care).
- **Hot paths** to optimise and load-test: `GET /catalog/*`, `/search`, `POST /checkout/place`, `POST /rider/location`, dispatch candidate query, order status transitions.
- **Partitioning/retention**: `rider_location_history` partitioned daily; maintenance jobs create future partitions and drop expired ones; `idempotency_keys`, `processed_events`, old notifications and soft-deleted rows purged per `data_retention_days`.
- **Pagination everywhere** on list endpoints; bounded `IN` lists; streaming for CSV exports (never load full tables in memory).
- **Reports/exports** run as async jobs writing to the private bucket with signed URLs; large queries use read-only transactions and statement timeouts.

---

## 30. Testing strategy (tests are part of the deliverable, not an afterthought)

| Layer | What | Tooling |
|---|---|---|
| Unit | State machines (every legal + illegal transition), pricing/tax/rounding (property-based with `fast-check`), subscription date maths, dispatch scoring, earnings, ETA, coupon rules | Jest |
| Integration | Each module against real Postgres+PostGIS and Redis; repositories, SQL locking, outbox relay, jobs | Jest + Testcontainers |
| API/contract | Every endpoint: happy path, validation errors, auth (no token, wrong pool, wrong role, other user's resource), idempotency replay, pagination; OpenAPI snapshot test to catch accidental contract changes | supertest |
| Concurrency | Parallel reservations, coupon redemption, wallet spends, dispatch accept races, cancel-vs-capture, duplicate webhooks, double checkout | Jest with `Promise.all` against real DB |
| Adapter contract | Real adapters with recorded fixtures/mocks (Razorpay signatures and webhook payloads, Cognito JWT verification with generated keys, Ola responses, FCM errors, S3 presign conditions); fakes pass the same contract tests | Jest, LocalStack |
| E2E journeys | Customer places and pays → store picks/packs → rider assigned/delivers → invoice + earnings; cancel journeys; failed delivery journey; subscription day journey | scripted API tests |
| Load | k6 scripts for catalog, search, checkout, rider location ingest, socket fan-out; documented target numbers and results | k6 |
| Migration | Apply all migrations to an empty DB and to a seeded previous-version DB | CI job |

Rules: deterministic tests (injected `Clock`, seeded randomness); no sleeping (poll with timeouts); every bug fixed gets a regression test; coverage gate (≥ 85% lines on `domain/` and `application/`, enforced in CI); **the concurrency and idempotency suites must pass on every PR**.

---

## 31. Documentation, tooling and delivery artefacts

- `README.md`: 10-minute quickstart (`pnpm i`, `docker compose up -d`, `pnpm migrate`, `pnpm seed`, `pnpm start:dev`), role/env explanation, how to get dev tokens for each role, how to run tests.
- `docs/ARCHITECTURE.md` (diagrams as Mermaid: context, module map, order sequence, payment webhook sequence, dispatch sequence), `DOMAIN.md` (glossary, rules), `API.md` (conventions, error code catalogue), `REALTIME.md` (every socket event with payload schema), `EDGE_CASES.md` (Section 34 with links to the tests that cover each), `RUNBOOK.md`, `DECISIONS/`, `PROGRESS.md`, `HANDOFF.md`.
- Scripts: `pnpm dev|build|lint|typecheck|test|test:int|test:conc|migrate|migrate:down|seed|openapi:export|k6:*`.
- **Dockerfile**: multi-stage, pinned base image, non-root, one image for all `APP_ROLE`s, healthcheck. **docker-compose**: Postgres+PostGIS, Redis, LocalStack (S3, SES), Mailpit, with volumes and healthchecks.
- **CI** (GitHub Actions): install with cache → lint → typecheck → unit → integration/concurrency (Testcontainers) → migration check → build image → export OpenAPI as an artefact.
- **Seeds**: one city, 3 stores with zones, ~200 products with variants/prices/stock/batches, one user per role (with printed dev tokens), sample coupons, sample subscription.

---

## 32. Delivery phases (execute in order; each ends green and committed)

Each phase: build → test → document → update `PROGRESS.md` → commit. Do not start a phase while the previous one has failing tests.

| Phase | Scope | Acceptance criteria |
|---|---|---|
| **P0 Foundation** | Repo, tooling, config/env validation, Kysely + migrations, Redis, logging, error filter, health, idempotency, outbox + relay, state machine kit, Clock/Id ports, Docker, CI, test harness | App boots in every `APP_ROLE`; `/readyz` works; outbox relay delivers; CI green |
| **P1 Identity & surfaces** | Auth ports (local-dev + Cognito), guards stack, user/role/store-staff models, surface skeletons, audit log, `app_config` + flags, workforce user saga | Per-surface auth tests (wrong pool/role/client), blocked-user test, audit entries |
| **P2 Stores & serviceability** | Stores, hours, holidays, zones, addresses, `MapsPort` (fake + Ola), places proxy, serviceability | Boundary-point tests, overnight hours, maps-down degraded mode |
| **P3 Catalog & search** | Catalog entities, store prices, media upload, search (FTS+trigram+synonyms), CSV import | Dry-run import report, search ranking tests, publish rules |
| **P4 Inventory** | Inventory, reservations + sweeper, receipts, adjustments, batches/FEFO, ledger | **100-parallel reservation test passes**, ledger = on_hand invariant |
| **P5 Cart, pricing, coupons** | Cart, pricing engine, tax, coupons with atomic redemption | Property tests for totals; 50-parallel coupon test |
| **P6 Wallet, checkout, payments, orders** | Wallet, checkout flow, Razorpay + fake gateway, webhooks, refunds, order state machine, cancellations, invoicing, reconciliation | Duplicate/out-of-order webhook tests, late-capture refund, cancel-vs-capture race, invoice gapless test |
| **P7 Store operations** | Pick tasks, scanning, shorts/substitution, packing, handover, SLA timers | Claim race test, short → partial refund + credit note |
| **P8 Dispatch, riders, tracking** | Rider onboarding/shifts, dispatch v1, offers, atomic assignment, location ingest, sockets, ETA, delivery completion, COD, earnings | Accept-race test, unreachable rider flows, snapshot-on-reconnect test |
| **P9 Notifications** | Templates, FCM/email/in-app, device tokens, dedupe, preferences, event matrix | Dedupe test, invalid-token cleanup, locale fallback |
| **P10 Subscriptions** | Plans, schedule maths, generation job, wallet debit, skips/pauses, cutoff handling | Crash-and-rerun idempotency, cutoff race test |
| **P11 Support, ratings, payouts** | Tickets, ratings, rider payouts, maker-checker flows | Maker-checker approval/expiry tests |
| **P12 Admin completeness** | All admin endpoints, reports/exports, ops endpoints (failed jobs, outbox, config) | Every admin action audited; permission matrix test |
| **P13 Hardening** | Security review checklist, load tests, edge-case audit against Section 34, docs, `HANDOFF.md` | All checklist items mapped to tests; load results documented; no `PLACEHOLDER` needed to run locally |

---

## 33. Definition of Done (whole project)

1. `docker compose up -d && pnpm migrate && pnpm seed && pnpm start:dev` yields a working system with **no real credentials**, and the full E2E journey passes against local/fake adapters.
2. All invariants in Section 12 are enforced in code **and** covered by tests (concurrency tests included).
3. Every endpoint in Sections 13–25 exists, is documented in OpenAPI, validated, authorised, rate-limited, and tested.
4. Module boundaries are enforced by lint in CI; no module imports another's internals.
5. Real adapters (Cognito, S3, SES, FCM, Razorpay, Ola Maps) are implemented, unit/contract-tested, and switchable by env; production boot **fails fast** on missing/placeholder/fake configuration.
6. No business constant is hardcoded; `app_config` keys documented with defaults.
7. `docs/HANDOFF.md` lists: required env vars per adapter and where each comes from, AWS resources the owner must create (Cognito pools/clients/groups, S3 buckets, SES identity, Secrets, RDS with PostGIS, ElastiCache, ECS roles), every `VERIFY-AGAINST-DOCS` item, legal/tax review items (GST rules, wallet regulation, DPDP, FSSAI/Legal Metrology display, e-commerce rules), and known limitations.
8. Lint, typecheck, unit, integration, concurrency, migration checks all green in CI; coverage gate met.

---

## 34. Consolidated edge-case checklist (each item must map to a named test; track in `docs/EDGE_CASES.md`)

**Concurrency and consistency**
- [ ] Two users buy the last unit simultaneously → exactly one succeeds
- [ ] Same user double-taps "Place order" / retries after timeout → one order (idempotency)
- [ ] Cancel and payment-capture arrive together → serialised, consistent final state
- [ ] Cancel and pick-complete race; cancel and rider pickup race
- [ ] Two riders accept one offer; rider accepts after expiry
- [ ] Modify subscription vs generation job race
- [ ] Concurrent wallet spends from two devices; coupon over-redemption
- [ ] Deadlock on multi-item reservation (sorted lock order) and automatic retry
- [ ] Outbox relay crash after publish before mark-published (consumer idempotency)
- [ ] Optimistic-lock conflicts return `409 CONCURRENT_MODIFICATION`

**Payments and money**
- [ ] Webhook duplicate / out-of-order / delayed / missing (poller recovers)
- [ ] Webhook arrives before the create-order response is persisted
- [ ] Amount or currency mismatch; tampered client amount; replayed webhook with changed body
- [ ] Payment captured after order expired/cancelled → refund or reinstate per config
- [ ] User pays twice for one order → second auto-refunded
- [ ] Gateway outage / timeout on create-order and on refund
- [ ] Refund exceeding captured; repeated refund requests; refund failure retries
- [ ] Partial wallet + gateway, reversal on failure
- [ ] Zero-total order; COD over cap; COD ineligible; COD amount mismatch
- [ ] Rounding: discount allocation sums exact; GST per line; credit note after shorts
- [ ] Test-mode keys refused in production

**Inventory and catalog**
- [ ] Reservation expiry sweep releases stock; late payment after sweep
- [ ] Shortage at pick; all items short; damaged/expired batches; FEFO order
- [ ] Item unpublished or price changed while in cart → flagged, never silently altered at payment
- [ ] Store switch on address change re-evaluates cart
- [ ] Import: duplicate SKUs, bad GST, BOM/encoding, huge file, re-run idempotency

**Serviceability and addresses**
- [ ] Point on zone boundary; overlapping zones with priority; zone edited mid-order
- [ ] Store overnight hours, holiday, last-order buffer, capacity limit, auto-pause
- [ ] Maps provider down; geocode vs pin mismatch; address change after placing order
- [ ] Missing contact phone; phone visibility window for riders

**Dispatch and delivery**
- [ ] No rider available (radius widening, admin alert, auto-cancel threshold)
- [ ] Rider silent before vs after pickup; app crash/reinstall resume; rider suspended mid-task
- [ ] Mock GPS, teleport, stale or out-of-order points, oversized batches
- [ ] Wrong handover code; wrong delivery code attempts limit; contactless proof-of-delivery
- [ ] Customer unreachable / wrong address / failed delivery → RTO → QC → restock
- [ ] Cash-in-hand limit blocks COD offers; settlement discrepancies

**Realtime and notifications**
- [ ] Socket reconnect resumes via snapshot; unauthorised room join rejected; location visible only in the allowed window
- [ ] Duplicate notification suppressed; invalid FCM token cleanup; locale fallback; promotional quiet hours
- [ ] Notification failure never breaks order flow

**Identity and security**
- [ ] Expired / wrong-pool / wrong-client / tampered tokens; JWKS rotation; clock skew
- [ ] Blocked user with valid token; role removed mid-session
- [ ] IDOR attempts on every resource type; wrong-role access on every surface
- [ ] Workforce user saga failure and compensation; last SUPER_ADMIN protection
- [ ] Erasure blocked by active order/subscription; anonymisation keeps legal records
- [ ] Rate limit and abuse scenarios (coupon guessing, search spam, location flooding)

**Time and scheduling**
- [ ] Cutoff boundaries (21:00 IST exact second), financial-year rollover (31 Mar → 1 Apr) for invoice sequences
- [ ] Cron run twice / late / crashed midway (idempotent)
- [ ] Month-end, leap-year schedule maths; start date after cutoff
- [ ] Clock skew between app instances (single source: DB time or injected Clock for critical decisions)

**Operations**
- [ ] Graceful shutdown mid-job; DLQ replay; migration applied on live data
- [ ] Redis outage degraded behaviour; Postgres failover reconnect; adapter circuit breaker open/half-open
- [ ] Config change takes effect without redeploy and is audited

---

### Final instruction to the agent

Build it phase by phase, keep every module small and boring and well-tested, record decisions as you go, and finish with `docs/HANDOFF.md`. When something is unclear, **decide, document, and keep moving** — the owner will supply real environment values later, and the system must already be complete and correct without them.
