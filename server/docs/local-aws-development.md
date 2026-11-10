# Local development with AWS resources

The application can use Cognito, IAM-authenticated Aurora and ElastiCache, and the existing development SQS queues. Configure these in an ignored `.env`; keep AWS credentials in the standard AWS credential chain. IAM tokens are generated in memory and should never be placed in an environment file.

Use `DATABASE_AUTH=iam` with a password-free `DATABASE_URL`, an AWS region, and a database user authorized for IAM login. The application obtains a new token for each database connection and validates TLS certificates. A serverless database resuming from auto-pause may need a larger `DB_ACQUIRE_TIMEOUT_MS`. Migration and seed scripts support IAM authentication. Run migrations with a separate owner connection and do not run them against an unreviewed database. Local fixture seeds remain prohibited in production; to seed the explicitly designated IAM development database with Cognito enabled requires `SEED_AWS_DEVELOPMENT_FIXTURES=deliveryapp`.

`READINESS_TIMEOUT_MS` controls the deadline for dependency probes. Set it high enough for cold IAM connections; the AWS development configuration uses 15000 ms.

Use `CACHE_AUTH=elasticache-iam`, `CACHE_URL=rediss://...`, `CACHE_IAM_NAME`, `CACHE_IAM_USER`, and `AWS_REGION` for an ElastiCache Serverless cache. Cache and realtime clients use TLS and refresh IAM credentials for reconnects. Socket.IO uses sharded pub/sub on the cache.

Set `QUEUE_TRANSPORT=sqs` and `AWS_ACCOUNT_ID` to use the eight `delivery-dev-*` work queues. Aurora stores the outbox, concern-job leases, retry state, and schedules; SQS carries opaque pointers. Apply migration 031 and grant the runtime database role `SELECT`, `INSERT`, and `UPDATE` on its two new tables before selecting SQS. Production requires `SQS_QUEUE_PREFIX` to name an explicitly provisioned, non-development set of eight queues; this setting does not create queues. SQS can redeliver messages, so handlers must retain their existing durable idempotency and ownership checks.

If old work must be preserved, stop producers and workers and inspect the BullMQ queues and schedules as described in [SQS setup](sqs-setup.md), then drain or transfer pending work. If old work can be ignored, switching leaves it unprocessed in the preserved Redis volume. When `QUEUE_TRANSPORT=bullmq`, `REDIS_URL` remains necessary for the old queue transport.

All four Cognito clients may use the same pool, but verified client IDs only select an audience: current database roles, token groups, store assignments, and resource checks still control access. See the identity module README for the shared-pool provisioning and provider-operation limitations. A new empty pool requires appropriately managed Cognito groups and authorized user assignments before workforce routes can be used.

Run `python3 scripts/setup-aws-profiles.py` to create the ignored `.aws/delivery-config` file. Set `AWS_CONFIG_FILE` to its absolute path, `AWS_PROFILE=delivery-runtime`, and `AWS_S3_PROFILE=delivery-s3` in the ignored `.env`. The two profiles use the existing `default` profile to obtain renewable, short-lived STS credentials, scoped respectively to runtime services and the configured S3 bucket prefixes. The SDK refreshes sessions when they expire; tokens are not written to the configuration. The underlying source identity retains its existing permissions. Use the separately authorized owner profile for migrations and grants.

Leave `S3_ENDPOINT` empty for AWS S3: the SDK selects the endpoint from `AWS_REGION`. A custom endpoint is only for an S3-compatible service and is forbidden in production.

For a disposable AWS authentication smoke, run `AWS_SMOKE_CREATE_USER=yes pnpm smoke:aws`; to include the rollback-only order flow, also set `AWS_SMOKE_ORDER=yes`. The smoke compiles the application with decorator metadata, creates and removes its own Cognito user, and rolls back its database transaction. It does not verify actual commit behavior. Never run the order smoke against unreviewed or production data.

For an isolated Aurora queue concurrency check, run `AWS_PROFILE=default AWS_P13_ISOLATED_DATABASE=yes node --env-file-if-exists=.env --import tsx scripts/aws-p13-queue-smoke.ts`. It creates a randomly named logical database in the configured development cluster, applies the queue-table migration there, and removes that database afterward. It does not send or receive SQS messages.

The other AWS-only P13 checks are:

- `AWS_PROFILE=default AWS_P13_ISOLATED_DATABASE=yes node --env-file-if-exists=.env --import tsx scripts/aws-p13-migration-smoke.ts` creates an isolated database, runs all migrations and PostGIS checks, and drops the database.
- `AWS_PROFILE=default AWS_P13_TEMP_QUEUES=yes node --env-file-if-exists=.env --import tsx scripts/aws-p13-sqs-smoke.ts` creates eight temporary work queues and eight dead-letter queues, tests delivery, retry and redrive, and deletes them. If deletion fails, its ignored `artifacts/p13-*-queues.json` records the URLs for cleanup.
- `AWS_P13_CACHE_SMOKE=yes node --env-file-if-exists=.env --import tsx scripts/aws-p13-cache-smoke.ts` checks automatic reconnect with a newly signed IAM token and an expiring test key. It does not wait for the timed token refresher.
- `AWS_P13_STORAGE_SMOKE=yes node --env-file-if-exists=.env --import tsx scripts/aws-p13-storage-smoke.ts` checks S3 upload, promotion, and reads using randomly named objects and deletes the test objects afterward.
- `AWS_PROFILE=default AWS_P13_INTEGRATION=yes node --env-file-if-exists=.env --import tsx scripts/aws-p13-sqs-relay-smoke.ts` uses an isolated Aurora database and temporary SQS queues to verify relay publication, acknowledgement and duplicate-safe consumption.
- For the route authentication sweep, compile with `pnpm exec tsc -p tsconfig.json --outDir artifacts/p13-sweep-build --sourceMap false`, then run `AWS_PROFILE=default AWS_P13_AUTH_SWEEP=yes node --env-file-if-exists=.env artifacts/p13-sweep-build/scripts/aws-p13-auth-sweep.js`. The compiled entry point preserves Nest dependency metadata; the sweep checks missing credentials only.

These checks use the existing AWS services and can incur request and compute costs. They do not establish the full P13 security or load gate.

Selected database-only Jest integration suites can use AWS instead of containers. For example, run `AWS_PROFILE=default AWS_P13_INTEGRATION=yes node --env-file-if-exists=.env --experimental-vm-modules node_modules/jest/bin/jest.js --selectProjects integration --runInBand --testPathPatterns sqs-concern-store.spec.ts`. The fixture creates and drops a separate logical database and uses a unique Valkey key prefix; its IAM connection URLs are short-lived and must not be logged. This opt-in does not make every existing suite AWS-compatible: suites that start legacy BullMQ workers or ordinary Redis pub/sub require separate adaptation before use against ElastiCache Serverless.

Before creating the database, the fixture writes an ignored `artifacts/delivery_p13_*-cleanup.json` manifest and removes it after successful cleanup. If a run is interrupted or cleanup fails, inspect the manifest and verify the named resources before removing only those test resources.

The restricted session also permits sending, receiving, deleting, changing visibility, and reading attributes on the eight work queues for the selected prefix (default `delivery-dev`) in the configured account and region. It does not grant access to the dead-letter queues or queue administration. Failed concern jobs are listed and replayed from Aurora; old SQS dead-letter messages remain subject to their configured retention.
