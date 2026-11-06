# Delivery platform backend

NestJS/Fastify backend for hyperlocal groceries and scheduled subscriptions, implemented from [the master specification](delivery-platform-agent-prompt.md). Current work covers P0–P4; [progress](docs/PROGRESS.md) records verified scope and remaining activation checks. Later commerce, fulfillment and subscription phases are planned.

Read [the implementation plan](docs/IMPLEMENTATION_PLAN.md), [current progress](docs/PROGRESS.md), and [edge-case register](docs/EDGE_CASES.md) before making changes.

## Local setup

Prerequisites: Node **26.13.0**, pnpm **12.18.0**, Docker with Compose, and a working Docker daemon for Testcontainers. Versions are pinned in `.nvmrc` and `package.json`.

```bash
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d --wait
pnpm migrate
pnpm seed
pnpm start:dev
```

Local provider switches in `.env.example` select local authentication, fake maps/payments/push, local storage and Mailpit SMTP. They require no real AWS, map, or payment credentials. Local KYC and catalog uploads work without S3 credentials. Payment and notification business workflows remain assigned to their later phases.

Services bind to loopback: PostgreSQL/PostGIS on 5432, Redis on 6379, LocalStack on 4566, SMTP on 1025, and Mailpit's inbox at [localhost:8025](http://localhost:8025). The application defaults to port 3000. Operational metrics require `Authorization: Bearer <METRICS_BEARER_TOKEN>` and return 404 when the token is unset. Do not put this token in client applications.

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

Authentication is email/password through Cognito in production. The backend verifies access tokens; customer `/auth/bootstrap` verifies an ID token. Customer and workforce pools are separate, as are app-client audiences.

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

The owner creates cloud/provider resources. Cognito workforce provisioning depends on the documented [username/email-alias mode](docs/DECISIONS/0004-local-and-cognito-identity.md). Real provider contract tests and live-resource acceptance are recorded separately. No deployment or cloud resources are created by this repository's development quickstart.

Migrations are forward-only in production; `pnpm migrate:down` refuses production. Keep the migration account separate from the runtime account in deployed environments. Destructive schema evolution uses expand/contract changes, with upgrade tests on a populated previous schema.
