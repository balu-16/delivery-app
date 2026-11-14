import type { SQSClient } from '@aws-sdk/client-sqs';
import {
  queueVerifiedCustomerGroup,
  SqsCustomerGroupSync,
} from '../../../src/modules/identity/infrastructure/customer-group-sync.js';
import type { VerifiedIdentity } from '../../../src/modules/identity/contracts/identity.js';

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
