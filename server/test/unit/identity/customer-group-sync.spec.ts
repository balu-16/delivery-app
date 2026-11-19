import type { SQSClient } from '@aws-sdk/client-sqs';
import { jest } from '@jest/globals';
import {
  queueVerifiedCustomerGroup,
  SqsCustomerGroupSync,
} from '../../../src/modules/identity/infrastructure/customer-group-sync.js';
import type { VerifiedIdentity } from '../../../src/modules/identity/contracts/identity.js';

afterEach(() => jest.useRealTimers());

test('customer group queue contains only the pool and stable subject', async () => {
  const inputs: unknown[] = [];
  const client = {
    send: async (command: { input: unknown }) => {
      inputs.push(command.input);
    },
  } as unknown as SQSClient;
  const sync = new SqsCustomerGroupSync(client, 'https://queue.example', 'pool');
  await sync.enqueue('00000000-1111-2222-3333-444444444444');
  expect(inputs).toEqual([
    {
      QueueUrl: 'https://queue.example',
      MessageBody: JSON.stringify({
        version: 1,
        userPoolId: 'pool',
        subject: '00000000-1111-2222-3333-444444444444',
      }),
    },
  ]);
  await expect(sync.enqueue('not a subject!')).rejects.toThrow('INVALID_CUSTOMER_SUBJECT');
  expect(inputs).toHaveLength(1);
});

test('only verified customer identities enqueue and an unavailable queue does not block sign-in', async () => {
  const identity: VerifiedIdentity = {
    pool: 'CUSTOMER',
    sub: 'subject',
    tokenUse: 'id',
    groups: [],
    emailVerified: true,
    expiresAt: 9999999999,
  };
  let attempts = 0;
  let failures = 0;
  const sync = {
    enqueue: async () => {
      attempts++;
      throw new Error('queue unavailable');
    },
  };
  await queueVerifiedCustomerGroup({ ...identity, emailVerified: false }, sync, () => {
    failures++;
  });
  await queueVerifiedCustomerGroup({ ...identity, pool: 'WORKFORCE' }, sync, () => {
    failures++;
  });
  expect(attempts).toBe(0);
  await expect(
    queueVerifiedCustomerGroup(identity, sync, () => {
      failures++;
    }),
  ).resolves.toBeUndefined();
  expect(attempts).toBe(1);
  expect(failures).toBe(1);
});

test('credential loading longer than two seconds can complete the queue send', async () => {
  jest.useFakeTimers();
  let signal: AbortSignal | undefined;
  const client = {
    send: (_command: unknown, options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return new Promise<void>((resolve) => setTimeout(resolve, 5_400));
    },
  } as unknown as SQSClient;
  const pending = new SqsCustomerGroupSync(client, 'https://queue.example', 'pool').enqueue(
    'subject',
  );
  await jest.advanceTimersByTimeAsync(5_400);
  await expect(pending).resolves.toBeUndefined();
  expect(signal?.aborted).toBe(false);
  expect(jest.getTimerCount()).toBe(0);
});

test('a stalled credential provider is bounded and its late failure is handled', async () => {
  jest.useFakeTimers();
  let signal: AbortSignal | undefined;
  const client = {
    send: (_command: unknown, options: { abortSignal: AbortSignal }) => {
      signal = options.abortSignal;
      return new Promise<void>((_resolve, reject) =>
        setTimeout(() => reject(new Error('late failure')), 20_000),
      );
    },
  } as unknown as SQSClient;
  const pending = new SqsCustomerGroupSync(client, 'https://queue.example', 'pool').enqueue(
    'subject',
  );
  const rejected = expect(pending).rejects.toThrow('CUSTOMER_GROUP_ENQUEUE_TIMEOUT');
  await jest.advanceTimersByTimeAsync(15_000);
  await rejected;
  expect(signal?.aborted).toBe(true);
  await jest.advanceTimersByTimeAsync(5_000);
  expect(jest.getTimerCount()).toBe(0);
});

test.each([
  ['AbortError', 'TIMEOUT'],
  ['TimeoutError', 'TIMEOUT'],
  ['CredentialsProviderError', 'CREDENTIALS_UNAVAILABLE'],
  ['AccessDeniedException', 'ACCESS_DENIED'],
  ['QueueDoesNotExist', 'QUEUE_UNAVAILABLE'],
  ['UnexpectedSdkError', 'OTHER'],
] as const)('logs only an allowlisted reason for %s', async (name, expected) => {
  const identity: VerifiedIdentity = {
    pool: 'CUSTOMER',
    sub: 'private-subject',
    tokenUse: 'id',
    groups: [],
    emailVerified: true,
    expiresAt: 9999999999,
  };
  const failure = new Error('private message and queue URL');
  failure.name = name;
  const reasons: string[] = [];
  await expect(
    queueVerifiedCustomerGroup(
      identity,
      {
        enqueue: async () => {
          throw failure;
        },
      },
      (reason) => {
        reasons.push(reason);
      },
    ),
  ).resolves.toBeUndefined();
  expect(reasons).toEqual([expected]);
});
