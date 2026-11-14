# Delivery platform backend

NestJS/Fastify backend for hyperlocal groceries and scheduled subscriptions, implemented from [the master specification](delivery-platform-agent-prompt.md). The working tree integrates P0–P12, including purchasing, delivery, subscriptions, support, payouts and compliance operations. [Progress](docs/PROGRESS.md) records phase acceptance, test evidence and the remaining P13 work.

Read [the implementation plan](docs/IMPLEMENTATION_PLAN.md), [current progress](docs/PROGRESS.md), and [edge-case register](docs/EDGE_CASES.md) before making changes.

For the configured AWS-backed development environment, follow [the AWS development guide](docs/local-aws-development.md). It uses the existing AWS services and does not require Docker.

## Local setup

Run backend commands from the `server/` directory. From the repository root, first run `cd server`.

For the separate container-based local environment below, prerequisites are Node **26.13.0**, pnpm **12.18.0**, Docker with Compose, and a working Docker daemon for Testcontainers. Versions are pinned in `.nvmrc` and `package.json`.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d --wait
pnpm migrate
pnpm seed
pnpm start:dev
```

Local provider switches in `.env.example` select local authentication, fake maps/payments/push, local storage and Mailpit SMTP. They require no real AWS, map, or payment credentials. Local KYC and catalog uploads work without S3 credentials. Payment and notification workflows use the selected local providers; credentialed provider activation remains separate.

For S3 development storage, configure separate `S3_MEDIA_BUCKET` and `S3_PRIVATE_BUCKET` values and select `STORAGE_PROVIDER=s3`. `AWS_S3_PROFILE` optionally selects a dedicated AWS profile; otherwise the standard AWS credential chain is used. With no development CDN URL, registered product images are served by `/media/:id`. Upload targets contain a URL and form fields: submit every returned field and the file as a multipart POST to the URL. Signed upload and download values are temporary credentials and must not be logged. The local seed writes local image files and is blocked while S3 storage is selected.

Services bind to loopback: PostgreSQL/PostGIS on 5432, Redis on 6379, LocalStack on 4566, SMTP on 1025, and Mailpit's inbox at [localhost:8025](http://localhost:8025). The example environment selects port 13080 for the application; without a `PORT` setting, its fallback is 3000. Operational metrics require `Authorization: Bearer <METRICS_BEARER_TOKEN>` and return 404 when the token is unset. Do not put this token in client applications.

The development command compiles with TypeScript before restarting Node, preserving Nest's decorator metadata. Migration and seed scripts read `.env`. Do not point development seeds, down migrations, or test helpers at a production database.

## Runtime roles and contracts

Set `APP_ROLE=all|customer|rider|store|admin|worker`. `all` runs the local combination. Audience roles expose their own `/v1/<audience>` routes; worker exposes operational HTTP endpoints only. All roles have `/healthz` and dependency-aware `/readyz`. Production documentation is disabled; local docs are at `/v1/customer/docs`, `/v1/rider/docs`, `/v1/store/docs`, and `/v1/admin/docs` for the enabled audiences.

```bash
pnpm build
pnpm openapi:export
```

The export command validates four OpenAPI 3.1 documents under `openapi/`. [Operation and requirement manifests](docs/manifests/) distinguish planned, implemented, and verified work. An implemented operation has code; it is not automatically accepted as complete.

Money values use integer paise internally and decimal strings in JSON. Domain decisions receive an injected time; expiry/cutoff decisions sample the database clock after locking. Read the [durability decision](docs/DECISIONS/0002-durable-effects-and-idempotency.md) before changing retries, outbox delivery, or idempotency.

## Development identity

Authentication is email/password through Cognito in production. The backend verifies access tokens; customer `/auth/bootstrap` verifies an ID token. Customer and workforce identities can use separate pools or a shared pool, but their app-client audiences remain separate. The current AWS development configuration uses a shared pool.

The supported roles are `CUSTOMER`, `RIDER`, `STORE_MANAGER`, `SUPPORT_AGENT`, and `SUPER_ADMIN`. An account has one database role and one matching Cognito application group. `ADMIN` has been merged into `SUPER_ADMIN`; `PICKER` duties belong to assigned store managers. A person who needs a different role must be explicitly converted, not assigned both roles. Confirmed accounts can appear temporarily in Cognito Users before group synchronization, but protected APIs reject a missing, conflicting or stale group. See [group synchronization and recovery](infra/customer-group/README.md).

Verified self-signup riders call `POST /v1/rider/auth/bootstrap` with a rider-client ID token. This creates a pending workforce profile and queues a `RIDER` group grant for the identity worker. Matching is by verified pool subject, not email; conflicting workforce identities require manual review. The worker's Cognito principal needs `AdminAddUserToGroup` for the workforce pool, and the rider must refresh its token after synchronization. The pending role allows onboarding only: operational APIs and rider realtime require an approved profile.

Rider applicants select a store and submit their documents. A `STORE_MANAGER` assigned to that store reviews them through the store portal or `/v1/store/rider-applications` and `/v1/store/rider-documents` endpoints; every required document must be approved. A super-admin may see the application list, but document decisions belong to the assigned store manager. Store managers also pick and pack orders. See [partner setup and review steps](../delivery_partner_app/README.md#applications-and-reviews) and [the store portal](store_manager_web/README.md).

P1 supplies the local seed identities and development token endpoint. `/dev/auth/token` is restricted to a local provider outside production; it is unavailable with Cognito or in production. The CLI syntax for an existing local identity is:

```bash
pnpm devtokens CUSTOMER <seeded-subject> customer id
pnpm devtokens CUSTOMER <seeded-subject> customer access
pnpm devtokens WORKFORCE <seeded-subject> admin access
```

The seed command reports available development identities. Bootstrap the customer with the ID token before using its access token. No real user's credentials are stored in these fixtures. Local tokens are not accepted as Cognito tokens.

## Catalog and stock

Seeds create 200 products/variants, three-store assortment and prices, and an actual local image. The first store receives 20 units per variant through the inventory receipt service, with batch/ledger records. Other stores start at zero. Repeating the seed preserves edited catalog records and does not duplicate receipt quantities.

Create/select a customer address before reading `/v1/customer/catalog/home`, category/products, `/search` or `/search/suggest`. An optional `addressId` must belong to that customer. Responses use eligible store stock and current prices; exact quantities are disclosed only below the configured low-stock threshold. Use the returned ETag with `If-None-Match` for revalidation.

Administrative catalog/media/import endpoints live under `/v1/admin/catalog`. Request an owner-bound upload target, upload bytes using the returned capability, then register the object. Product images require `productId`; import CSV objects remain private. Local uploads use PUT `/dev/catalog-media/:id` with the returned authorization field and `application/octet-stream`; S3 uses the returned presigned multipart POST fields.

CSV imports require these headers (UTF-8 BOM is accepted):

```csv
sku,barcode,product_name,variant_name,category_id,hsn_code,gst_rate_bps,perishable,expiry_tracking,selling_paise,mrp_paise
LOCAL-NEW,,Whole Wheat Flour,1 kg,<category-uuid>,1101,500,false,false,9900,11000
```

Use the category IDs and configured GST values from your local environment. Import creation supplies `mediaId`, `storeId` and `dryRun`; poll its job/report for validation, approval and completion. A dry run changes no catalog data. The same file/store/mode returns the existing job, while a dry run and real run are distinct operations.

Store inventory APIs require current staff assignment; stock-changing requests require `Idempotency-Key`. Stock quantities are integer variant units serialized as decimal strings. See [domain rules](docs/DOMAIN.md), [stock decisions](docs/DECISIONS/0006-stock-units-reservations-and-expiry.md) and the [runbook](docs/RUNBOOK.md) before changing allocation, expiry or approval behavior.

## Subscriptions, support and compliance

Seeds include a subscribable variant and morning delivery slots. A SUPER_ADMIN must enable `wallet_enabled` before `subscriptions_enabled` through the feature-flag API. Fund the customer wallet, select an owned serviceable address, and create a subscription under `/v1/customer/subscriptions` with an idempotency key. Scheduled orders use ordinary checkout prices, fees and minimums. Changes return their effective IST date; picking and dispatch wait for the delivery slot's configured lead time.

Customer and rider tickets, delivered-order ratings and administrative payout records use the existing order, refund and earnings contracts. Positive manual settlements require a payment reference and private evidence; the backend does not initiate bank transfers. Admin reports run as private asynchronous CSV exports. Personal export and erasure workflows enforce current ownership, legal holds and outstanding obligations. [API conventions](docs/API.md) and [operational procedures](docs/RUNBOOK.md) describe these surfaces and their recovery paths.

## Verification

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:int
pnpm test:conc
pnpm test:e2e
pnpm test:migrations
pnpm build
pnpm openapi:export
pnpm audit:dependencies
# Optional explicit local S3-emulator contract; endpoint must be loopback.
TEST_S3_ENDPOINT=http://127.0.0.1:4566 pnpm test:storage
```

Integration/concurrency tests use actual PostGIS and Redis via Testcontainers and isolate their databases/Redis keys. For existing **test-only** real services, set both `TEST_DATABASE_URL` and `TEST_REDIS_URL`; the PostgreSQL user needs `CREATEDB` and extension privileges. If neither is set, Docker containers are required. A missing service is a failure, not a skipped pass.

`pnpm test:coverage` runs all four test projects, including migration checks, and collects coverage. CI uses this single combined run. The final acceptance gate requires at least 85% line coverage independently in domain and application code, plus all required concurrency and API cases. See PROGRESS.md for actual results and remaining gaps; the presence of a script or CI workflow is not a successful CI run.

## Production configuration

Real providers are conditional on explicitly selected provider settings and credentials. Startup rejects fake/local production providers, placeholder requirements, local endpoints and Razorpay test keys. Workload IAM credentials should come from the runtime environment rather than committed access keys.

For a local Razorpay Standard Checkout test, configure test credentials and a separate webhook secret in the ignored `.env`, start the backend and worker, and run `pnpm checkout:razorpay`. Open `http://localhost:5173`, supply a customer access token and a serviceable address for an existing nonempty cart, then use Razorpay's test payment details. The page uses the backend's quote and payment attempts; it does not accept a browser-supplied amount. Payment confirmation can remain pending while the capture event is processed. The page is for development only and does not implement the customer mobile app.

Razorpay cannot send a live webhook to localhost. To validate provider webhook delivery, configure a test-mode Dashboard webhook at a reachable HTTPS URL ending in `/v1/customer/webhooks/payments/razorpay`, using the same separate webhook secret as the backend. The checkout callback verifies the payment server-side, but it does not prove that a provider webhook was delivered.

The owner creates cloud/provider resources. Cognito workforce provisioning depends on the documented [username/email-alias mode](docs/DECISIONS/0004-local-and-cognito-identity.md). Real provider contract tests and live-resource acceptance are recorded separately. No deployment or cloud resources are created by this repository's development quickstart.

Migrations are forward-only in production; `pnpm migrate:down` refuses production. Keep the migration account separate from the runtime account in deployed environments. Destructive schema evolution uses expand/contract changes, with upgrade tests on a populated previous schema.
