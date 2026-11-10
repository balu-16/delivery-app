import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

export const SQS_LANES = [
  'platform-events',
  'outbox',
  'notifications',
  'dispatch',
  'payments',
  'subscriptions',
  'imports',
  'maintenance',
] as const;
export type SqsLane = (typeof SQS_LANES)[number];
export type SqsQueueUrls = Record<SqsLane, string>;

/** Validate every queue before constructing a client; URLs never contain credentials. */
export function validateSqsQueueUrls(
  input: SqsQueueUrls,
  region: string,
  account: string,
  prefix = 'delivery-dev',
): void {
  if (!/^[0-9]{12}$/.test(account) || !/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/.test(region))
    throw new Error('INVALID_SQS_CONFIGURATION');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(prefix)) throw new Error('INVALID_SQS_CONFIGURATION');
  for (const lane of SQS_LANES) {
    let url: URL;
    try {
      url = new URL(input[lane]);
    } catch {
      throw new Error('INVALID_SQS_CONFIGURATION');
    }
    if (
      url.protocol !== 'https:' ||
      url.hostname !== `sqs.${region}.amazonaws.com` ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/${account}/${prefix}-${lane}`
    )
      throw new Error('INVALID_SQS_CONFIGURATION');
  }
}

export interface SqsJobPointer {
  version: 1;
  jobId: string;
  generation: number;
}
export interface SqsReceivedPointer {
  pointer: SqsJobPointer;
  receiptHandle: string;
  receiveCount: number;
}
export interface SqsReceiveResult {
  messages: SqsReceivedPointer[];
  /** Malformed messages are left unacknowledged so SQS can redrive them. */
  malformedCount: number;
}

function validPointer(value: unknown): value is SqsJobPointer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  return (
    Object.keys(object).length === 3 &&
    object.version === 1 &&
    typeof object.jobId === 'string' &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(object.jobId) &&
    Number.isSafeInteger(object.generation) &&
    (object.generation as number) >= 1
  );
}

/** SQS only transports opaque pointers; callers own persistence, leases and retry policy. */
export class SqsTransport {
  constructor(
    private readonly client: SQSClient,
    private readonly urls: SqsQueueUrls,
    region: string,
    account: string,
    prefix = 'delivery-dev',
  ) {
    validateSqsQueueUrls(urls, region, account, prefix);
  }
  async send(lane: SqsLane, pointer: SqsJobPointer, delaySeconds = 0): Promise<void> {
    if (
      !SQS_LANES.includes(lane) ||
      !validPointer(pointer) ||
      !Number.isInteger(delaySeconds) ||
      delaySeconds < 0 ||
      delaySeconds > 900
    )
      throw new Error('INVALID_SQS_MESSAGE');
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.urls[lane],
        MessageBody: JSON.stringify(pointer),
        DelaySeconds: delaySeconds,
      }),
    );
  }
  async receive(
    lane: SqsLane,
    abortSignal?: AbortSignal,
    maxMessages = 10,
  ): Promise<SqsReceiveResult> {
    if (!SQS_LANES.includes(lane)) throw new Error('INVALID_SQS_LANE');
    if (!Number.isSafeInteger(maxMessages) || maxMessages < 1 || maxMessages > 10)
      throw new Error('INVALID_SQS_BATCH_SIZE');
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.urls[lane],
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: 20,
        VisibilityTimeout: 120,
        MessageSystemAttributeNames: ['ApproximateReceiveCount'],
      }),
      { abortSignal },
    );
    const result: SqsReceiveResult = { messages: [], malformedCount: 0 };
    for (const message of response.Messages ?? []) {
      let pointer: unknown;
      try {
        pointer = JSON.parse(message.Body ?? '');
      } catch {
        result.malformedCount++;
        continue;
      }
      const receiveCount = Number(message.Attributes?.ApproximateReceiveCount);
      if (
        !validPointer(pointer) ||
        !message.ReceiptHandle ||
        !Number.isSafeInteger(receiveCount) ||
        receiveCount < 1
      ) {
        result.malformedCount++;
        continue;
      }
      result.messages.push({ pointer, receiptHandle: message.ReceiptHandle, receiveCount });
    }
    return result;
  }
  async delete(lane: SqsLane, receiptHandle: string): Promise<void> {
    if (!SQS_LANES.includes(lane) || !receiptHandle) throw new Error('INVALID_SQS_RECEIPT');
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.urls[lane], ReceiptHandle: receiptHandle }),
    );
  }
  async extendVisibility(lane: SqsLane, receiptHandle: string, seconds: number): Promise<void> {
    if (
      !SQS_LANES.includes(lane) ||
      !receiptHandle ||
      !Number.isInteger(seconds) ||
      seconds < 0 ||
      seconds > 43200
    )
      throw new Error('INVALID_SQS_VISIBILITY');
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.urls[lane],
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
  async ping(lane: SqsLane): Promise<void> {
    if (!SQS_LANES.includes(lane)) throw new Error('INVALID_SQS_LANE');
    await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: this.urls[lane], AttributeNames: ['QueueArn'] }),
    );
  }

  async counts(lane: SqsLane): Promise<{ waiting: number; active: number; delayed: number }> {
    if (!SQS_LANES.includes(lane)) throw new Error('INVALID_SQS_LANE');
    const result = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.urls[lane],
        AttributeNames: [
          'ApproximateNumberOfMessages',
          'ApproximateNumberOfMessagesNotVisible',
          'ApproximateNumberOfMessagesDelayed',
        ],
      }),
    );
    return {
      waiting: Number(result.Attributes?.ApproximateNumberOfMessages ?? 0),
      active: Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0),
      delayed: Number(result.Attributes?.ApproximateNumberOfMessagesDelayed ?? 0),
    };
  }
}
