import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';

export function createHandler({
  client,
  queueUrl,
  poolId,
  customerClientId,
  riderClientId,
  reportFailure,
}) {
  return async (event) => {
    const attributes = event?.request?.userAttributes;
    if (
      event?.triggerSource !== 'PostConfirmation_ConfirmSignUp' ||
      event?.userPoolId !== poolId ||
      attributes?.email_verified !== 'true'
    )
      return event;
    const clientId = event?.callerContext?.clientId;
    if (
      typeof clientId !== 'string' ||
      !clientId ||
      (riderClientId && riderClientId === customerClientId)
    )
      return event;
    const role =
      customerClientId && clientId === customerClientId
        ? 'CUSTOMER'
        : riderClientId && clientId === riderClientId
          ? 'RIDER'
          : null;
    if (!role) return event;
    const subject = attributes.sub;
    if (typeof subject !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(subject)) {
      reportFailure(undefined, role);
      return event;
    }
    try {
      await client.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody:
            role === 'CUSTOMER'
              ? JSON.stringify({ version: 1, userPoolId: poolId, subject })
              : JSON.stringify({ version: 2, userPoolId: poolId, subject, role }),
        }),
        { abortSignal: globalThis.AbortSignal.timeout(1500) },
      );
    } catch {
      // Confirmation already happened. Keep signup usable and surface the missed enqueue.
      // A later successful bootstrap queues another assignment attempt.
      reportFailure(subject, role);
    }
    return event;
  };
}

let handlerInstance;
export const handler = async (event) => {
  handlerInstance ??= createHandler({
    client: new SQSClient({ maxAttempts: 1 }),
    queueUrl: process.env.QUEUE_URL,
    poolId: process.env.CUSTOMER_POOL_ID,
    customerClientId: process.env.CUSTOMER_CLIENT_ID,
    riderClientId: process.env.RIDER_CLIENT_ID,
    reportFailure: (subject, role) =>
      console.error(
        JSON.stringify({
          event: 'CUSTOMER_GROUP_ENQUEUE_FAILED',
          ...(subject ? { subject } : {}),
          ...(role ? { role } : {}),
        }),
      ),
  });
  return handlerInstance(event);
};
