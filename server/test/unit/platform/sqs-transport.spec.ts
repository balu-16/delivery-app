import { jest } from '@jest/globals';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  SQS_LANES,
  SqsTransport,
  type SqsQueueUrls,
} from '../../../src/platform/queue/sqs-transport.js';

const urls = Object.fromEntries(
  SQS_LANES.map((lane) => [
    lane,
    `https://sqs.ap-southeast-2.amazonaws.com/123456789012/delivery-dev-${lane}`,
  ]),
) as SqsQueueUrls;
const pointer = { version: 1 as const, jobId: 'job_1', generation: 1 };

function setup() {
  const send = jest.fn<(command: unknown, options?: unknown) => Promise<unknown>>();
  const transport = new SqsTransport(
    { send } as unknown as SQSClient,
    urls,
    'ap-southeast-2',
    '123456789012',
  );
  return { send, transport };
}

test('rejects destinations outside the configured account and lane', () => {
  expect(
    () =>
      new SqsTransport(
        {} as SQSClient,
        {
          ...urls,
          outbox: 'https://sqs.ap-southeast-2.amazonaws.com/999999999999/delivery-dev-outbox',
        },
        'ap-southeast-2',
        '123456789012',
      ),
  ).toThrow('INVALID_SQS_CONFIGURATION');
});

test('requires every destination to match the selected queue prefix', () => {
  const prodUrls = Object.fromEntries(
    SQS_LANES.map((lane) => [
      lane,
      `https://sqs.ap-southeast-2.amazonaws.com/123456789012/delivery-prod-${lane}`,
    ]),
  ) as SqsQueueUrls;
  expect(
    () =>
      new SqsTransport(
        {} as SQSClient,
        prodUrls,
        'ap-southeast-2',
        '123456789012',
        'delivery-prod',
      ),
  ).not.toThrow();
  expect(
    () =>
      new SqsTransport({} as SQSClient, urls, 'ap-southeast-2', '123456789012', 'delivery-prod'),
  ).toThrow('INVALID_SQS_CONFIGURATION');
});

test('sends only a validated opaque pointer with a bounded delay', async () => {
  const { transport, send } = setup();
  send.mockResolvedValue({});
  await transport.send('outbox', pointer, 42);
  const command = send.mock.calls[0]?.[0];
  expect(command).toBeInstanceOf(SendMessageCommand);
  expect((command as SendMessageCommand).input).toEqual({
    QueueUrl: urls.outbox,
    MessageBody: JSON.stringify(pointer),
    DelaySeconds: 42,
  });
  await expect(transport.send('outbox', pointer, 901)).rejects.toThrow('INVALID_SQS_MESSAGE');
  await expect(
    transport.send('outbox', { ...pointer, privateData: 'secret' } as typeof pointer),
  ).rejects.toThrow('INVALID_SQS_MESSAGE');
  expect(send).toHaveBeenCalledTimes(1);
});

test('keeps valid messages in a batch with malformed messages and leaves poison messages unacknowledged', async () => {
  const { transport, send } = setup();
  send.mockResolvedValue({
    Messages: [
      { Body: 'invalid JSON', ReceiptHandle: 'bad', Attributes: { ApproximateReceiveCount: '1' } },
      {
        Body: JSON.stringify(pointer),
        ReceiptHandle: 'good',
        Attributes: { ApproximateReceiveCount: '2' },
      },
      {
        Body: JSON.stringify(pointer),
        ReceiptHandle: 'invalid-count',
        Attributes: { ApproximateReceiveCount: '0' },
      },
    ],
  });
  const signal = new AbortController().signal;
  await expect(transport.receive('payments', signal)).resolves.toEqual({
    messages: [{ pointer, receiptHandle: 'good', receiveCount: 2 }],
    malformedCount: 2,
  });
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ReceiveMessageCommand);
  expect(send.mock.calls[0]?.[1]).toEqual({ abortSignal: signal });
  expect(send).toHaveBeenCalledTimes(1);
});

test('acknowledges and extends visibility only with valid arguments', async () => {
  const { transport, send } = setup();
  send.mockResolvedValue({});
  await transport.extendVisibility('dispatch', 'receipt', 120);
  await transport.delete('dispatch', 'receipt');
  expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ChangeMessageVisibilityCommand);
  expect(send.mock.calls[1]?.[0]).toBeInstanceOf(DeleteMessageCommand);
  await expect(transport.extendVisibility('dispatch', 'receipt', 43201)).rejects.toThrow(
    'INVALID_SQS_VISIBILITY',
  );
  await expect(transport.delete('dispatch', '')).rejects.toThrow('INVALID_SQS_RECEIPT');
  expect(send).toHaveBeenCalledTimes(2);
});
