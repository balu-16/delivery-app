import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { VerifiedIdentity } from '../contracts/identity.js';

export interface CustomerGroupSync {
  enqueue(subject: string): Promise<void>;
}

/** Grouping is informational and must never change the result of customer bootstrap. */
export async function queueVerifiedCustomerGroup(
  identity: VerifiedIdentity,
  sync: CustomerGroupSync | undefined,
  onError: () => void,
): Promise<void> {
  if (identity.pool !== 'CUSTOMER' || identity.emailVerified !== true || !sync) return;
  try {
    await sync.enqueue(identity.sub);
  } catch {
    onError();
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
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ version: 1, userPoolId: this.userPoolId, subject }),
      }),
      { abortSignal: AbortSignal.timeout(2000) },
    );
  }
}
