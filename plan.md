# Delete Valkey during downtime and rebuild it on demand

## Current state and billing

On November 24, 2026, AWS confirmed deletion of `delivery-app` in Sydney and the absence of cache snapshots. The IAM user group is available for the rebuild. AWS also confirmed that `database-1` is `stopped` following a separate stop request, with automatic restart scheduled for December 1, 2026 at 13:52 IST.

AWS meters at least **100 MB** while a Valkey cache exists. Leave Valkey deleted until you’re ready to run the app again. Aurora compute charges stop while `database-1` is paused or stopped. Database storage, billable backups, and other AWS services can still incur charges. Aurora automatically starts a manually stopped cluster after seven days. [ElastiCache pricing](https://aws.amazon.com/elasticache/pricing/) · [Aurora auto-pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html) · [Aurora stop and start](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-cluster-stop-start.html)

## Shut down

1. Verify account `102364304362` and permission to **both delete and recreate** the cache before deleting it. CloudTrail shows that `AccountFullAccessRole` created the original cache. The configured default CLI profile successfully deleted it.
2. Gracefully stop any running API and workers. Recheck SQS depths and Valkey rider-erasure markers. Both checks were clear during inspection. If markers appear before shutdown, save only those markers in a private local file and restore them before restarting the app.
3. Delete only `delivery-app` in `ap-southeast-2`, omitting the final snapshot, and poll until AWS confirms removal. There are currently no Valkey snapshots. Keep Aurora disconnected and verify that `ServerlessDatabaseCapacity` remains at `0`. On a future shutdown with Aurora awake, close the final database session after Valkey deletion and allow the configured five-minute idle period. [ElastiCache deletion options](https://docs.aws.amazon.com/cli/latest/reference/elasticache/delete-serverless-cache.html)

## Rebuild when you need the app

Create one empty cache with the same name, region, public TLS connection type, and IAM user group. These settings preserve access from the local backend.

```bash
aws elasticache create-serverless-cache \
  --region ap-southeast-2 \
  --serverless-cache-name delivery-app \
  --engine valkey --major-engine-version 9 \
  --connection-type public --network-type ipv4 \
  --user-group-id default.iam-user-group \
  --snapshot-retention-limit 0
```

Wait for `available`. Set `CACHE_URL` in `server/.env` to the **new** writer endpoint and port using `rediss://`. Keep `CACHE_IAM_NAME=delivery-app`, `CACHE_IAM_USER=default.iam-user`, and `QUEUE_TRANSPORT=sqs`. Restore any saved erasure markers before starting the backend. [AWS public Valkey endpoint setup](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/serverless-public-endpoints-chapter.html)

## Verify the recovery

Run the existing Valkey sharded pub/sub and Socket.IO smoke checks and the SQS preflight. If `database-1` is `stopped`, run `aws rds start-db-cluster --db-cluster-identifier database-1 --region ap-southeast-2` and wait for `available` before starting the backend. If Aurora is auto-paused at 0 ACUs, the first database connection will wake it. [Aurora stop and start](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-cluster-stop-start.html)

Start the backend with `pnpm start:dev` from `server`. Confirm `/readyz` returns `200`, products load in the customer app, and the delivery partner app opens its application or status screen. Check worker logs for queue errors before calling the rebuild complete.
