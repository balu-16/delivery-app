# Local development with AWS resources

The application can use Cognito, IAM-authenticated Aurora and ElastiCache, and the existing development SQS queues. Configure these in an ignored `.env`; keep AWS credentials in the standard AWS credential chain. IAM tokens are generated in memory and should never be placed in an environment file.

Use `DATABASE_AUTH=iam` with a password-free `DATABASE_URL`, an AWS region, and a database user authorized for IAM login. The application obtains a new token for each database connection and validates TLS certificates. A serverless database resuming from auto-pause may need a larger `DB_ACQUIRE_TIMEOUT_MS`. Migration and seed scripts support IAM authentication. Run migrations with a separate owner connection and do not run them against an unreviewed database. Local fixture seeds remain prohibited in production; to seed the explicitly designated IAM development database with Cognito enabled requires `SEED_AWS_DEVELOPMENT_FIXTURES=deliveryapp`.

`READINESS_TIMEOUT_MS` controls the deadline for dependency probes. Set it high enough for cold IAM connections; the AWS development configuration uses 15000 ms.

Use `CACHE_AUTH=elasticache-iam`, `CACHE_URL=rediss://...`, `CACHE_IAM_NAME`, `CACHE_IAM_USER`, and `AWS_REGION` for an ElastiCache Serverless cache. Cache and realtime clients use TLS and refresh IAM credentials for reconnects. Socket.IO uses sharded pub/sub on the cache.

Set `QUEUE_TRANSPORT=sqs` and `AWS_ACCOUNT_ID` to use the eight `delivery-dev-*` work queues. Aurora stores the outbox, concern-job leases, retry state, and schedules; SQS carries opaque pointers. Apply migration 031 and grant the runtime database role `SELECT`, `INSERT`, and `UPDATE` on its two new tables before selecting SQS. This development configuration is rejected in production. SQS can redeliver messages, so handlers must retain their existing durable idempotency and ownership checks.

If old work must be preserved, stop producers and workers and inspect the BullMQ queues and schedules as described in [SQS setup](sqs-setup.md), then drain or transfer pending work. If old work can be ignored, switching leaves it unprocessed in the preserved Redis volume. When `QUEUE_TRANSPORT=bullmq`, `REDIS_URL` remains necessary for the old queue transport.

All four Cognito clients may use the same pool, but verified client IDs only select an audience: current database roles, token groups, store assignments, and resource checks still control access. See the identity module README for the shared-pool provisioning and provider-operation limitations. A new empty pool requires appropriately managed Cognito groups and authorized user assignments before workforce routes can be used.

Run `python3 scripts/setup-aws-profiles.py` to create the ignored `.aws/delivery-config` file. Set `AWS_CONFIG_FILE` to its absolute path, `AWS_PROFILE=delivery-runtime`, and `AWS_S3_PROFILE=delivery-s3` in the ignored `.env`. The two profiles use the existing `default` profile to obtain renewable, short-lived STS credentials, scoped respectively to runtime services and the configured S3 bucket prefixes. The SDK refreshes sessions when they expire; tokens are not written to the configuration. The underlying source identity retains its existing permissions. Use the separately authorized owner profile for migrations and grants.

Leave `S3_ENDPOINT` empty for AWS S3: the SDK selects the endpoint from `AWS_REGION`. A custom endpoint is only for an S3-compatible service and is forbidden in production.

The restricted session also permits sending, receiving, deleting, changing visibility, and reading attributes on the eight `delivery-dev-*` work queues in the configured account and region. It does not grant access to the dead-letter queues or queue administration. Failed concern jobs are listed and replayed from Aurora; old SQS dead-letter messages remain subject to their configured retention.
