import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { VerifiedIdentity } from '../contracts/identity.js';

export interface CustomerGroupSync {
  enqueue(subject: string): Promise<void>;
}

export type CustomerGroupSyncFailure =
  | 'TIMEOUT'
  | 'CREDENTIALS_UNAVAILABLE'
  | 'ACCESS_DENIED'
  | 'QUEUE_UNAVAILABLE'
  | 'INVALID_SUBJECT'
  | 'OTHER';

const ENQUEUE_TIMEOUT_MS = 15_000;

/** Do not put SDK error messages, queue URLs, or customer identifiers in logs. */
function failureReason(error: unknown): CustomerGroupSyncFailure {
  if (!(error instanceof Error)) return 'OTHER';
  if (
    error.message === 'CUSTOMER_GROUP_ENQUEUE_TIMEOUT' ||
    error.name === 'AbortError' ||
    error.name === 'TimeoutError'
  )
    return 'TIMEOUT';
  if (error.message === 'INVALID_CUSTOMER_SUBJECT') return 'INVALID_SUBJECT';
  if (error.name === 'CredentialsProviderError' || error.name === 'ExpiredTokenException')
    return 'CREDENTIALS_UNAVAILABLE';
  if (error.name === 'AccessDeniedException' || error.name === 'AccessDenied')
    return 'ACCESS_DENIED';
  if (
    error.name === 'QueueDoesNotExist' ||
    error.name === 'AWS.SimpleQueueService.NonExistentQueue'
  )
    return 'QUEUE_UNAVAILABLE';
  return 'OTHER';
}

/** Grouping is informational and must never change the result of customer bootstrap. */
export async function queueVerifiedCustomerGroup(
  identity: VerifiedIdentity,
  sync: CustomerGroupSync | undefined,
  onError: (reason: CustomerGroupSyncFailure) => void,
): Promise<void> {
  if (identity.pool !== 'CUSTOMER' || identity.emailVerified !== true || !sync) return;
  try {
    await sync.enqueue(identity.sub);
  } catch (error) {
    onError(failureReason(error));
  }
}

/** A separate queue prevents group bookkeeping from delaying workforce identity operations. */
export class SqsCustomerGroupSync implements CustomerGroupSync {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly userPoolId: string,
  ) {}

  async enqueue(subject: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(subject)) throw new Error('INVALID_CUSTOMER_SUBJECT');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error('CUSTOMER_GROUP_ENQUEUE_TIMEOUT'));
        controller.abort();
      }, ENQUEUE_TIMEOUT_MS);
    });
    try {
      // The SDK can wait for credentials before the HTTP handler observes an
      // abort. Race the entire send so credential refresh is bounded too.
      await Promise.race([
        this.client.send(
          new SendMessageCommand({
            QueueUrl: this.queueUrl,
            MessageBody: JSON.stringify({ version: 1, userPoolId: this.userPoolId, subject }),
          }),
          { abortSignal: controller.signal },
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
