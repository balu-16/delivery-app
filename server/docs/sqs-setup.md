# Delivery development SQS setup

Create the following eight **Standard** work queues in account `102364304362`, region `ap-southeast-2`. Create a matching Standard dead-letter queue for each name by appending `-dlq`.

```text
delivery-dev-platform-events
delivery-dev-outbox
delivery-dev-notifications
delivery-dev-dispatch
delivery-dev-payments
delivery-dev-subscriptions
delivery-dev-imports
delivery-dev-maintenance
```

Use SQS-managed server-side encryption on all 16 queues. For each work queue, set visibility timeout to 120 seconds, receive wait time to 20 seconds, retention to four days, delivery delay to zero, and configure its matching dead-letter queue with a maximum receive count of five. Set dead-letter retention to 14 days and its redrive allow policy to `byQueue`, containing only its matching work queue ARN.

After creating the queues, run `python3 scripts/sqs-preflight.py` using the existing AWS `default` profile. It only reads queue configuration and does not consume messages or create resources. Passing this check does not mean the SQS application integration is complete.

The AWS Valkey connection and Socket.IO sharded fan-out can be checked independently using `scripts/aws-valkey-sharded-smoke.ts` and `scripts/aws-valkey-socket-smoke.ts` with the ignored `.env`. They use transient, randomly named pub/sub channels and create no cache keys. These checks do not switch the application's runtime to the new adapter.

Do not remove the existing local Redis queue or its data until its waiting, active, delayed, failed, and scheduled work has been inspected and handled during the cutover.

With the existing local Redis instance running, inspect the production-named development queues without starting a worker or removing any data:

```sh
node --env-file-if-exists=.env --import tsx scripts/inspect-local-queue-backlog.ts
```

The command accepts only a local `REDIS_URL` and reads counts without printing job contents. It includes paused, prioritized and waiting-children work, as well as repeat schedulers. Counts are a point-in-time snapshot: stop producers and workers and repeat the inventory before cutover. Treat any outstanding work and schedulers as requiring an explicit transfer or drain; an unreachable Redis instance is not an empty queue.
