# Customer and rider Cognito group synchronization

This automation assigns confirmed customers and rider applicants to their respective Cognito groups. Protected APIs require exactly one matching application group in the access token and the corresponding active database role. Rider delivery operations additionally require an approved application. The customer and rider apps currently share a pool but use different app clients.

The post-confirmation handler accepts `PostConfirmation_ConfirmSignUp` events from the configured customer or rider client, for the configured pool, with a verified email. It sends the pool ID, subject and, for riders, role to a dedicated encrypted SQS queue. The worker checks the current Cognito status, verified email and existing application groups before assigning `CUSTOMER` or `RIDER`; conflicting groups are rejected and duplicate messages are safe. It cannot grant privileged roles. A dead-letter queue and CloudWatch alarms surface failures. A missed enqueue is logged with the Cognito subject and role; customer bootstrap retries through the queue and rider bootstrap creates a role-sync operation. Restrict access to those logs. A user may appear temporarily in Cognito Users without a group, but protected API access is unavailable until grouping completes and the token is refreshed.

If an affected user never signs in after a missed enqueue, an authorized operator can replay the logged subject to the queue after resolving the outage: `{ "version": 1, "userPoolId": "<configured pool ID>", "subject": "<logged subject>" }` for a customer, or `{ "version": 2, "userPoolId": "<configured pool ID>", "subject": "<logged subject>", "role": "RIDER" }` for a rider. Replay only the role recorded in the failure log.

## Prerequisites and safeguards

1. The deployment identity and Lambda execution roles must be permitted to use the required Cognito, Lambda, SQS, IAM, CloudWatch and CloudFormation actions. Verify actual access and do not bypass any organization controls.
2. With the permitted identity, inspect the existing pool and its `LambdaConfig.PostConfirmation` and check whether a `CUSTOMER` group already exists. Stop if those checks are denied. Set `CreateCustomerGroup=false` when the group already exists; otherwise the stack creates it.
3. A pool has one post-confirmation trigger. If one already exists, preserve its behavior and have its owner integrate the enqueue logic from `trigger.mjs`; do not replace it. If there is no trigger, attach the stack's trigger only after confirming all existing pool configuration. Do not use a partial `UpdateUserPool` request, which can reset omitted settings.
4. Use a deployment bucket controlled by the same account. Lambda uses the Node.js 24 runtime's included AWS SDK. The code archive contains only `trigger.mjs` and `worker.mjs`; it must not include `.env`, credentials or the server application.

## Deploy after access is granted

Run `node --test infra/customer-group/handlers.test.mjs` from `server`, then validate `infra/customer-group/template.yaml` with CloudFormation. Package the two handler files into a zip at the archive root, upload it to the deployment bucket, and deploy the template with the shared pool ID, distinct customer and rider app-client IDs, bucket, object key and `CAPABILITY_IAM`. The `RIDER` group must exist before enabling rider synchronization. Set `AlertTopicArn` to an existing operations SNS topic if alarm notifications are required; without it alarms remain visible in CloudWatch only. `CustomerGroup` is retained if the stack is deleted.

For example, from `server`, with the intended AWS profile selected and the four values set for that environment:

```sh
aws sts get-caller-identity
aws cognito-idp describe-user-pool --region "$AWS_REGION" --user-pool-id "$CUSTOMER_POOL_ID" --query 'UserPool.LambdaConfig.PostConfirmation'
aws cognito-idp get-group --region "$AWS_REGION" --user-pool-id "$CUSTOMER_POOL_ID" --group-name CUSTOMER
```

The second command must succeed. For the third, distinguish an existing group from a `ResourceNotFoundException`; an access-denied or other error is not evidence that it is absent. If the group exists, set `CreateCustomerGroup=false`. If a trigger already exists, follow the integration rule above before changing the pool. Then, once those checks pass:

```sh
zip -j /tmp/dairydirect-customer-group.zip infra/customer-group/trigger.mjs infra/customer-group/worker.mjs
aws s3 cp /tmp/dairydirect-customer-group.zip "s3://${DEPLOYMENT_BUCKET}/customer-group/handlers.zip"
aws cloudformation deploy --region "$AWS_REGION" --stack-name dairydirect-customer-group \
  --template-file infra/customer-group/template.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides "CustomerPoolId=$CUSTOMER_POOL_ID" "CustomerClientId=$CUSTOMER_CLIENT_ID" "RiderClientId=$RIDER_CLIENT_ID" \
    "CodeBucket=$DEPLOYMENT_BUCKET" "CodeKey=customer-group/handlers.zip" "CreateCustomerGroup=false"
aws cloudformation describe-stacks --region "$AWS_REGION" --stack-name dairydirect-customer-group --query 'Stacks[0].Outputs'
```

After inspecting the existing trigger as above, attach or integrate it and verify confirmed customer and rider test accounts enter only their respective group. Never test with another person's credentials. Set `CUSTOMER_GROUP_SYNC_QUEUE_URL` to the stack's `QueueUrl` output in the customer API environment and attach `BackendQueueSendPolicyArn` to its runtime identity. Run the identity worker with permission to manage rider group membership. A failed queue submission is logged as `CUSTOMER_GROUP_ENQUEUE_FAILED`; grouping is required before protected actions can succeed.

The template alarms on the trigger log group and dead-letter queue. Set `BackendLogGroupName` to the existing customer API CloudWatch log group to include bootstrap fallback failures in the same alarm. Leave it empty only when the customer API logs are monitored separately. After deployment, confirm that the metric filter exists for the API group and that a test failure reaches the alarm.

To backfill only verified, active users that already have a database customer role and profile, run the following with the configured customer API environment and a role permitted to send to the group queue:

```sh
cd server
pnpm dlx node@26.13.0 --env-file=.env scripts/customer-group-backfill.mjs --execute
```

The backfill submits opaque subjects, not email addresses. It can be rerun after a failure; the worker rechecks each user in Cognito and group assignment is idempotent. Do not backfill every confirmed account in the pool: workforce users also live there. Review the queue and dead-letter alarms, and retain normal restricted access to operational logs.
