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

Inventory maintains held reservations, batches, immutable stock ledger and shortage obligations. Payment-confirmed reservations do not expire with payment holds. Quarantine/expiry may leave physical allocated stock with an explicit shortage obligation; do not free confirmed allocations or alter ledger rows by hand. Future P6/P7 integration must resolve the corresponding order/payment/fulfillment consequences.

Production migration rollback uses a reviewed forward migration. Development `migrate:down` is destructive and refuses `NODE_ENV=production`. No deployment, production database or cloud resources have been created by these local checks. Hosted CI, an actual container build and owner-credentialed AWS/CDN/Cognito/Ola activation are separately recorded in [PROGRESS.md](PROGRESS.md).
